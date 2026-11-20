import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { DemoReservationError, priceDemoRequest } from '../demo-model.js';
export { DemoReservationError } from '../demo-model.js';

export const reservationInput = z.object({
  gpuType: z.literal('H100').describe('The demo supports H100 only. Ask rather than substituting for another GPU.'),
  gpuCount: z.number().int().min(1).max(8).describe('Number of GPUs used together.'),
  gpuHours: z.number().int().min(1).max(10000).describe('Total GPU-hours across all GPUs. Example: 2 GPUs for 50 hours is 100 GPU-hours.'),
  usageStartsAt: z.iso.datetime({ offset: true }).max(40).describe('Start of the usage window, with an explicit UTC offset or Z. Confirm the user’s timezone.'),
  usageEndsAt: z.iso.datetime({ offset: true }).max(40).describe('End of the usage window, with an explicit UTC offset or Z.'),
  region: z.string().trim().min(2).max(80).refine(value => !/[\x00-\x1f\x7f]/.test(value)).describe('User’s preferred region. This is a demo preference, not verified provider availability.'),
  maxUpfrontUsd: z.number().min(0).max(1000000).optional().describe('Optional maximum upfront payment in USD. Do not increase the user’s budget without asking.'),
  maxTotalIfUsedUsd: z.number().min(0).max(1000000).optional().describe('Optional maximum total cost including protection and compute in USD, excluding taxes or other charges.'),
}).strict();

export function createDemoReservations({ secret, now = Date.now }) {
  const lifetime = 15 * 60 * 1000;
  const disclaimer = 'DEMO ONLY. No payment is charged, no supplier capacity is held, and no real reservation is created.';
  const sign = payload => createHmac('sha256', secret).update('dodona-demo-quote-v1:' + payload).digest('hex');

  function quote(raw) {
    const parsed = reservationInput.safeParse(raw);
    if (!parsed.success) throw new DemoReservationError('INVALID_DETAILS', 'Check GPU type, count, total GPU-hours, region, and timezone-qualified usage dates.');
    const request = parsed.data;
    const prices = priceDemoRequest(request, now());
    const issuedAt = now();
    const quoteId = 'DEMO-Q-' + createHash('sha256').update(JSON.stringify({ request, issuedAt })).digest('hex').slice(0, 20);
    const details = {
      version: 1, mode: 'demo', quoteId, request, prices, issuedAt,
      expiresAt: new Date(issuedAt + lifetime).toISOString(),
      accessRequestDeadline: request.usageStartsAt,
      terms: {
        expiry: 'Unused protection expires at the access deadline, and the upfront protection payment is not refunded.',
        resale: 'Requires a willing buyer; a transaction fee applies on completion. No guaranteed resale price.',
        buyback: 'Requires committed supplier funding, using current value less a disclosed deduction. A quote is not guaranteed.',
        capacity: 'This demo has no committed supplier capacity. Provider, access, and failure terms must be agreed before real bookings.',
      },
      disclaimer,
    };
    const payload = Buffer.from(JSON.stringify(details)).toString('base64url');
    return { ...details, quoteToken: payload + '.' + sign(payload), nextStep: 'Show the GPU details, usage window and timezone, region, upfront payment, payment if used, terms, and demo disclaimer. Ask the user to confirm before calling confirm_demo_reservation.' };
  }

  function confirm({ quoteToken, userConfirmed }) {
    if (userConfirmed !== true) throw new DemoReservationError('CONFIRMATION_REQUIRED', 'The user must confirm the displayed demo quote and terms first.');
    if (typeof quoteToken !== 'string' || quoteToken.length > 3500) throw new DemoReservationError('INVALID_QUOTE', 'Use the complete quote token returned by quote_demo_reservation.');
    const [payload, signature, extra] = quoteToken.split('.');
    if (extra || !/^[A-Za-z0-9_-]+$/.test(payload || '') || !/^[a-f0-9]{64}$/.test(signature || '') ||
      !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(sign(payload), 'hex'))) {
      throw new DemoReservationError('INVALID_QUOTE', 'The quote token was changed or is invalid. Request a new quote.');
    }
    let details;
    try { details = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
    catch { throw new DemoReservationError('INVALID_QUOTE', 'Request a new quote.'); }
    if (details.mode !== 'demo' || details.version !== 1 || !Number.isFinite(details.issuedAt) ||
      details.issuedAt > now() || now() >= details.issuedAt + lifetime || Date.parse(details.request.usageStartsAt) <= now()) {
      throw new DemoReservationError('QUOTE_EXPIRED', 'The demo quote expired or its usage window has started. Request a new quote and ask for confirmation again.');
    }
    const { version, issuedAt, ...receipt } = details;
    return {
      ...receipt,
      receiptId: 'DEMO-R-' + createHash('sha256').update(quoteToken).digest('hex').slice(0, 20),
      status: 'simulated', paymentCharged: false, capacityHeld: false, realReservationCreated: false,
      persisted: false, quoteIssuedAt: new Date(issuedAt).toISOString(),
      confirmationNote: 'This is a repeatable demo receipt, not a stored booking or proof of payment.',
      disclaimer,
    };
  }
  return { quote, confirm };
}

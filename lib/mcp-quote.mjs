/** MCP tool quote_cap: prices a GPU-hour price cap, floor or fixed-price lock with the v0 engine. Demo quotes only. */
import { z } from 'zod';
import { getPriceHistory } from './prices.mjs';
import { quoteFromHistory } from './pricing.mjs';
import { REGION_FACTORS, CONFIG_FACTORS } from './valuation.mjs';

const GPUS = ['H100', 'H200', 'B200', 'A100', 'RTX 5090'];
const DISCLAIMER = 'Demo quote only. No payment, capacity hold or booking is created. Index: Ornn daily index, demonstration only; not licensed for commercial valuation.';

export const quoteCapInput = z.object({
  gpu: z.enum(GPUS),
  count: z.number().int().describe('GPUs in the block: 1, 2, 4, 8, 16, 32, 64, 128 or 256.'),
  start: z.string().max(40).describe('Window start, ISO 8601 with a zone, at least 48 hours ahead, e.g. 2026-11-02T09:00:00Z.'),
  end: z.string().max(40).describe('Window end, ISO 8601 with a zone, at least 4 hours after the start.'),
  type: z.enum(['call', 'lock', 'put']).default('call').describe('call = price cap, lock = fixed price, put = price floor.'),
  strike: z.number().positive().max(1000).optional().describe('Cap or floor price in USD per GPU-hour. Defaults to the forward rounded to $0.05.'),
  region: z.enum(Object.keys(REGION_FACTORS)).default('US East'),
  config: z.enum(Object.keys(CONFIG_FACTORS)).default('SXM-IB'),
}).strict();

const usd = value => '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const label = { call: 'Price cap', lock: 'Fixed price', put: 'Price floor' };

/** Plain-words summary of a quote for the chat transcript. */
export function describeQuote(q) {
  const hours = q.gpuHours.toLocaleString('en-US');
  const lines = [
    `${q.inputs.gpu} ${label[q.type].toLowerCase()}: ${q.inputs.count} GPUs, ${q.inputs.start} to ${q.inputs.end} (${hours} GPU-hours), ${q.inputs.region}, ${q.inputs.config}.`,
    `${label[q.type]}: ${usd(q.strike)} per GPU-hour.`,
  ];
  if (q.type !== 'lock') lines.push(`Fee: ${usd(q.premiumPerGpuHour)} per GPU-hour, ${usd(q.premiumTotal)} total (of which Dodona fee ${usd(q.platformFee)}).`);
  lines.push(`Booking fee ${usd(q.bookingFee)}. Pay now ${usd(q.payNow)}.`);
  if (q.type === 'put') lines.push(`Floor revenue on all hours: ${usd(q.costIfUsed)}. Protects below ${usd(q.breakEven)} per GPU-hour after the fee.`);
  else lines.push(`${q.type === 'lock' ? 'You pay if you use it' : 'Most you pay if you use it'}: ${usd(q.costIfUsed)}.`);
  if (q.type === 'call') lines.push(`Pays off above ${usd(q.breakEven)} per GPU-hour.`);
  lines.push(`Priced ${q.method}: forward ${usd(q.forward)}, volatility ${(q.vol * 100).toFixed(0)}% (${q.volSampling}-sampled, annualised), index as of ${q.asOf}.`);
  lines.push(DISCLAIMER);
  return lines.join('\n');
}

/** Registers quote_cap on an McpServer. `prices` and `now` are injectable for tests. */
export function registerQuoteCap(server, { prices = getPriceHistory, now = Date.now } = {}) {
  server.registerTool('quote_cap', {
    title: 'Quote a GPU price cap',
    description: 'Price a cap (call), floor (put) or fixed-price lock on a block of GPU-hours with Dodona pricing v0 (Black-76 on the index forward, average-price adjusted). Returns the fee, booking fee, pay-now amount and break-even. Demo quote only: nothing is booked or charged.',
    inputSchema: quoteCapInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async args => {
    try {
      const quote = { ...quoteFromHistory(args, await prices(), { now: now() }), disclaimer: DISCLAIMER };
      return { content: [{ type: 'text', text: describeQuote(quote) }, { type: 'text', text: JSON.stringify(quote) }], structuredContent: quote, isError: false };
    } catch (error) {
      const data = { status: 'not_completed', code: error instanceof RangeError ? 'INVALID_DETAILS' : 'INTERNAL_ERROR', message: error instanceof RangeError ? error.message : 'The quote could not be prepared. Try again later.' };
      return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: true };
    }
  });
}

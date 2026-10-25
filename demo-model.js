// Shared by the browser paper-order form and the server-side MCP demo.
// These are illustrative prices. This module never books capacity or takes payment.
export class DemoReservationError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function demoPrices(gpuHours) {
  if (!Number.isInteger(gpuHours) || gpuHours < 1 || gpuHours > 10000) {
    throw new DemoReservationError('INVALID_DETAILS', 'Choose between 1 and 10,000 total GPU-hours, using whole numbers.');
  }
  return {
    currency: 'USD', illustrative: true, rentalPricePerGpuHourCents: 300,
    protectionPaymentCents: gpuHours * 20,
    upfrontTotalCents: gpuHours * 20,
    computePaymentIfUsedCents: gpuHours * 300,
    totalIfUsedCents: gpuHours * 320,
    excludes: 'Taxes and any other charges. Demo prices are not live offers or final pricing.',
  };
}

export function priceDemoRequest(request, now = Date.now()) {
  const prices = demoPrices(request.gpuHours);
  if (request.gpuType !== 'H100' || !Number.isInteger(request.gpuCount) || request.gpuCount < 1 || request.gpuCount > 8 ||
    typeof request.region !== 'string' || request.region.trim().length < 2 || request.region.length > 80 || /[\x00-\x1f\x7f]/.test(request.region)) {
    throw new DemoReservationError('INVALID_DETAILS', 'Choose H100, between 1 and 8 GPUs, and a region preference.');
  }
  const starts = Date.parse(request.usageStartsAt);
  const ends = Date.parse(request.usageEndsAt);
  if (!Number.isFinite(starts) || !Number.isFinite(ends) || starts <= now || starts > now + 365 * 24 * 60 * 60 * 1000 || ends <= starts) {
    throw new DemoReservationError('INVALID_WINDOW', 'Choose a future usage window starting within the next year, with the end after the start.');
  }
  if (ends - starts < request.gpuHours / request.gpuCount * 60 * 60 * 1000) {
    throw new DemoReservationError('WINDOW_TOO_SHORT', 'The usage window is too short for these GPU-hours. Extend it, use more GPUs, or reduce the hours.');
  }
  for (const [field, cents, label] of [
    ['maxUpfrontUsd', prices.upfrontTotalCents, 'upfront amount'],
    ['maxTotalIfUsedUsd', prices.totalIfUsedCents, 'total if used'],
  ]) {
    if (request[field] === undefined) continue;
    if (!Number.isFinite(request[field]) || request[field] < 0 || request[field] > 1000000) throw new DemoReservationError('INVALID_DETAILS', 'Use a valid budget between $0 and $1,000,000.');
    if (cents > Math.floor(request[field] * 100 + 0.000001)) {
      throw new DemoReservationError('BUDGET_EXCEEDED', `The demo ${label} is $${(cents / 100).toFixed(2)}, above the budget. Change the quantity or budget to continue.`);
    }
  }
  return prices;
}

// Cap and lock pricing for the checkout calculator. Stub until the pricing build lands.

/**
 * Quote a compute price cap or lock.
 *
 * @param {{ gpu: string, count: number, start: string, end: string, strike: number,
 *   type: 'call' | 'lock', region: string, config: object }} input
 * @param {Array<[string, number]>} series Per-GPU price history from
 *   `getPriceHistory().data[gpu]`, as `[isoDate, price]` pairs.
 * @returns {{ premiumPerGpuHour: number, premiumTotal: number, platformFee: number,
 *   bookingFee: number, payNow: number, forward: number, vol: number, volSampling: string,
 *   breakEven: number, gpuHours: number, method: 'black76-asian-v0', asOf: string,
 *   inputs: object }}
 */
export function quoteCap(input, series) {
  throw new Error('not implemented');
}

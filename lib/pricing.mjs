/** Cap, floor and lock pricing v0: Black-76 on the index forward with an average-price adjustment. */
import { marketStats, forwardPrice, basisFactor, DISCOUNT_RATE } from './valuation.mjs';

export const PRICING_METHOD = 'black76-asian-v0';
export const PLATFORM_FEE_SHARE = 0.15;
export const BOOKING_FEE = 2;
export const LOCK_MARGIN = 0.02;
export const MIN_PREMIUM = 0.01;
export const MAX_STRIKE = 1000;
export const ALLOWED_COUNTS = Object.freeze([1, 2, 4, 8, 16, 32, 64, 128, 256]);

const HOUR_MS = 60 * 60 * 1000;
const YEAR_MS = 365 * 24 * HOUR_MS;
const MIN_LEAD_MS = 48 * HOUR_MS;
const MAX_LEAD_MS = 365 * 24 * HOUR_MS;
const MIN_WINDOW_MS = 4 * HOUR_MS;
const MIN_T_EFF = 1 / 52;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

const roundCents = value => Math.round(value * 100) / 100;
// Rounds up to the next cent; the epsilon stops float noise from adding a cent to exact values.
const ceilCents = value => Math.ceil(value * 100 - 1e-9) / 100;

/**
 * Standard normal CDF via Abramowitz and Stegun 7.1.26 for erf.
 * That erf approximation has absolute error at most 1.5e-7, so N(x) is within 7.5e-8.
 */
export function normalCdf(x) {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** Effective variance time for an average-price option over [tStart, tEnd], floored at one week. */
export function effectiveTime(tStart, tEnd) {
  return Math.max(MIN_T_EFF, tStart + (tEnd - tStart) / 3);
}

/** Black-76 call on a forward, discounted to the end of the window. */
export function black76Call({ forward, strike, vol, tEff, tEnd, rate = DISCOUNT_RATE }) {
  const discount = Math.exp(-rate * tEnd);
  const sd = vol * Math.sqrt(tEff);
  if (!(sd > 0)) return discount * Math.max(forward - strike, 0);
  const d1 = (Math.log(forward / strike) + sd * sd / 2) / sd;
  return discount * (forward * normalCdf(d1) - strike * normalCdf(d1 - sd));
}

/** Black-76 put through put-call parity: P = C - e^(-r tEnd) (F - K). */
export function black76Put(args) {
  const rate = args.rate ?? DISCOUNT_RATE;
  return black76Call(args) - Math.exp(-rate * args.tEnd) * (args.forward - args.strike);
}

function parseTime(value, name) {
  if (typeof value !== 'string' || !ISO_DATETIME.test(value)) throw new RangeError(`${name} must be an ISO date and time, for example 2026-11-02T09:00:00Z.`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new RangeError(`${name} is not a real date.`);
  return ms;
}

function validWindow({ start, end }, nowMs) {
  const startMs = parseTime(start, 'Start');
  const endMs = parseTime(end, 'End');
  if (startMs < nowMs + MIN_LEAD_MS) throw new RangeError('Start must be at least 48 hours from now.');
  if (startMs > nowMs + MAX_LEAD_MS) throw new RangeError('Start must be within the next 12 months.');
  if (endMs <= startMs) throw new RangeError('End must be after the start.');
  if (endMs - startMs < MIN_WINDOW_MS) throw new RangeError('The window must be at least 4 hours.');
  return { startMs, endMs };
}

function validBasis(region, config) {
  try { basisFactor(region, config); }
  catch (error) { throw new RangeError(error.message + '.'); }
}

function validStrike(strike) {
  if (typeof strike !== 'number' || !Number.isFinite(strike) || strike <= 0 || strike > MAX_STRIKE) {
    throw new RangeError('Strike must be a positive price per GPU-hour.');
  }
  return strike;
}

/** Strike for "at today's price": the forward rounded to the nearest $0.05. */
export const atTheMoneyStrike = forward => roundCents(Math.round(forward / 0.05) * 0.05);

// Shared market inputs for one window, from the same statistics the valuation uses.
function marketInputs(input, series, { now = Date.now() } = {}) {
  if (!input || typeof input !== 'object') throw new RangeError('Quote details are missing.');
  const { gpu, count, region = 'US East', config = 'SXM-IB' } = input;
  if (typeof gpu !== 'string' || !gpu) throw new RangeError('Choose a GPU.');
  if (!ALLOWED_COUNTS.includes(count)) throw new RangeError(`GPU count must be one of ${ALLOWED_COUNTS.join(', ')}.`);
  if (!Array.isArray(series) || series.length < 2) throw new RangeError(`No price history for ${gpu}.`);
  validBasis(region, config);
  const { startMs, endMs } = validWindow(input, now);
  const stats = marketStats(series);
  const tStart = (startMs - now) / YEAR_MS;
  const tEnd = (endMs - now) / YEAR_MS;
  const tMid = (tStart + tEnd) / 2;
  return {
    gpu, count, region, config, stats, tStart, tEnd, tMid,
    tEff: effectiveTime(tStart, tEnd),
    forward: forwardPrice(stats.spot, stats.drift, tMid),
    gpuHours: count * (endMs - startMs) / HOUR_MS,
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    nowIso: new Date(now).toISOString(),
  };
}

function shape(market, { type, strike, premiumPerGpuHour, costPerGpuHour, breakEven }) {
  const premiumTotal = roundCents(premiumPerGpuHour * market.gpuHours);
  return {
    gpuHours: market.gpuHours,
    type,
    strike,
    premiumPerGpuHour,
    premiumTotal,
    platformFee: roundCents(premiumTotal * PLATFORM_FEE_SHARE),
    bookingFee: BOOKING_FEE,
    payNow: roundCents(premiumTotal + BOOKING_FEE),
    costIfUsed: roundCents(costPerGpuHour * market.gpuHours),
    breakEven,
    forward: market.forward,
    spot: market.stats.spot,
    vol: market.stats.vol,
    volSampling: market.stats.volSampling,
    tYears: market.tEnd,
    tEffYears: market.tEff,
    method: PRICING_METHOD,
    asOf: market.stats.asOf,
    inputs: {
      gpu: market.gpu, count: market.count, start: market.start, end: market.end, type, strike,
      region: market.region, config: market.config, now: market.nowIso,
      drift: market.stats.drift, rate: DISCOUNT_RATE, tStartYears: market.tStart, tMidYears: market.tMid,
      ...(type === 'lock' ? { lockMargin: LOCK_MARGIN } : {}),
    },
  };
}

const optionPremium = value => Math.max(MIN_PREMIUM, ceilCents(value));

/**
 * Quote a price cap (a call) or a fixed-price lock on a block of GPU-hours.
 * A missing call strike defaults to the forward rounded to $0.05. Throws RangeError on invalid input.
 */
export function quoteCap(input, series, options = {}) {
  const type = input?.type ?? 'call';
  if (type !== 'call' && type !== 'lock') throw new RangeError('Type must be call or lock.');
  const market = marketInputs(input, series, options);
  if (type === 'lock') {
    const fixed = roundCents(market.forward * (1 + LOCK_MARGIN));
    return shape(market, { type, strike: fixed, premiumPerGpuHour: 0, costPerGpuHour: fixed, breakEven: null });
  }
  const strike = input.strike == null ? atTheMoneyStrike(market.forward) : validStrike(input.strike);
  const premium = optionPremium(black76Call({ forward: market.forward, strike, vol: market.stats.vol, tEff: market.tEff, tEnd: market.tEnd }));
  return shape(market, { type, strike, premiumPerGpuHour: premium, costPerGpuHour: strike, breakEven: roundCents(strike + premium) });
}

/** Quote a price floor (a put) with the same shape; costIfUsed is the floor revenue, strike times GPU-hours. */
export function quotePut(input, series, options = {}) {
  const market = marketInputs(input, series, options);
  const strike = input.strike == null ? atTheMoneyStrike(market.forward) : validStrike(input.strike);
  const premium = optionPremium(black76Put({ forward: market.forward, strike, vol: market.stats.vol, tEff: market.tEff, tEnd: market.tEnd }));
  return shape(market, { type: 'put', strike, premiumPerGpuHour: premium, costPerGpuHour: strike, breakEven: roundCents(strike - premium) });
}

/** Picks the GPU series from a price history and dispatches by type ('call', 'lock' or 'put'). */
export function quoteFromHistory(input, history, options = {}) {
  const gpu = input?.gpu;
  if (!history?.data || typeof gpu !== 'string' || !Object.hasOwn(history.data, gpu)) {
    throw new RangeError(`GPU must be one of ${Object.keys(history?.data || {}).join(', ')}.`);
  }
  const series = history.data[gpu];
  return input.type === 'put' ? quotePut(input, series, options) : quoteCap(input, series, options);
}

/** Reads GET /api/quote query parameters into a quote input. */
export function quoteInputFromQuery(params) {
  const number = name => {
    const raw = params.get(name);
    if (raw == null || raw === '') return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new RangeError(`${name} must be a number.`);
    return value;
  };
  const type = params.get('type') || 'call';
  if (!['call', 'lock', 'put'].includes(type)) throw new RangeError('Type must be call, lock or put.');
  return {
    gpu: params.get('gpu') || '', count: number('count'), start: params.get('start') || '', end: params.get('end') || '',
    type, strike: number('strike'), region: params.get('region') || undefined, config: params.get('config') || undefined,
  };
}

/** Route body for GET /api/quote; returns { status, body } for the server's JSON helper. */
export async function quoteRoute(url, { prices, now = Date.now }) {
  try {
    const input = quoteInputFromQuery(url.searchParams);
    return { status: 200, body: quoteFromHistory(input, await prices(), { now: now() }) };
  } catch (error) {
    if (error instanceof RangeError) return { status: 400, body: { error: error.message } };
    throw error;
  }
}

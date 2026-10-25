import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { fallbackHistory } from '../lib/prices.mjs';
import { marketStats } from '../lib/valuation.mjs';
import {
  normalCdf, black76Call, black76Put, effectiveTime, quoteCap, quotePut, quoteFromHistory, quoteInputFromQuery,
  atTheMoneyStrike, PLATFORM_FEE_SHARE,
} from '../lib/pricing.mjs';
import { listen, close } from './fixture.mjs';

const NOW = Date.parse('2026-10-22T12:00:00Z');
const history = fallbackHistory();
const series = history.data.H100;
const base = { gpu: 'H100', count: 64, start: '2026-11-02T09:00:00Z', end: '2026-11-09T09:00:00Z', type: 'call', strike: 2.85, region: 'US East', config: 'SXM-IB' };
const quote = (patch = {}) => quoteCap({ ...base, ...patch }, series, { now: NOW });
const near = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected}`);

test('normal CDF matches reference values within the documented error', () => {
  near(normalCdf(0), 0.5, 1e-7, 'N(0)');
  near(normalCdf(1.96), 0.9750021, 1e-7, 'N(1.96)');
  near(normalCdf(-1), 0.1586553, 1e-7, 'N(-1)');
  near(normalCdf(3) + normalCdf(-3), 1, 1e-12, 'symmetry');
});

test('known input: at-the-money call with F = K = 2.80, vol 0.40, one month', () => {
  const value = black76Call({ forward: 2.8, strike: 2.8, vol: 0.4, tEff: 1 / 12, tEnd: 1 / 12 });
  near(value, 0.129, 0.001, 'premium per GPU-hour');
});

test('higher strike lowers the call premium', () => {
  const args = { forward: 2.8, vol: 0.4, tEff: 0.1, tEnd: 0.15 };
  const premiums = [2.6, 2.8, 3.0, 3.2].map(strike => black76Call({ ...args, strike }));
  for (let i = 1; i < premiums.length; i++) assert.ok(premiums[i] < premiums[i - 1]);
  assert.ok(quote({ strike: 2.6 }).premiumPerGpuHour > quote({ strike: 3.2 }).premiumPerGpuHour);
});

test('a longer window raises the premium per GPU-hour', () => {
  const week = quote({ strike: 2.8 });
  const quarter = quote({ strike: 2.8, end: '2027-02-02T09:00:00Z' });
  assert.ok(quarter.tEffYears > week.tEffYears);
  assert.ok(quarter.premiumPerGpuHour > week.premiumPerGpuHour);
});

test('the average-price adjustment lowers the premium against a plain option to the window end', () => {
  const tStart = 0.1, tEnd = 0.5;
  const tEff = effectiveTime(tStart, tEnd);
  near(tEff, 0.1 + 0.4 / 3, 1e-12, 'tEff');
  const args = { forward: 2.8, strike: 2.9, vol: 0.4, tEnd };
  assert.ok(black76Call({ ...args, tEff }) < black76Call({ ...args, tEff: tEnd }));
  assert.equal(effectiveTime(0.001, 0.002), 1 / 52);
});

test('put-call parity holds for the model and for the quote functions', () => {
  const args = { forward: 2.8, strike: 2.95, vol: 0.4, tEff: 0.2, tEnd: 0.3 };
  const parity = Math.exp(-0.05 * args.tEnd) * (args.forward - args.strike);
  near(black76Call(args) - black76Put(args), parity, 1e-12, 'C - P');
  const call = quoteCap(base, series, { now: NOW });
  const put = quotePut(base, series, { now: NOW });
  assert.equal(put.type, 'put');
  assert.deepEqual(Object.keys(put).sort(), Object.keys(call).sort());
  const unrounded = Math.exp(-0.05 * call.tYears) * (call.forward - call.strike);
  near(call.premiumPerGpuHour - put.premiumPerGpuHour, unrounded, 0.0101, 'rounded parity');
  assert.equal(put.breakEven, Math.round((put.strike - put.premiumPerGpuHour) * 100) / 100);
});

test('a call quote reuses the valuation statistics and carries the agreed fields and fees', () => {
  const q = quote();
  const stats = marketStats(series);
  assert.equal(q.spot, stats.spot);
  assert.equal(q.vol, stats.vol);
  assert.equal(q.volSampling, 'weekly');
  assert.equal(q.asOf, stats.asOf);
  near(q.forward, stats.spot * Math.exp(stats.drift * q.inputs.tMidYears), 1e-12, 'forward');
  assert.equal(q.method, 'black76-asian-v0');
  assert.equal(q.gpuHours, 64 * 168);
  assert.equal(q.premiumTotal, Math.round(q.premiumPerGpuHour * q.gpuHours * 100) / 100);
  assert.equal(q.platformFee, Math.round(q.premiumTotal * PLATFORM_FEE_SHARE * 100) / 100);
  assert.equal(q.payNow, q.premiumTotal, 'a cap pays the premium up front and nothing else');
  assert.ok(!('bookingFee' in q), 'no flat per-order fee');
  assert.equal(q.costIfUsed, Math.round(2.85 * q.gpuHours * 100) / 100);
  assert.equal(q.breakEven, Math.round((2.85 + q.premiumPerGpuHour) * 100) / 100);
  for (const key of ['gpuHours', 'type', 'strike', 'premiumPerGpuHour', 'premiumTotal', 'platformFee', 'payNow', 'costIfUsed', 'breakEven', 'forward', 'spot', 'vol', 'volSampling', 'tYears', 'tEffYears', 'method', 'asOf', 'inputs']) {
    assert.ok(key in q, key);
  }
});

test('premiums round up to the cent with a one-cent floor', () => {
  assert.equal(quote({ strike: 50 }).premiumPerGpuHour, 0.01);
  const exact = black76Call({ forward: 2.8, strike: 2.8, vol: 0.4, tEff: 1 / 12, tEnd: 1 / 12 });
  assert.equal(Math.ceil(exact * 100) / 100, 0.13);
});

test('a lock is the forward plus a two percent provider margin with no premium', () => {
  const lock = quote({ type: 'lock', strike: undefined });
  assert.equal(lock.type, 'lock');
  assert.equal(lock.strike, Math.round(lock.forward * 1.02 * 100) / 100);
  assert.equal(lock.premiumPerGpuHour, 0);
  assert.equal(lock.premiumTotal, 0);
  assert.equal(lock.payNow, 0, 'a lock has nothing to pay up front');
  assert.equal(lock.costIfUsed, Math.round(lock.strike * lock.gpuHours * 100) / 100);
  assert.equal(lock.breakEven, null);
  assert.equal(lock.inputs.lockMargin, 0.02);
});

test('a call without a strike is struck at the forward rounded to five cents', () => {
  const q = quote({ strike: undefined });
  assert.equal(q.strike, atTheMoneyStrike(q.forward));
  near(q.strike * 20, Math.round(q.strike * 20), 1e-9, 'five-cent grid');
});

test('invalid inputs throw RangeError with a plain message', () => {
  const day = 24 * 60 * 60 * 1000;
  const iso = ms => new Date(ms).toISOString();
  for (const [patch, message] of [
    [{ start: iso(NOW + day) }, /48 hours/],
    [{ start: iso(NOW + 400 * day), end: iso(NOW + 401 * day) }, /12 months/],
    [{ end: base.start }, /after the start/],
    [{ end: '2026-11-02T12:00:00Z' }, /4 hours/],
    [{ count: 3 }, /GPU count/],
    [{ count: 512 }, /GPU count/],
    [{ strike: 0 }, /Strike/],
    [{ strike: -1 }, /Strike/],
    [{ strike: Number.NaN }, /Strike/],
    [{ start: 'next week' }, /ISO date/],
    [{ region: 'Mars' }, /region/i],
    [{ config: 'NVL72' }, /config/i],
    [{ type: 'swap' }, /Type/],
  ]) assert.throws(() => quote(patch), error => error instanceof RangeError && message.test(error.message), JSON.stringify(patch));
  assert.throws(() => quoteCap(base, [], { now: NOW }), RangeError);
  assert.throws(() => quoteFromHistory({ ...base, gpu: 'TPU' }, history, { now: NOW }), /GPU must be one of/);
  assert.throws(() => quoteFromHistory({ ...base, gpu: 'constructor' }, history, { now: NOW }), RangeError);
});

test('a valuation date can be an ISO string and booking rules can be skipped to mark held positions', () => {
  assert.deepEqual(quoteCap(base, series, { now: '2026-10-22T12:00:00Z' }), quote());
  assert.equal(quoteCap(base, series, { now: '2026-10-22' }).inputs.now, '2026-10-22T00:00:00.000Z');
  assert.throws(() => quoteCap(base, series, { now: 'yesterday' }), RangeError);

  const mark = { ...base, count: 64, start: '2026-11-16T00:00:00Z', end: '2026-11-23T00:00:00Z', strike: 2.5 };
  assert.throws(() => quoteCap({ ...mark, count: 48 }, series, { now: NOW }), /GPU count/);
  const odd = quoteCap({ ...mark, count: 48 }, series, { now: NOW, skipBookingRules: true });
  assert.equal(odd.gpuHours, 48 * 168);

  const inside = quoteCap(mark, series, { now: '2026-11-18', skipBookingRules: true });
  assert.ok(inside.tEffYears > 0 && inside.tYears < 7 / 365);
  near(inside.inputs.tMidYears, inside.tYears / 2, 1e-12, 'remaining midpoint');
  const expired = quoteCap(mark, series, { now: '2026-12-01', skipBookingRules: true });
  assert.equal(expired.tYears, 0);
  assert.equal(expired.tEffYears, 0);
  assert.equal(expired.premiumPerGpuHour, Math.max(0.01, Math.ceil((expired.forward - 2.5) * 100 - 1e-9) / 100));

  assert.throws(() => quoteCap({ ...mark, end: mark.start }, series, { now: NOW, skipBookingRules: true }), /after the start/);
  assert.throws(() => quoteCap({ ...mark, strike: 0 }, series, { now: NOW, skipBookingRules: true }), /Strike/);
  assert.throws(() => quoteCap({ ...mark, count: 0 }, series, { now: NOW, skipBookingRules: true }), /GPU count/);
});

test('query parsing keeps strings and rejects non-numbers', () => {
  const params = new URLSearchParams({ gpu: 'H100', count: '64', start: base.start, end: base.end, type: 'put', strike: '2.5', region: 'US East', config: 'SXM-IB' });
  assert.deepEqual(quoteInputFromQuery(params), { ...base, type: 'put', strike: 2.5 });
  assert.throws(() => quoteInputFromQuery(new URLSearchParams({ count: 'lots' })), RangeError);
  assert.throws(() => quoteInputFromQuery(new URLSearchParams({ type: 'swap' })), RangeError);
});

test('GET /api/quote returns quotes with no-store and 400 JSON errors', async t => {
  const server = createApp({ store: null, prices: async () => history, now: () => NOW, siteSettings: { operatorName: 'Test fixture operator', contactEmail: 'fixture@example.invalid', retentionDays: null } });
  const origin = await listen(server);
  t.after(() => close(server));
  const query = patch => origin + '/api/quote?' + new URLSearchParams({ gpu: 'H100', count: '64', start: base.start, end: base.end, type: 'call', strike: '2.50', region: 'US East', config: 'SXM-IB', ...patch });

  const ok = await fetch(query());
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  const { computeMs, ...body } = await ok.json();
  assert.ok(Number.isFinite(computeMs) && computeMs >= 0, 'computeMs is reported');
  assert.deepEqual(body, JSON.parse(JSON.stringify(quoteCap({ ...base, strike: 2.5 }, series, { now: NOW }))));
  assert.equal((await (await fetch(query({ type: 'put' }))).json()).type, 'put');
  assert.equal((await (await fetch(query({ type: 'lock' }))).json()).premiumPerGpuHour, 0);

  for (const patch of [{ gpu: 'TPU' }, { count: '3' }, { strike: '0' }, { strike: 'abc' }, { start: 'soon' }, { type: 'swap' }, { region: 'Mars' }]) {
    const response = await fetch(query(patch));
    assert.equal(response.status, 400, JSON.stringify(patch));
    const error = await response.json();
    assert.deepEqual(Object.keys(error), ['error']);
    assert.equal(typeof error.error, 'string');
  }
  assert.equal((await fetch(origin + '/api/quote')).status, 400);
});

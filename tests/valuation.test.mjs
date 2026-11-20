import test from 'node:test';
import assert from 'node:assert/strict';
import {
  marketStats, weeklyVol, hazardFromBond, basisFactor, monthlySlices, valueContract, valuationHistory, fleetMark, ltvStatus, METHOD_VERSION,
} from '../lib/valuation.mjs';

const close = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);
const flat = (price, days = 30, last = '2026-10-18') => Array.from({ length: days }, (_, i) => {
  const date = new Date(Date.parse(last + 'T00:00:00Z') - (days - 1 - i) * 86400000).toISOString().slice(0, 10);
  return [date, price];
});
const wiggly = flat(3).map(([date], i) => [date, 3 * Math.exp(0.04 * Math.sin(i))]);
const base = {
  gpu: 'H100', count: 1, pricePerGpuHour: 2, start: '2026-10-18', end: '2026-10-19', region: 'US East', config: 'SXM-IB',
  provider: { label: 'Test provider', creditTier: 'A', bondPriceCents: 100 }, termType: 'take-or-pay',
};

test('market stats give zero vol and drift on a flat series and clamp then halve drift', () => {
  const stats = marketStats(flat(3));
  assert.equal(stats.spot, 3);
  assert.equal(stats.vol, 0);
  assert.equal(stats.drift, 0);
  const rising = flat(1).map(([date], i) => [date, Math.exp(0.01 * i)]);
  close(marketStats(rising).rawDrift, 3.65);
  close(marketStats(rising).drift, 0.15);
});

test('volatility uses weekly changes when there are at least eight weekly points', () => {
  const weeklyCycle = flat(3, 64).map(([date], i) => [date, 3 * (1 + 0.05 * Math.sin(2 * Math.PI * i / 7))]);
  const stats = marketStats(weeklyCycle);
  assert.equal(stats.volSampling, 'weekly');
  close(stats.vol, 0, 1e-9);
  const trend = flat(1, 64).map(([date], i) => [date, Math.exp(0.01 * i + (i % 7 === 0 ? 0 : 0.02))]);
  const weekly = [];
  for (let i = 63; i >= 0; i -= 7) weekly.unshift(trend[i][1]);
  const returns = weekly.slice(1).map((p, i) => Math.log(p / weekly[i]));
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const sd = Math.sqrt(returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1));
  close(marketStats(trend).vol, sd * Math.sqrt(52));
});

test('volatility falls back to daily changes below eight weekly points', () => {
  const short = flat(3, 30).map(([date], i) => [date, 3 * Math.exp(0.04 * Math.sin(i))]);
  const result = weeklyVol(short.map(([, p]) => p));
  assert.equal(result.volSampling, 'daily');
  assert.ok(result.vol > 0);
  assert.equal(marketStats(short).volSampling, 'daily');
});

test('hazard comes from the bond price and basis multiplies region by config', () => {
  close(hazardFromBond(78), 0.11 / 0.6);
  assert.equal(hazardFromBond(100), 0);
  assert.equal(hazardFromBond(104), 0);
  close(basisFactor('Europe', 'PCIe'), 1.04 * 0.85);
  assert.throws(() => basisFactor('Mars', 'PCIe'));
});

test('monthly slices cover the remaining window only', () => {
  const contract = { ...base, count: 2, start: '2027-03-01', end: '2027-09-01' };
  const slices = monthlySlices(contract, '2026-10-18');
  assert.deepEqual(slices.map(s => s.month), ['2027-03', '2027-04', '2027-05', '2027-06', '2027-07', '2027-08']);
  close(slices.reduce((sum, s) => sum + s.hours, 0), 2 * 184 * 24);
  const started = monthlySlices({ ...contract, start: '2026-10-01', end: '2026-12-01' }, '2026-10-18');
  close(started.reduce((sum, s) => sum + s.hours, 0), 2 * (14 + 30) * 24);
});

test('known input: one GPU for one day, flat $3 index, $2 contract, risk-free provider', () => {
  const result = valueContract(base, flat(3), { today: '2026-10-18' });
  const t = 0.5 / 365;
  close(result.value, 24 * (3 - 2) * Math.exp(-0.05 * t));
  close(result.remainingHours, 24);
  close(result.remainingCost, 48);
  close(result.low, result.value);
  close(result.high, result.value);
  close(result.forwardAvg, 3);
  assert.equal(result.methodVersion, METHOD_VERSION);
  assert.equal(result.asOf, '2026-10-18');
  assert.equal(result.inputs.pricePerGpuHour, 2);
});

test('credit hazard shrinks the value toward zero', () => {
  const contract = { ...base, end: '2027-10-18' };
  const safe = valueContract(contract, flat(3), { today: '2026-10-18' });
  const risky = valueContract({ ...contract, provider: { ...base.provider, bondPriceCents: 78 } }, flat(3), { today: '2026-10-18' });
  assert.ok(risky.value < safe.value && risky.value > 0);
});

test('a higher contract price gives a lower value', () => {
  const contract = { ...base, end: '2027-04-18', count: 64 };
  const values = [1.5, 2, 2.5, 3, 3.5].map(K => valueContract({ ...contract, pricePerGpuHour: K }, wiggly, { today: '2026-10-18' }).value);
  values.slice(1).forEach((value, i) => assert.ok(value < values[i]));
});

test('the cancel option is worth at least the take-or-pay contract', () => {
  for (const K of [1, 3, 5]) {
    const contract = { ...base, pricePerGpuHour: K, end: '2027-06-01', count: 8 };
    const takeOrPay = valueContract(contract, wiggly, { today: '2026-10-18' });
    const cancel = valueContract({ ...contract, termType: 'usage-with-cancel' }, wiggly, { today: '2026-10-18' });
    assert.ok(cancel.value >= takeOrPay.value - 1e-9);
    assert.ok(cancel.value >= 0);
  }
  const underwater = { ...base, pricePerGpuHour: 5, termType: 'usage-with-cancel', end: '2027-01-01' };
  assert.equal(valueContract(underwater, flat(3), { today: '2026-10-18' }).value, 0);
});

test('zero remaining hours value to zero', () => {
  const result = valueContract({ ...base, start: '2026-01-01', end: '2026-06-01' }, flat(3), { today: '2026-10-18' });
  assert.equal(result.value, 0);
  assert.equal(result.remainingHours, 0);
  assert.equal(result.remainingCost, 0);
  assert.equal(result.centsOnDollar, null);
});

test('cents on the dollar is remaining cost plus value over remaining cost', () => {
  const contract = { ...base, count: 100, end: '2027-03-01', pricePerGpuHour: 3.4 };
  const result = valueContract(contract, wiggly, { today: '2026-10-18' });
  close(result.centsOnDollar, (result.remainingCost + result.value) / result.remainingCost * 100);
  assert.ok(result.value < 0 && result.centsOnDollar < 100);
});

test('the range brackets the value and widens with volatility', () => {
  const contract = { ...base, count: 16, end: '2027-10-18' };
  const result = valueContract(contract, wiggly, { today: '2026-10-18' });
  assert.ok(result.low < result.value && result.value < result.high);
});

test('a Kalshi settle blends 50/50 with the model forward', () => {
  const contract = { ...base, start: '2026-11-01', end: '2026-12-01' };
  const plain = valueContract(contract, flat(3), { today: '2026-10-18' });
  const blended = valueContract(contract, flat(3), { today: '2026-10-18', kalshiImpliedSettle: { '2026-11': 4 } });
  close(blended.forwardAvg, 3.5);
  assert.ok(blended.value > plain.value);
});

test('valuation history rolls the date and spot over the last ninety days', () => {
  const series = flat(3, 120).map(([date], i) => [date, 2 + i / 100]);
  const contract = { ...base, start: '2026-06-01', end: '2027-06-01', count: 10 };
  const history = valuationHistory(contract, series);
  assert.equal(history.length, 90);
  assert.equal(history.at(-1).date, '2026-10-18');
  close(history.at(-1).value, valueContract(contract, series, { today: '2026-10-18' }).value);
});

test('fleet mark uses the income approach with a residual and flags the loan-to-value', () => {
  const mark = fleetMark({ gpu: 'H100', units: 10, installedOn: '2026-10-18', usefulLifeMonths: 12, loanBalance: 140000 }, flat(3), { today: '2026-10-18' });
  let income = 0;
  for (let m = 0; m < 12; m++) income += 3 * 720 * 0.75 * Math.exp(-0.05 * (m + 0.5) / 12);
  close(mark.unitValue, income * 1.1, 1e-6);
  close(mark.fleetValue, income * 11, 1e-5);
  close(mark.ltv, 140000 / (income * 11));
  assert.equal(mark.ltvStatus, 'watch');
  assert.equal(ltvStatus(0.59), 'ok');
  assert.equal(ltvStatus(0.75), 'breach');
  const spent = fleetMark({ gpu: 'A100', units: 1, installedOn: '2020-01-01', loanBalance: 1 }, flat(1), { today: '2026-10-18' });
  assert.equal(spent.fleetValue, 0);
  assert.equal(spent.ltvStatus, 'breach');
});

/** Test valuation method v0.1: marks GPU rental contracts and GPU-backed loans against the daily price index. */

export const METHOD_VERSION = 'v0.1-test';
export const DISCOUNT_RATE = 0.05;
export const RECOVERY_RATE = 0.4;
export const DRIFT_CLAMP = 0.3;
export const REGION_FACTORS = Object.freeze({ 'US East': 1, 'US West': 1, 'Europe': 1.04 });
export const CONFIG_FACTORS = Object.freeze({ 'SXM-IB': 1, 'PCIe': 0.85 });
export const LTV_LIMITS = Object.freeze({ watch: 0.6, breach: 0.75 });
export const RESIDUAL_SHARE = 0.1;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const YEAR_MS = 365 * DAY_MS;
const MONTH_DAYS = 365 / 12;
const HOURS_PER_MONTH = 24 * 30;

const toMs = iso => Date.parse(iso.length === 10 ? iso + 'T00:00:00Z' : iso);
const years = (fromMs, toMsValue) => (toMsValue - fromMs) / YEAR_MS;
const clamp = (value, limit) => Math.max(-limit, Math.min(limit, value));

// Spot, annualised volatility and (halved, clamped) drift from a [[date, price], ...] series.
export function marketStats(series) {
  if (!Array.isArray(series) || series.length < 2) throw new Error('A price series needs at least two points.');
  const returns = series.slice(1).map(([, price], i) => Math.log(price / series[i][1]));
  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance = returns.length > 1 ? returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1) : 0;
  const rawDrift = mean * 365;
  const [asOf, spot] = series.at(-1);
  return { spot, asOf, vol: Math.sqrt(variance) * Math.sqrt(365), rawDrift, drift: clamp(rawDrift, DRIFT_CLAMP) / 2 };
}

export const forwardPrice = (spot, drift, t) => spot * Math.exp(drift * t);

export function basisFactor(region, config) {
  if (!(region in REGION_FACTORS)) throw new Error(`Unknown region: ${region}`);
  if (!(config in CONFIG_FACTORS)) throw new Error(`Unknown config: ${config}`);
  return REGION_FACTORS[region] * CONFIG_FACTORS[config];
}

// Credit spread is half the bond's discount per year; hazard divides by loss given default.
export function hazardFromBond(bondPriceCents) {
  const spread = Math.max(0, (100 - bondPriceCents) / 100) * 0.5;
  return spread / (1 - RECOVERY_RATE);
}

// Splits the remaining window [max(today, start), end) at UTC month boundaries.
export function monthlySlices({ count, start, end }, today) {
  const todayMs = toMs(today);
  const endMs = toMs(end);
  let cursor = Math.max(todayMs, toMs(start));
  const slices = [];
  while (cursor < endMs) {
    const date = new Date(cursor);
    const nextMonth = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    const sliceEnd = Math.min(nextMonth, endMs);
    slices.push({
      month: date.toISOString().slice(0, 7),
      hours: count * (sliceEnd - cursor) / HOUR_MS,
      t: years(todayMs, (cursor + sliceEnd) / 2),
    });
    cursor = sliceEnd;
  }
  return slices;
}

function valueWithStats(contract, stats, { today = stats.asOf, kalshiImpliedSettle } = {}) {
  const K = contract.pricePerGpuHour;
  const b = basisFactor(contract.region, contract.config);
  const hazard = hazardFromBond(contract.provider.bondPriceCents);
  const cancellable = contract.termType === 'usage-with-cancel';
  const slices = monthlySlices(contract, today);
  const forward = slice => {
    const model = forwardPrice(stats.spot, stats.drift, slice.t);
    const settle = kalshiImpliedSettle?.[slice.month];
    return Number.isFinite(settle) ? 0.5 * model + 0.5 * settle : model;
  };
  const presentValue = scale => slices.reduce((sum, slice) => {
    const gap = forward(slice) * scale * b - K;
    const term = cancellable ? Math.max(gap, 0) : gap;
    return sum + slice.hours * term * Math.exp(-DISCOUNT_RATE * slice.t) * Math.exp(-hazard * slice.t);
  }, 0);

  const remainingHours = slices.reduce((sum, slice) => sum + slice.hours, 0);
  const remainingCost = remainingHours * K;
  const todayMs = toMs(today);
  const tMid = remainingHours ? (years(todayMs, Math.max(todayMs, toMs(contract.start))) + years(todayMs, toMs(contract.end))) / 2 : 0;
  const shock = Math.exp(stats.vol * Math.sqrt(tMid));
  const value = presentValue(1);
  const [low, high] = [presentValue(1 / shock), presentValue(shock)].sort((x, y) => x - y);
  return {
    value, low, high, remainingHours, remainingCost,
    centsOnDollar: remainingCost > 0 ? (remainingCost + value) / remainingCost * 100 : null,
    spot: stats.spot,
    forwardAvg: remainingHours ? slices.reduce((sum, slice) => sum + slice.hours * forward(slice) * b, 0) / remainingHours : null,
    vol: stats.vol,
    drift: stats.drift,
    hazard,
    methodVersion: METHOD_VERSION,
    asOf: stats.asOf,
    inputs: {
      ...contract, today, basis: b, discountRate: DISCOUNT_RATE, recoveryRate: RECOVERY_RATE, midTenorYears: tMid,
      kalshiBlend: Boolean(kalshiImpliedSettle),
    },
  };
}

export function valueContract(contract, series, options = {}) {
  return valueWithStats(contract, marketStats(series), options);
}

// Value as of each of the last `days` index dates, rolling spot and the valuation date, holding vol and drift.
export function valuationHistory(contract, series, { days = 90 } = {}) {
  const stats = marketStats(series);
  return series.slice(-days).map(([date, price]) => {
    const point = valueWithStats(contract, { ...stats, spot: price, asOf: date }, { today: date });
    return { date, value: point.value, centsOnDollar: point.centsOnDollar };
  });
}

export function ltvStatus(ltv) {
  if (ltv < LTV_LIMITS.watch) return 'ok';
  if (ltv < LTV_LIMITS.breach) return 'watch';
  return 'breach';
}

// Income approach: discounted rental income over remaining useful life, plus a residual share.
export function fleetMark({ gpu, units, installedOn, utilization = 0.75, usefulLifeMonths = 48, loanBalance }, series, { today } = {}) {
  const { spot, asOf } = marketStats(series);
  const valuationDate = today || asOf;
  const monthsUsed = Math.max(0, (toMs(valuationDate) - toMs(installedOn)) / DAY_MS / MONTH_DAYS);
  const remainingLifeMonths = Math.max(0, usefulLifeMonths - monthsUsed);
  let incomeValue = 0;
  for (let m = 0; m < remainingLifeMonths; m++) {
    const share = Math.min(1, remainingLifeMonths - m);
    const t = (m + share / 2) / 12;
    incomeValue += spot * HOURS_PER_MONTH * utilization * share * Math.exp(-DISCOUNT_RATE * t);
  }
  const residualValue = incomeValue * RESIDUAL_SHARE;
  const unitValue = incomeValue + residualValue;
  const fleetValue = unitValue * units;
  const ltv = fleetValue > 0 ? loanBalance / fleetValue : Infinity;
  return {
    spot, remainingLifeMonths, incomeValue, residualValue, unitValue, fleetValue, loanBalance, ltv,
    ltvStatus: ltvStatus(ltv), methodVersion: METHOD_VERSION, asOf,
    inputs: { gpu, units, installedOn, utilization, usefulLifeMonths, loanBalance, today: valuationDate, discountRate: DISCOUNT_RATE },
  };
}

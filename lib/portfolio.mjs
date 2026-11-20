/** Customer dashboard: values the account's positions (the sample set, or paid demo orders) against the price index, and renders the dashboard page. */
import { readFile } from 'node:fs/promises';
import samples from '../data/sample-portfolio.json' with { type: 'json' };
import {
  valueContract, valuationHistory, fleetMark, marketStats, basisFactor, monthlySlices,
  DISCOUNT_RATE, METHOD_VERSION, REGION_FACTORS, CONFIG_FACTORS,
} from './valuation.mjs';
import { renderPage } from './site.mjs';
import { todayUtc } from './contracts.mjs';
import { quotePut } from './pricing.mjs';
import * as view from '../dashboard-view.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const YEAR_MS = 365 * DAY_MS;
// Charts run from the first index print to the valuation date (the client filters by range: 1D to All).
const HISTORY_DAYS = Infinity;
const PARTNER = Object.freeze({ label: 'Partner neocloud · reserved capacity', creditTier: 'Delivery-backed', bondPriceCents: 100 });
const DASHBOARD_PATHS = new Set(['/dashboard', '/api/portfolio']);

const toMs = iso => Date.parse(iso.length === 10 ? iso + 'T00:00:00Z' : iso);
const sum = (items, pick) => items.reduce((total, item) => total + pick(item), 0);
const remainingHours = (position, date) => sum(monthlySlices(position, date), slice => slice.hours);

// quoteCap comes from the pricing engine; until it is merged it throws, and calls are valued at intrinsic only.
export async function loadQuoteCap() {
  try {
    const { quoteCap } = await import('./pricing.mjs');
    return typeof quoteCap === 'function' ? quoteCap : null;
  } catch {
    return null;
  }
}

// Puts (floors) use quotePut whenever the cap engine is in use; a null quoteCap means intrinsic only for both.
function timeValue(position, series, date, quoteCap, intrinsic, hours, side = 'call') {
  if (!quoteCap || !hours) return null;
  try {
    const { gpu, count, start, end, pricePerGpuHour: strike, region, config } = position;
    const input = { gpu, count, start, end, strike, type: side, region, config };
    const quote = side === 'put' ? quotePut(input, series, { now: date, skipBookingRules: true }) : quoteCap(input, series, { now: date, skipBookingRules: true });
    return Number.isFinite(quote?.premiumPerGpuHour) ? Math.max(quote.premiumPerGpuHour * hours - intrinsic, 0) : null;
  } catch {
    return null;
  }
}

// Index points already printed inside the delivery window, up to and including `today`.
function realisedWindow(position, series, today) {
  const [startDay, endDay] = [position.start.slice(0, 10), position.end.slice(0, 10)];
  const points = series.filter(([d]) => d >= startDay && d < endDay && d <= today);
  const totalDays = Math.max(1, Math.round((toMs(position.end) - toMs(position.start)) / DAY_MS));
  const elapsedDays = Math.min(Math.max((toMs(today) - toMs(position.start)) / DAY_MS, 0), totalDays);
  return { average: points.length ? sum(points, ([, p]) => p) / points.length : null, points: points.length, totalDays, elapsedDays, weight: points.length ? elapsedDays / totalDays : 0 };
}

// Caps settle Asian-style on the average daily index over the window. Expected average: the forward at mid-window before the
// window, a days-weighted blend of the realised average and the forward during it, the realised average once it has ended.
export const expectedWindowAverage = (forward, realised) => (realised.average == null ? forward : realised.average * realised.weight + forward * (1 - realised.weight));

// Option value on the expected window average Ā: intrinsic max(Ā·b − K, 0) for a call (cap) or max(K − Ā·b, 0) for a put (floor),
// times hours and discount, plus time value from the pricing engine.
function valueOption(position, series, { today, quoteCap = null, stats = marketStats(series) }, side) {
  const K = position.pricePerGpuHour;
  const basis = basisFactor(position.region, position.config);
  const hours = remainingHours(position, today);
  const todayMs = toMs(today);
  const tMid = hours ? ((Math.max(todayMs, toMs(position.start)) + toMs(position.end)) / 2 - todayMs) / YEAR_MS : 0;
  const forwardFactor = Math.exp(stats.drift * tMid);
  const discountFactor = Math.exp(-DISCOUNT_RATE * tMid);
  const realised = realisedWindow(position, series, today);
  const averageFor = spot => expectedWindowAverage(spot * forwardFactor, realised);
  const payoff = average => (side === 'put' ? K - average : average - K);
  const intrinsicFor = spot => Math.max(payoff(averageFor(spot) * basis), 0) * hours * discountFactor;
  const intrinsic = intrinsicFor(stats.spot);
  const tv = timeValue(position, series, today, quoteCap, intrinsic, hours, side);
  const shock = Math.exp(stats.vol * Math.sqrt(tMid));
  const totalHours = position.count * (toMs(position.end) - toMs(position.start)) / HOUR_MS;
  const average = averageFor(stats.spot);
  return {
    value: intrinsic + (tv ?? 0),
    low: intrinsicFor(stats.spot / shock) + (tv ?? 0),
    high: intrinsicFor(stats.spot * shock) + (tv ?? 0),
    intrinsic, timeValue: tv,
    remainingHours: hours, remainingCost: hours * K, centsOnDollar: null,
    spot: stats.spot, forwardAvg: average * basis, forwardFactor, discountFactor, basis,
    windowAverage: { expected: average, realised: realised.average, realisedWeight: realised.weight, points: realised.points, elapsedDays: realised.elapsedDays, totalDays: realised.totalDays },
    vol: stats.vol, volSampling: stats.volSampling, drift: stats.drift, hazard: 0,
    moneyness: average * basis - K,
    breakEven: side === 'put' ? K - position.premiumPerGpuHour : K + position.premiumPerGpuHour,
    premiumPaid: position.premiumPerGpuHour * totalHours,
    totalHours, methodVersion: METHOD_VERSION, asOf: stats.asOf,
    inputs: { today, basis, discountRate: DISCOUNT_RATE, midTenorYears: tMid, timeValueSource: tv == null ? null : 'quoteCap' },
  };
}

export const valueCall = (position, series, options) => valueOption(position, series, options, 'call');
export const valuePut = (position, series, options) => valueOption(position, series, options, 'put');
const OPTION_SIDE = Object.freeze({ call: 'call', put: 'put' });

function optionHistory(position, series, quoteCap) {
  const stats = marketStats(series);
  return series.slice(-HISTORY_DAYS).map(([date, price], i, recent) => {
    const upTo = series.slice(0, series.length - recent.length + i + 1);
    const point = valueOption(position, upTo, { today: date, quoteCap, stats: { ...stats, spot: price, asOf: date } }, OPTION_SIDE[position.kind]);
    return { date, value: point.value, committedCost: 0 };
  });
}

function phaseOf(position, nowMs) {
  if (toMs(position.end) <= nowMs) return 'used';
  return toMs(position.start) <= nowMs ? 'window' : 'upcoming';
}

const FIXED_KINDS = new Set(['lock', 'offtake']);
const isFixed = p => FIXED_KINDS.has(p.kind);

// What a finished window saved against the index, day by day.
function usedSaving(position, series) {
  const basis = basisFactor(position.region, position.config);
  const [startDay, endDay] = [position.start.slice(0, 10), position.end.slice(0, 10)];
  return sum(series.filter(([d]) => d >= startDay && d < endDay), ([, price]) => (price * basis - position.pricePerGpuHour) * position.count * 24);
}

// What a finished floor paid: the index shortfall below the floor, day by day.
function optionSaving(position, series) {
  const basis = basisFactor(position.region, position.config);
  const [startDay, endDay] = [position.start.slice(0, 10), position.end.slice(0, 10)];
  return sum(series.filter(([d]) => d >= startDay && d < endDay), ([, price]) => Math.max(position.pricePerGpuHour - price * basis, 0) * position.count * 24);
}

function valuePosition(position, prices, { today, nowMs, quoteCap }) {
  const series = prices.data[position.gpu];
  const phase = phaseOf(position, nowMs);
  if (OPTION_SIDE[position.kind]) {
    const valuation = valueOption(position, series, { today, quoteCap }, OPTION_SIDE[position.kind]);
    return { ...position, phase, valuation, history: optionHistory(position, series, quoteCap), used: phase === 'used' ? { saving: position.kind === 'put' ? optionSaving(position, series) : usedSaving(position, series) } : null };
  }
  const contract = { ...position, provider: position.provider || PARTNER };
  const raw = valueContract(contract, series, { today });
  const valuation = {
    ...raw, basis: raw.inputs.basis,
    forwardFactor: raw.spot && raw.forwardAvg ? raw.forwardAvg / raw.spot / raw.inputs.basis : 1,
    discountFactor: Math.exp(-DISCOUNT_RATE * raw.inputs.midTenorYears),
  };
  const history = valuationHistory(contract, series, { days: HISTORY_DAYS })
    .map(point => ({ date: point.date, value: point.value, committedCost: remainingHours(contract, point.date) * contract.pricePerGpuHour }));
  return { ...contract, phase, valuation, history, used: phase === 'used' ? { saving: usedSaving(contract, series) } : null };
}

// Sums per-position histories over the union of their dates, carrying a position's last value across gaps.
function portfolioHistory(open) {
  const dates = [...new Set(open.flatMap(p => p.history.map(h => h.date)))].sort().slice(-HISTORY_DAYS);
  return dates.map(date => {
    let value = 0;
    let committedCost = 0;
    for (const p of open) {
      const point = p.history.findLast(h => h.date <= date) || p.history[0];
      value += point.value;
      committedCost += point.committedCost;
    }
    return { date, value, committedCost, marketValue: committedCost + value };
  });
}

// Ends the chart on today's mark when today is past the last index print, so the chart and the headline agree.
function withToday(history, open, today) {
  if (!history.length || history.at(-1).date >= today) return history;
  const value = sum(open, p => p.valuation.value);
  const committedCost = sum(open.filter(isFixed), p => p.valuation.remainingCost);
  return [...history, { date: today, value, committedCost, marketValue: committedCost + value }];
}

function nextDeadline(open, nowMs) {
  const next = open.filter(p => p.phase === 'upcoming' && p.kind !== 'offtake' && p.status !== 'listed')
    .map(p => ({ p, at: Date.parse(view.deadlineOf(p)) })).filter(d => d.at > nowMs).sort((a, b) => a.at - b.at)[0];
  if (!next) return null;
  return { date: new Date(next.at).toISOString(), positionId: next.p.id, action: OPTION_SIDE[next.p.kind] ? 'Exercise' : 'Claim', label: next.p.label, days: Math.ceil((next.at - nowMs) / DAY_MS) };
}

function buildKpis(open, history, nowMs) {
  const fixed = open.filter(isFixed);
  const calls = open.filter(p => p.kind === 'call');
  const puts = open.filter(p => p.kind === 'put');
  const cost = sum(fixed, p => p.valuation.remainingCost);
  const change = back => (history.length > back ? history.at(-1).value - history.at(-1 - back).value : 0);
  return {
    remainingCommittedCost: cost,
    optionalAtStrike: sum(calls, p => p.valuation.remainingCost),
    premiumsPaid: sum([...calls, ...puts], p => p.valuation.premiumPaid),
    callCount: calls.length,
    putCount: puts.length,
    gpuHoursRemaining: sum(open, p => p.valuation.remainingHours),
    openPositions: open.length,
    netValue: sum(open, p => p.valuation.value),
    centsOnDollar: cost > 0 ? (cost + sum(fixed, p => p.valuation.value)) / cost * 100 : null,
    nextDeadline: nextDeadline(open, nowMs),
    change: { d1: change(1), d7: change(7), d30: change(30) },
  };
}

const indexChange = (series, back) => series.at(-1)[1] / series.at(-1 - back)[1] - 1;

function moveAlerts(open, prices) {
  const gpus = [...new Set(open.map(p => p.gpu))];
  const moves = gpus.map(gpu => ({ gpu, move: indexChange(prices.data[gpu], 7) })).sort((a, b) => Math.abs(b.move) - Math.abs(a.move));
  return moves.filter((m, i) => Math.abs(m.move) >= 0.03 || i === 0).map(({ gpu, move }) => {
    const held = open.filter(p => p.gpu === gpu);
    const effect = sum(held, p => p.history.at(-1).value - (p.history.at(-8) || p.history[0]).value);
    return { id: `move-${gpu}`, severity: effect >= 0 ? 'gain' : 'loss', kind: 'Index move', go: `positions/${held[0].id}`,
      text: `${gpu} index ${move >= 0 ? 'up' : 'down'} ${view.percent(Math.abs(move), 1)} this week, moving the expected window average on your ${gpu} positions. They ${effect >= 0 ? 'gained' : 'lost'} about ${view.usd(Math.abs(effect))} in Dodona Value.` };
  });
}

function positionAlerts(open, nowMs) {
  const alerts = [];
  for (const p of open.filter(p => p.phase === 'upcoming' && p.kind !== 'offtake')) {
    const days = Math.ceil((Date.parse(view.deadlineOf(p)) - nowMs) / DAY_MS);
    if (days > 0 && days <= 30) alerts.push({ id: `deadline-${p.id}`, severity: 'warn', kind: 'Deadline', go: `positions/${p.id}`,
      text: `${OPTION_SIDE[p.kind] ? 'Exercise' : 'Claim'} deadline for ${p.label} is ${view.utcStamp(view.deadlineOf(p))}, in ${days} days.` });
  }
  for (const p of open.filter(p => p.status === 'listed' && p.bestOfferCents)) {
    alerts.push({ id: `offer-${p.id}`, severity: 'offer', kind: 'Offer', go: `positions/${p.id}`,
      text: `You have an offer of ${p.bestOfferCents}¢ on your listed ${p.label} (asking ${p.askingCents}¢, Dodona Value ${view.cents(p.valuation.centsOnDollar)}).` });
  }
  for (const p of open.filter(p => p.kind === 'call')) {
    const m = p.valuation.moneyness;
    alerts.push({ id: `cap-${p.id}`, severity: m > 0 ? 'gain' : 'info', kind: 'Price cap', go: `positions/${p.id}`,
      text: m > 0 ? `Your ${p.label} is in the money, with the expected window average ${view.perHour(m)}/GPU-h above the cap.` : `Your ${p.label} is not needed yet, with the expected window average ${view.perHour(-m)} below the cap price.` });
  }
  for (const p of open.filter(p => p.kind === 'put')) {
    const m = -p.valuation.moneyness;
    alerts.push({ id: `floor-${p.id}`, severity: m > 0 ? 'gain' : 'info', kind: 'Price floor', go: `positions/${p.id}`,
      text: m > 0 ? `Your ${p.label} is in the money, with the expected window average ${view.perHour(m)}/GPU-h below the floor.` : `Your ${p.label} is not needed yet, with the expected window average ${view.perHour(-m)} above the floor.` });
  }
  return alerts;
}

const fleetAlerts = fleets => fleets.filter(f => f.mark.ltvStatus !== 'ok').map(f => ({
  id: `ltv-${f.id}`, severity: f.mark.ltvStatus === 'breach' ? 'loss' : 'warn', kind: 'Collateral', go: 'lender',
  text: `${f.label} (${f.units.toLocaleString('en-US')} ${f.gpu}) is at ${view.percent(f.mark.ltv)} loan-to-value, status ${f.mark.ltvStatus}.`,
}));

/**
 * Value an account's positions: the sample set by default, or the paid demo orders the platform passes in.
 *
 * @param {{ prices: object, now?: number, today?: string, positions?: Array<object>, facilities?: Array<object>,
 *   account?: object, quoteCap?: Function | null }} options
 *   `quoteCap` undefined loads the pricing engine; null forces intrinsic-only option values.
 */
export async function getPortfolio({ prices, now, today, positions: held = samples.positions, facilities = samples.facilities, account = samples.account, quoteCap } = {}) {
  const quote = quoteCap === undefined ? await loadQuoteCap() : quoteCap;
  if (!today) today = todayUtc(() => now ?? Date.now());
  const nowMs = now ?? toMs(today) + 12 * HOUR_MS;
  const positions = held.map(p => valuePosition(p, prices, { today, nowMs, quoteCap: quote }));
  const open = positions.filter(p => p.phase !== 'used');
  const history = withToday(portfolioHistory(open), open, today);
  const fleets = facilities.map(f => ({ ...f, mark: fleetMark(f, prices.data[f.gpu], { today }) }));
  const providerStats = marketStats(prices.data[samples.provider.gpu]);
  return {
    asOf: today,
    methodVersion: METHOD_VERSION,
    prices: { asOf: prices.asOf, live: prices.live, source: prices.source },
    pricing: { timeValue: positions.some(p => p.valuation.timeValue != null) ? 'quoteCap' : null },
    note: samples.note,
    account: { ...account },
    kpis: buildKpis(open, history, nowMs),
    positions,
    history,
    alerts: [...moveAlerts(open, prices), ...positionAlerts(open, nowMs), ...fleetAlerts(fleets)],
    fleets,
    provider: { ...samples.provider, index: providerStats.spot, vol: providerStats.vol, volSampling: providerStats.volSampling },
  };
}

const jsonDocument = (value, status = 200) => ({ status, type: 'application/json; charset=utf-8', body: JSON.stringify(value), cacheControl: 'no-store' });

async function dashboardPage(portfolio, { settings, origin }) {
  const selected = portfolio.positions.find(p => p.kind === 'call' && p.phase !== 'used') || portfolio.positions[0];
  const replacements = {
    D_PRICES: view.pricesLine(portfolio.prices, portfolio.methodVersion),
    D_HERO_VALUE: view.escapeHtml(view.signedUsd(portfolio.kpis.netValue)),
    D_HERO_CENTS: view.escapeHtml(`${view.cents(portfolio.kpis.centsOnDollar)} on fixed contracts`),
    D_CHIPS: view.changeChips(portfolio.kpis.change),
    D_CHART: view.portfolioChart(portfolio.history),
    D_KPIS: view.kpiRows(portfolio.kpis),
    D_ROWS: view.ledgerRows(portfolio, selected?.id),
    D_SUMMARY: view.positionSummary(portfolio),
    D_COUNT: String(portfolio.positions.length),
    D_FOOTER: view.escapeHtml(view.FOOTER_LINE),
    D_BANNER: view.escapeHtml(view.BANNER_LINE),
  };
  let html = await readFile(new URL('../dashboard.html', import.meta.url), 'utf8');
  for (const [marker, content] of Object.entries(replacements)) html = html.replaceAll(`<!-- ${marker} -->`, content);
  return { status: 200, type: 'text/html; charset=utf-8', body: renderPage(html, { settings, origin, path: '/dashboard' }), cacheControl: 'no-cache' };
}

/**
 * Returns a response description for /dashboard and /api/portfolio, or null for any other path.
 * `source` is the signed-in account's book from the demo platform ({ prices, now, positions, facilities, account })
 * or null when signed out: the page then renders the sample set behind the sign-in gate and the API answers 401.
 */
export async function portfolioDocument(url, { prices, now = Date.now, settings, origin = '', quoteCap, source = null }) {
  if (!DASHBOARD_PATHS.has(url.pathname)) return null;
  const options = source ? { ...source, quoteCap } : { prices: await prices(), now: now(), quoteCap };
  if (url.pathname === '/dashboard') return dashboardPage(await getPortfolio(options), { settings, origin });
  if (!source) return jsonDocument({ ok: false, error: { code: 'signed_out', message: 'Sign in to continue.' } }, 401);
  return jsonDocument({ ok: true, ...(await getPortfolio(options)) });
}

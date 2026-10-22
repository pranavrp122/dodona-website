/** Customer dashboard: values the sample account and demo bookings against the price index, and renders the dashboard page. */
import { readFile } from 'node:fs/promises';
import samples from '../data/sample-portfolio.json' with { type: 'json' };
import {
  valueContract, valuationHistory, fleetMark, marketStats, basisFactor, monthlySlices,
  DISCOUNT_RATE, METHOD_VERSION, REGION_FACTORS, CONFIG_FACTORS,
} from './valuation.mjs';
import { renderPage } from './site.mjs';
import { todayUtc } from './contracts.mjs';
import * as view from '../dashboard-view.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const YEAR_MS = 365 * DAY_MS;
const HISTORY_DAYS = 90;
const MAX_BOOKINGS = 20;
const MAX_BOOKINGS_CHARS = 8000;
const PARTNER = Object.freeze({ label: 'Partner neocloud · reserved capacity (simulated)', creditTier: 'Delivery-backed', bondPriceCents: 100 });
const DASHBOARD_PATHS = new Set(['/dashboard', '/api/portfolio']);

export class BookingError extends Error {}

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

function timeValue(position, series, date, quoteCap, intrinsic, hours) {
  if (!quoteCap || !hours) return null;
  try {
    const { gpu, count, start, end, pricePerGpuHour: strike, region, config } = position;
    const quote = quoteCap({ gpu, count, start, end, strike, type: 'call', region, config }, series, { now: date, skipBookingRules: true });
    return Number.isFinite(quote?.premiumPerGpuHour) ? Math.max(quote.premiumPerGpuHour * hours - intrinsic, 0) : null;
  } catch {
    return null;
  }
}

// Call value: intrinsic max(F·b − K, 0) × hours × discount, plus time value from the pricing engine when available.
export function valueCall(position, series, { today, quoteCap = null, stats = marketStats(series) }) {
  const K = position.pricePerGpuHour;
  const basis = basisFactor(position.region, position.config);
  const hours = remainingHours(position, today);
  const todayMs = toMs(today);
  const tMid = hours ? ((Math.max(todayMs, toMs(position.start)) + toMs(position.end)) / 2 - todayMs) / YEAR_MS : 0;
  const forwardFactor = Math.exp(stats.drift * tMid);
  const discountFactor = Math.exp(-DISCOUNT_RATE * tMid);
  const intrinsicFor = spot => Math.max(spot * forwardFactor * basis - K, 0) * hours * discountFactor;
  const intrinsic = intrinsicFor(stats.spot);
  const tv = timeValue(position, series, today, quoteCap, intrinsic, hours);
  const shock = Math.exp(stats.vol * Math.sqrt(tMid));
  const totalHours = position.count * (toMs(position.end) - toMs(position.start)) / HOUR_MS;
  return {
    value: intrinsic + (tv ?? 0),
    low: intrinsicFor(stats.spot / shock) + (tv ?? 0),
    high: intrinsicFor(stats.spot * shock) + (tv ?? 0),
    intrinsic, timeValue: tv,
    remainingHours: hours, remainingCost: hours * K, centsOnDollar: null,
    spot: stats.spot, forwardAvg: stats.spot * forwardFactor * basis, forwardFactor, discountFactor, basis,
    vol: stats.vol, volSampling: stats.volSampling, drift: stats.drift, hazard: 0,
    moneyness: stats.spot * basis - K,
    breakEven: K + position.premiumPerGpuHour,
    premiumPaid: position.premiumPerGpuHour * totalHours,
    totalHours, methodVersion: METHOD_VERSION, asOf: stats.asOf,
    inputs: { today, basis, discountRate: DISCOUNT_RATE, midTenorYears: tMid, timeValueSource: tv == null ? null : 'quoteCap' },
  };
}

function callHistory(position, series, quoteCap) {
  const stats = marketStats(series);
  return series.slice(-HISTORY_DAYS).map(([date, price], i, recent) => {
    const upTo = series.slice(0, series.length - recent.length + i + 1);
    const point = valueCall(position, upTo, { today: date, quoteCap, stats: { ...stats, spot: price, asOf: date } });
    return { date, value: point.value, committedCost: 0 };
  });
}

function phaseOf(position, nowMs) {
  if (toMs(position.end) <= nowMs) return 'used';
  return toMs(position.start) <= nowMs ? 'window' : 'upcoming';
}

// What a finished window saved against the index, day by day.
function usedSaving(position, series) {
  const basis = basisFactor(position.region, position.config);
  const [startDay, endDay] = [position.start.slice(0, 10), position.end.slice(0, 10)];
  return sum(series.filter(([d]) => d >= startDay && d < endDay), ([, price]) => (price * basis - position.pricePerGpuHour) * position.count * 24);
}

function valuePosition(position, prices, { today, nowMs, quoteCap }) {
  const series = prices.data[position.gpu];
  const phase = phaseOf(position, nowMs);
  if (position.kind === 'call') {
    const valuation = valueCall(position, series, { today, quoteCap });
    return { ...position, phase, valuation, history: callHistory(position, series, quoteCap), used: phase === 'used' ? { saving: usedSaving(position, series) } : null };
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

// Validates bookings sent by the browser (sessionStorage.dodonaDemoBookings) and turns them into positions.
export function parseBookings(raw, gpus) {
  if (raw == null || raw === '') return { bookings: [], rejected: 0 };
  if (typeof raw !== 'string' || raw.length > MAX_BOOKINGS_CHARS) throw new BookingError('Bookings must be a JSON array under 8 KB.');
  let list;
  try { list = JSON.parse(raw); } catch { throw new BookingError('Bookings must be a JSON array.'); }
  if (!Array.isArray(list)) throw new BookingError('Bookings must be a JSON array.');
  if (list.length > MAX_BOOKINGS) throw new BookingError(`Send at most ${MAX_BOOKINGS} bookings.`);
  const bookings = list.map((item, i) => toPosition(item, i, gpus)).filter(Boolean);
  return { bookings, rejected: list.length - bookings.length };
}

const finite = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;

function toPosition(item, index, gpus) {
  if (!item || typeof item !== 'object') return null;
  const region = typeof item.region === 'string' ? item.region.replace(/\s*\(.*\)\s*$/, '').trim() : 'US East';
  const config = typeof item.config === 'string' && item.config in CONFIG_FACTORS ? item.config : 'SXM-IB';
  const [start, end] = [Date.parse(item.start), Date.parse(item.end)];
  const kind = item.type === 'call' ? 'call' : item.type === 'lock' ? 'lock' : null;
  const valid = kind && gpus.includes(item.gpu) && region in REGION_FACTORS && Number.isInteger(item.count) && finite(item.count, 1, 4096) &&
    Number.isFinite(start) && Number.isFinite(end) && end > start && end - start <= 400 * DAY_MS &&
    finite(item.strike, 0.01, 100) && (item.premiumPerGpuHour == null || finite(item.premiumPerGpuHour, 0, 100));
  if (!valid) return null;
  const ref = typeof item.ref === 'string' && /^[A-Za-z0-9-]{1,40}$/.test(item.ref) ? item.ref : `booking-${index + 1}`;
  const createdAt = Number.isFinite(Date.parse(item.createdAt)) ? new Date(item.createdAt).toISOString() : new Date(start).toISOString();
  const [startIso, endIso] = [new Date(start).toISOString(), new Date(end).toISOString()];
  return {
    id: `B${index + 1}`, ref, kind, source: 'booking',
    label: `${item.count} ${item.gpu} · ${view.kindLabel(kind).toLowerCase()} · ${view.windowLabel(startIso, endIso)}`,
    gpu: item.gpu, count: item.count, pricePerGpuHour: item.strike, start: startIso, end: endIso,
    region, config, provider: PARTNER, termType: kind === 'call' ? 'call' : 'take-or-pay', status: 'held',
    premiumPerGpuHour: kind === 'call' ? item.premiumPerGpuHour ?? 0 : 0,
    boughtOn: createdAt.slice(0, 10), indexAtPurchase: null, utilisation: 1,
    note: 'Demo booking from this browser session.',
  };
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
  const committedCost = sum(open.filter(p => p.kind !== 'call'), p => p.valuation.remainingCost);
  return [...history, { date: today, value, committedCost, marketValue: committedCost + value }];
}

function nextDeadline(open, nowMs) {
  const next = open.filter(p => p.phase === 'upcoming' && p.kind !== 'offtake' && p.status !== 'listed')
    .map(p => ({ p, at: Date.parse(view.deadlineOf(p)) })).filter(d => d.at > nowMs).sort((a, b) => a.at - b.at)[0];
  if (!next) return null;
  return { date: new Date(next.at).toISOString(), positionId: next.p.id, action: next.p.kind === 'call' ? 'Exercise' : 'Claim', label: next.p.label, days: Math.ceil((next.at - nowMs) / DAY_MS) };
}

function buildKpis(open, history, nowMs) {
  const fixed = open.filter(p => p.kind !== 'call');
  const calls = open.filter(p => p.kind === 'call');
  const cost = sum(fixed, p => p.valuation.remainingCost);
  const change = back => (history.length > back ? history.at(-1).value - history.at(-1 - back).value : 0);
  return {
    remainingCommittedCost: cost,
    optionalAtStrike: sum(calls, p => p.valuation.remainingCost),
    premiumsPaid: sum(calls, p => p.valuation.premiumPaid),
    callCount: calls.length,
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
      text: `${gpu} index ${move >= 0 ? 'up' : 'down'} ${view.percent(Math.abs(move), 1)} this week. Your ${gpu} positions ${effect >= 0 ? 'gained' : 'lost'} about ${view.usd(Math.abs(effect))} in Dodona Value.` };
  });
}

function positionAlerts(open, nowMs) {
  const alerts = [];
  for (const p of open.filter(p => p.phase === 'upcoming' && p.kind !== 'offtake')) {
    const days = Math.ceil((Date.parse(view.deadlineOf(p)) - nowMs) / DAY_MS);
    if (days > 0 && days <= 30) alerts.push({ id: `deadline-${p.id}`, severity: 'warn', kind: 'Deadline', go: `positions/${p.id}`,
      text: `${p.kind === 'call' ? 'Exercise' : 'Claim'} deadline for ${p.label}: ${view.utcStamp(view.deadlineOf(p))} (${days} days).` });
  }
  for (const p of open.filter(p => p.status === 'listed' && p.bestOfferCents)) {
    alerts.push({ id: `offer-${p.id}`, severity: 'offer', kind: 'Offer', go: `positions/${p.id}`,
      text: `Offer received: ${p.bestOfferCents}¢ on your listed ${p.label} (asking ${p.askingCents}¢, Dodona Value ${view.cents(p.valuation.centsOnDollar)}).` });
  }
  for (const p of open.filter(p => p.kind === 'call')) {
    const m = p.valuation.moneyness;
    alerts.push({ id: `cap-${p.id}`, severity: m > 0 ? 'gain' : 'info', kind: 'Price cap', go: `positions/${p.id}`,
      text: m > 0 ? `Your ${p.label} is in the money by ${view.perHour(m)}/GPU-h at today's index.` : `Your ${p.label} is not needed yet: the index is ${view.perHour(-m)} below the cap price.` });
  }
  return alerts;
}

const fleetAlerts = fleets => fleets.filter(f => f.mark.ltvStatus !== 'ok').map(f => ({
  id: `ltv-${f.id}`, severity: f.mark.ltvStatus === 'breach' ? 'loss' : 'warn', kind: 'Collateral', go: 'lender',
  text: `${f.label} (${f.units.toLocaleString('en-US')} ${f.gpu}) is at ${view.percent(f.mark.ltv)} loan-to-value: ${f.mark.ltvStatus}.`,
}));

/**
 * Value the sample account plus any demo bookings.
 *
 * @param {{ prices: object, now?: number, today?: string, bookings?: Array<object>, quoteCap?: Function | null }} options
 *   `quoteCap` undefined loads the pricing engine; null forces intrinsic-only call values.
 */
export async function getPortfolio({ prices, now, today, bookings = [], quoteCap } = {}) {
  const quote = quoteCap === undefined ? await loadQuoteCap() : quoteCap;
  if (!today) today = todayUtc(() => now ?? Date.now());
  const nowMs = now ?? toMs(today) + 12 * HOUR_MS;
  const positions = [...samples.positions, ...bookings].map(p => valuePosition(p, prices, { today, nowMs, quoteCap: quote }));
  const open = positions.filter(p => p.phase !== 'used');
  const history = withToday(portfolioHistory(open), open, today);
  const fleets = samples.facilities.map(f => ({ ...f, mark: fleetMark(f, prices.data[f.gpu], { today }) }));
  const providerStats = marketStats(prices.data[samples.provider.gpu]);
  return {
    asOf: today,
    methodVersion: METHOD_VERSION,
    prices: { asOf: prices.asOf, live: prices.live, source: prices.source },
    pricing: { timeValue: positions.some(p => p.valuation.timeValue != null) ? 'quoteCap' : null },
    note: samples.note,
    account: { ...samples.account },
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
    D_FOOTER: view.escapeHtml(view.FOOTER_LINE),
    D_BANNER: view.escapeHtml(view.BANNER_LINE),
  };
  let html = await readFile(new URL('../dashboard.html', import.meta.url), 'utf8');
  for (const [marker, content] of Object.entries(replacements)) html = html.replaceAll(`<!-- ${marker} -->`, content);
  return { status: 200, type: 'text/html; charset=utf-8', body: renderPage(html, { settings, origin, path: '/dashboard' }), cacheControl: 'no-cache' };
}

// Returns a response description for /dashboard and /api/portfolio, or null for any other path.
export async function portfolioDocument(url, { prices, now = Date.now, settings, origin = '', quoteCap }) {
  if (!DASHBOARD_PATHS.has(url.pathname)) return null;
  const history = await prices();
  const options = { prices: history, now: now(), quoteCap };
  if (url.pathname === '/dashboard') return dashboardPage(await getPortfolio(options), { settings, origin });
  try {
    const { bookings, rejected } = parseBookings(url.searchParams.get('bookings'), Object.keys(history.data));
    return jsonDocument({ ...(await getPortfolio({ ...options, bookings })), rejectedBookings: rejected });
  } catch (error) {
    if (error instanceof BookingError) return jsonDocument({ error: error.message }, 400);
    throw error;
  }
}

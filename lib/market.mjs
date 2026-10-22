/** Market strip data: Ornn index tiles, a Kalshi market-implied monthly curve (display only, never stored) and futures status. */
import { readFile } from 'node:fs/promises';
import { getPriceHistory } from './prices.mjs';
import { marketStats } from './valuation.mjs';
import { renderPage } from './site.mjs';

export const INDEX_GPUS = Object.freeze(['H100', 'H200', 'B200', 'A100']);
export const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2/markets';
// Monthly-average "above $X" ladders that settle on the Ornn index.
export const KALSHI_SERIES = Object.freeze({ B200: 'KXB200MS', H100: 'KXH100MS' });
export const IMPLIED_LABEL = 'Market-implied from Kalshi public prices; display only, not stored';
export const MAX_SPREAD = 0.3;
export const MIN_STRIKES = 3;
export const SPARK_POINTS = 30;

const TEN_MINUTES = 10 * 60 * 1000;
const FAILURE_RETRY_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export const FUTURES = Object.freeze([
  { venue: 'CME / Silicon Data', product: 'H100 and B200 rental index futures', status: 'Filed; CFTC review extended to 9 Nov 2026', source: 'https://www.cftc.gov/filings/ptc/ptc08112615405.pdf' },
  { venue: 'ICE / Ornn', product: 'OCPI H100 and B200 futures', status: 'Announced; no listing date set (29 Sep 2026 notice)', source: 'https://www.ice.com/publicdocs/futures_us/exchange_notices/ICE_Futures_US_Exchange_Notice_ORNN_Compute_4Q2026_20260929.pdf' },
  { venue: 'Kalshi / Robinhood', product: 'Binary price ladders on Ornn OCPI', status: 'Live', source: 'https://www.benzinga.com/markets/prediction-markets/26/08/61411352/kalshi-nvidia-compute-markets' },
]);

const round = (value, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits;

// Last price on or before `days` days before the latest point, as a fractional change.
function changeOver(series, days) {
  const [lastDate, last] = series.at(-1);
  const cutoff = new Date(Date.parse(lastDate + 'T00:00:00Z') - days * DAY_MS).toISOString().slice(0, 10);
  const base = series.findLast(([date]) => date <= cutoff);
  return base ? round(last / base[1] - 1) : null;
}

export function indexTile(series) {
  const { spot, asOf, vol, volSampling } = marketStats(series);
  const recent = series.slice(-SPARK_POINTS);
  return {
    last: spot, asOf,
    change1d: changeOver(series, 1), change7d: changeOver(series, 7), change30d: changeOver(series, 30),
    vol: round(vol), volSampling,
    spark: recent.map(([, price]) => price),
    sparkDates: recent.map(([date]) => date),
  };
}

// "KXB200MS-26NOV" -> "2026-11".
export function eventMonth(eventTicker) {
  const match = /-(\d{2})([A-Z]{3})$/.exec(eventTicker || '');
  const month = match ? MONTHS.indexOf(match[2]) : -1;
  return month < 0 ? null : `20${match[1]}-${String(month + 1).padStart(2, '0')}`;
}

// Pool-adjacent-violators: the closest non-increasing sequence, so P(settle > X) never rises with X.
function nonIncreasing(values) {
  const blocks = [];
  for (const value of values) {
    blocks.push({ sum: value, n: 1 });
    while (blocks.length > 1 && blocks.at(-2).sum / blocks.at(-2).n < blocks.at(-1).sum / blocks.at(-1).n) {
      const top = blocks.pop();
      blocks.at(-1).sum += top.sum;
      blocks.at(-1).n += top.n;
    }
  }
  return blocks.flatMap(({ sum, n }) => Array(n).fill(sum / n));
}

// One month's ladder of "above X" markets -> implied median settle.
// Each yes midpoint is read as P(settle > X); strikes with a bid-ask spread above MAX_SPREAD are dropped.
// The median is where the fitted curve crosses 50%, interpolated linearly between the strikes either side.
export function impliedMedian(markets) {
  const quotes = markets
    .filter(m => m.strike_type === 'greater' && Number.isFinite(Number(m.floor_strike)))
    .map(m => ({ strike: Number(m.floor_strike), bid: Number(m.yes_bid_dollars), ask: Number(m.yes_ask_dollars) }))
    .sort((a, b) => a.strike - b.strike);
  const usable = quotes.filter(q => Number.isFinite(q.bid) && Number.isFinite(q.ask) && q.ask >= q.bid && q.ask - q.bid <= MAX_SPREAD);
  const result = { implied: null, note: null, strikesUsed: usable.length, strikesListed: quotes.length };
  if (usable.length < MIN_STRIKES) return { ...result, note: 'too few tight quotes' };
  const probs = nonIncreasing(usable.map(q => (q.bid + q.ask) / 2));
  if (probs[0] < 0.5) return { ...result, note: `below $${usable[0].strike.toFixed(2)}` };
  const i = probs.findIndex(p => p < 0.5);
  if (i < 0) return { ...result, note: `above $${usable.at(-1).strike.toFixed(2)}, no tight quotes higher` };
  const [k0, k1, p0, p1] = [usable[i - 1].strike, usable[i].strike, probs[i - 1], probs[i]];
  return { ...result, implied: round(k0 + (p0 - 0.5) / (p0 - p1) * (k1 - k0), 2) };
}

// All open markets of one series -> one row per expiry month with enough tight quotes, or null.
export function impliedCurve(markets) {
  const byMonth = new Map();
  for (const market of markets) {
    const month = eventMonth(market.event_ticker);
    if (month) byMonth.set(month, [...(byMonth.get(month) || []), market]);
  }
  const rows = [...byMonth].sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([month, ladder]) => ({ month, ...impliedMedian(ladder) }))
    .filter(row => row.strikesUsed >= MIN_STRIKES);
  return rows.length ? rows : null;
}

export function createKalshiSource({ fetchImpl = fetch, now = Date.now, ttlMs = TEN_MINUTES, timeoutMs = 5000, logger = console } = {}) {
  let cached = null;
  let inFlight = null;

  async function fetchSeries(series) {
    const url = `${KALSHI_BASE}?series_ticker=${encodeURIComponent(series)}&status=open&limit=1000`;
    const response = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`Kalshi request failed with ${response.status}.`);
    const body = await response.json();
    if (!Array.isArray(body?.markets)) throw new Error('Unexpected Kalshi response.');
    return body.markets;
  }

  async function load() {
    const asOf = new Date(now()).toISOString();
    try {
      const entries = await Promise.all(Object.entries(KALSHI_SERIES).map(async ([gpu, series]) => [gpu, impliedCurve(await fetchSeries(series))]));
      return { value: { asOf, ...Object.fromEntries(entries), error: null }, until: now() + ttlMs };
    } catch (error) {
      logger.error('[market] Kalshi public prices unavailable.');
      const reason = error?.name === 'TimeoutError' ? 'Kalshi did not respond in time.' : error?.message || 'Kalshi request failed.';
      return { value: { asOf, B200: null, H100: null, error: reason }, until: now() + Math.min(ttlMs, FAILURE_RETRY_MS) };
    }
  }

  // In-memory only: the ladders are reduced to medians and never written to disk.
  return async function getImplied() {
    if (cached && now() < cached.until) return cached.value;
    if (!inFlight) inFlight = load().then(result => { cached = result; inFlight = null; return result.value; });
    return inFlight;
  };
}

export function createMarketSource({ prices = getPriceHistory, implied = createKalshiSource() } = {}) {
  return async function getMarket() {
    const [history, kalshi] = await Promise.all([prices(), implied()]);
    const gpus = INDEX_GPUS.filter(gpu => history.data[gpu]?.length >= 2);
    return {
      asOf: history.asOf,
      live: history.live,
      index: Object.fromEntries(gpus.map(gpu => [gpu, indexTile(history.data[gpu])])),
      implied: { source: 'kalshi-public', label: IMPLIED_LABEL, ...kalshi },
      futures: FUTURES,
    };
  };
}

// Serves /methodology through renderPage so the shared header, contact and canonical tags apply.
export async function handleMethodology(request, response, { settings, origin }) {
  const html = await readFile(new URL('../methodology.html', import.meta.url), 'utf8');
  const content = Buffer.from(renderPage(html, { settings, origin, path: '/methodology' }));
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': content.length, 'Cache-Control': 'no-cache' });
  response.end(request.method === 'HEAD' ? undefined : content);
}

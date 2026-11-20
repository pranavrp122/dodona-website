/** Market strip data: Ornn index tiles and futures status for every page; a Kalshi market-implied view only on request, never stored. */
import { readFile } from 'node:fs/promises';
import { getPriceHistory } from './prices.mjs';
import { marketStats } from './valuation.mjs';
import { renderPage } from './site.mjs';

export const INDEX_GPUS = Object.freeze(['H100', 'H200', 'B200', 'A100']);
export const KALSHI_API = 'https://api.elections.kalshi.com/trade-api/v2';
// Monthly-average "above $X" ladders that settle on the Ornn index.
export const KALSHI_SERIES = Object.freeze({ B200: 'KXB200MS', H100: 'KXH100MS' });
export const impliedLabel = asOf => `Market-implied from Kalshi public quotes at ${asOf.slice(11, 16)} UTC · display only · not stored · not a Dodona price`;
export const IMPLIED_NOTE = 'Order books are thin past November, so later months are rough. Last trades can be weeks old.';
export const MAX_SPREAD = 0.2;
export const SPARK_POINTS = 30;
const TRADE_LOOKUPS_AT_ONCE = 2;
const MAX_RETRIES = 3;

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

// Forces P(settle > X) to be non-increasing in X by carrying the running minimum up the ladder.
const runningMin = points => {
  let floor = Infinity;
  return points.map(point => ({ ...point, p: (floor = Math.min(floor, point.p)) }));
};

// Strike where the survival curve crosses 50%, by linear interpolation; null when it never crosses inside the ladder.
function crossing(points) {
  const curve = runningMin(points);
  const i = curve.findIndex(point => point.p < 0.5);
  if (i < 1) return null;
  const [lo, hi] = [curve[i - 1], curve[i]];
  return { value: round(lo.strike + (lo.p - 0.5) / (lo.p - hi.p) * (hi.strike - lo.strike), 2), lo, hi };
}

// One month's ladder of "above X" markets -> three views of the median monthly-average settle.
// 1. Tight mids: yes bid/ask midpoints read as P(settle > X), spreads above MAX_SPREAD dropped.
// 2. Bid/ask bracket: a yes bid >= 0.50 at X says the median is at least X; a yes ask <= 0.50 says at most X.
// 3. Last trade: the same crossing on last traded prices, which can be stale (the source adds the trade date).
export function monthView(markets) {
  const quotes = markets
    .filter(m => m.strike_type === 'greater' && Number.isFinite(Number(m.floor_strike)))
    .map(m => ({
      ticker: m.ticker, strike: Number(m.floor_strike), bid: Number(m.yes_bid_dollars), ask: Number(m.yes_ask_dollars),
      last: Number(m.last_price_dollars), volume: Number(m.volume_fp ?? m.volume),
    }))
    .sort((x, y) => x.strike - y.strike);
  const tight = quotes.filter(q => q.ask >= q.bid && q.ask - q.bid <= MAX_SPREAD);
  const median = crossing(tight.map(q => ({ strike: q.strike, p: (q.bid + q.ask) / 2 })));
  const low = quotes.filter(q => q.bid >= 0.5).at(-1)?.strike ?? null;
  const high = quotes.find(q => q.ask > 0 && q.ask <= 0.5 && (low === null || q.strike > low))?.strike ?? null;
  const traded = crossing(quotes.filter(q => q.last > 0 && q.volume > 0).map(q => ({ strike: q.strike, p: q.last, ticker: q.ticker })));
  return {
    implied: median?.value ?? null,
    strikesTight: tight.length,
    strikesListed: quotes.length,
    bracketLow: low,
    bracketHigh: high,
    lastTradeMedian: traded?.value ?? null,
    lastTradeTickers: traded ? [traded.lo.ticker, traded.hi.ticker] : [],
  };
}

// All open markets of one series -> one row per expiry month that says anything, or null.
export function impliedCurve(markets) {
  const byMonth = new Map();
  for (const market of markets) {
    const month = eventMonth(market.event_ticker);
    if (month) byMonth.set(month, [...(byMonth.get(month) || []), market]);
  }
  const rows = [...byMonth].sort(([x], [y]) => (x < y ? -1 : 1))
    .map(([month, ladder]) => ({ month, ...monthView(ladder) }))
    .filter(row => [row.implied, row.bracketLow, row.bracketHigh, row.lastTradeMedian].some(value => value !== null));
  return rows.length ? rows : null;
}

async function inBatches(items, size, task) {
  const results = [];
  for (let i = 0; i < items.length; i += size) results.push(...await Promise.all(items.slice(i, i + size).map(task)));
  return results;
}

export function createKalshiSource({ fetchImpl = fetch, now = Date.now, ttlMs = TEN_MINUTES, timeoutMs = 5000, backoffMs = 400, logger = console } = {}) {
  let cached = null;
  let inFlight = null;

  // Backs off exponentially on 429, as Kalshi's developer terms ask.
  async function getJson(path, attempt = 0) {
    const response = await fetchImpl(KALSHI_API + path, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (response.status === 429 && attempt < MAX_RETRIES) {
      await new Promise(done => setTimeout(done, backoffMs * 2 ** attempt));
      return getJson(path, attempt + 1);
    }
    if (!response.ok) throw new Error(`Kalshi request failed with ${response.status}.`);
    return response.json();
  }

  async function fetchLadder(series) {
    const body = await getJson(`/markets?series_ticker=${encodeURIComponent(series)}&status=open&limit=1000`);
    if (!Array.isArray(body?.markets)) throw new Error('Unexpected Kalshi response.');
    return body.markets;
  }

  // Latest trade time for one strike; null when unknown, so a missing date never blocks the view.
  async function lastTradeAt(ticker) {
    try {
      const body = await getJson(`/markets/trades?ticker=${encodeURIComponent(ticker)}&limit=1`);
      const time = body?.trades?.[0]?.created_time;
      return typeof time === 'string' && !Number.isNaN(Date.parse(time)) ? time : null;
    } catch {
      return null;
    }
  }

  // A last-trade median is only as fresh as the older of the two strikes it sits between.
  async function datedRow({ lastTradeTickers, ...row }) {
    const times = await Promise.all(lastTradeTickers.map(lastTradeAt));
    const known = times.filter(Boolean).sort();
    return { ...row, lastTradeAt: known.length && known.length === times.length ? known[0] : null };
  }

  const undated = rows => rows && rows.map(({ lastTradeTickers, ...row }) => ({ ...row, lastTradeAt: null }));

  async function load() {
    const asOf = new Date(now()).toISOString();
    try {
      const ladders = await Promise.all(Object.entries(KALSHI_SERIES).map(async ([gpu, series]) => [gpu, impliedCurve(await fetchLadder(series))]));
      const value = { asOf, ...Object.fromEntries(ladders.map(([gpu, rows]) => [gpu, undated(rows)])), error: null, tradeDates: 'pending' };
      // Trade dates cost one call per strike, so they are filled after the curve is served, a few calls at a time.
      const fill = async () => {
        const dated = [];
        for (const [gpu, rows] of ladders) dated.push([gpu, rows && await inBatches(rows, TRADE_LOOKUPS_AT_ONCE, datedRow)]);
        return { ...value, ...Object.fromEntries(dated), tradeDates: 'ready' };
      };
      return { value, fill, until: now() + ttlMs };
    } catch (error) {
      logger.error('[market] Kalshi public prices unavailable.');
      const reason = error?.name === 'TimeoutError' ? 'Kalshi did not respond in time.' : error?.message || 'Kalshi request failed.';
      return { value: { asOf, B200: null, H100: null, error: reason }, until: now() + Math.min(ttlMs, FAILURE_RETRY_MS) };
    }
  }

  // In-memory only: ladders are reduced to a few numbers per month and never written to disk or logs.
  return async function getImplied() {
    if (cached && now() < cached.until) return cached.value;
    if (!inFlight) {
      inFlight = load().then(result => {
        cached = result;
        inFlight = null;
        result.fill?.().then(value => { if (cached === result) cached = { ...result, value }; }, () => {});
        return result.value;
      });
    }
    return inFlight;
  };
}

// Public pages get the index and futures only. The Kalshi view is fetched only when asked for, by the signed-in demo dashboard.
export function createMarketSource({ prices = getPriceHistory, implied = createKalshiSource() } = {}) {
  return async function getMarket({ implied: withImplied = false } = {}) {
    const [history, kalshi] = await Promise.all([prices(), withImplied ? implied() : null]);
    const gpus = INDEX_GPUS.filter(gpu => history.data[gpu]?.length >= 2);
    return {
      asOf: history.asOf,
      live: history.live,
      index: Object.fromEntries(gpus.map(gpu => [gpu, indexTile(history.data[gpu])])),
      ...(kalshi && { implied: { source: 'kalshi-public', label: impliedLabel(kalshi.asOf), note: IMPLIED_NOTE, ...kalshi } }),
      futures: FUTURES,
    };
  };
}

// GET /api/market: `?implied=1` adds the Kalshi view and is never cached by browsers or proxies.
export async function handleMarket(url, response, market, json) {
  const withImplied = url.searchParams.get('implied') === '1';
  return json(response, 200, await market({ implied: withImplied }), withImplied ? {} : { 'Cache-Control': 'public, max-age=300' });
}

// Serves /methodology through renderPage so the shared header, contact and canonical tags apply.
export async function handleMethodology(request, response, { settings, origin }) {
  const html = await readFile(new URL('../methodology.html', import.meta.url), 'utf8');
  const content = Buffer.from(renderPage(html, { settings, origin, path: '/methodology' }));
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': content.length, 'Cache-Control': 'no-cache' });
  response.end(request.method === 'HEAD' ? undefined : content);
}

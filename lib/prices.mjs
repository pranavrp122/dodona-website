/** Daily GPU rental price index from Ornn, fetched server-side and cached, with an embedded fallback. */
import fallbackData from '../data/ornn-index.json' with { type: 'json' };

export const GPU_API_NAMES = Object.freeze({
  'H100': 'H100 SXM',
  'H200': 'H200',
  'B200': 'B200',
  'A100': 'A100 SXM4',
  'RTX 5090': 'RTX 5090',
});

const ORNN_BASE = 'https://api.ornnai.com/api/gpu/';
const HOUR_MS = 60 * 60 * 1000;
const FAILURE_RETRY_MS = 5 * 60 * 1000;
const MIN_POINTS = 2;

const latestDate = data => Object.values(data).reduce((latest, series) => {
  const last = series.at(-1)?.[0] || '';
  return last > latest ? last : latest;
}, '');

// Turns one Ornn response into sorted [date, price] pairs, one per UTC day.
export function parseIndexHistory(body) {
  if (!body || body.success !== true || !Array.isArray(body.data)) throw new Error('Unexpected index response.');
  const byDate = new Map();
  for (const point of body.data) {
    const value = Number(point?.index_value);
    const date = typeof point?.timestamp === 'string' ? point.timestamp.slice(0, 10) : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(value) || value <= 0) continue;
    byDate.set(date, value);
  }
  const series = [...byDate].sort(([a], [b]) => (a < b ? -1 : 1));
  if (series.length < MIN_POINTS) throw new Error('Index response has too few points.');
  return series;
}

export function fallbackHistory() {
  return { asOf: latestDate(fallbackData), source: 'ornn', live: false, data: fallbackData };
}

export function createPriceSource({ fetchImpl = fetch, now = Date.now, ttlMs = HOUR_MS, timeoutMs = 5000, logger = console } = {}) {
  let cached = null;
  let inFlight = null;

  async function fetchSeries(apiName) {
    const response = await fetchImpl(ORNN_BASE + encodeURIComponent(apiName) + '/index-history', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`Index request failed with ${response.status}.`);
    return parseIndexHistory(await response.json());
  }

  async function load() {
    try {
      const entries = await Promise.all(Object.entries(GPU_API_NAMES).map(async ([gpu, apiName]) => [gpu, await fetchSeries(apiName)]));
      const data = Object.fromEntries(entries);
      return { value: { asOf: latestDate(data), source: 'ornn', live: true, data }, until: now() + ttlMs };
    } catch {
      logger.error('[prices] Live index unavailable; serving the embedded fallback.');
      return { value: fallbackHistory(), until: now() + Math.min(ttlMs, FAILURE_RETRY_MS) };
    }
  }

  return async function getPriceHistory() {
    if (cached && now() < cached.until) return cached.value;
    if (!inFlight) inFlight = load().then(result => { cached = result; inFlight = null; return result.value; });
    return inFlight;
  };
}

export const getPriceHistory = createPriceSource();

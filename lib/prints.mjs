/** Index prints per account: real Ornn daily points up to the as-of date, then deterministic synthetic points by scenario. */
import { createHash } from 'node:crypto';
import { marketStats } from './valuation.mjs';
import { all, get, insert, transaction } from './db.mjs';

export const SCENARIOS = Object.freeze(['market', 'rise', 'fall', 'spike', 'flat']);
const DAY_MS = 24 * 3600 * 1000;
const HORIZON_PAD_DAYS = 45;

const addDays = (date, n) => new Date(Date.parse(date + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY_MS);

function seededRandom(seedText) {
  let a = createHash('sha256').update(seedText).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(random) {
  const u = Math.max(random(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

// Multiplier on the last real print, day i after the as-of date, for the scripted scenarios.
const TRENDS = Object.freeze({
  rise: i => 1 + 0.35 * Math.min(i / 60, 1),
  fall: i => 1 - 0.25 * Math.min(i / 60, 1),
  spike: i => (i <= 10 ? 1 + 0.06 * i : i <= 20 ? 1 + 0.06 * (20 - i) : 1),
  flat: () => 1,
});

/**
 * Synthetic daily points for `days` days after the last real print. `market` continues the fitted drift and
 * weekly volatility as a random walk; the scripted scenarios follow their trend with small noise.
 */
export function syntheticSeries(real, { seed, scenario, days }) {
  const stats = marketStats(real);
  const [lastDate, lastPrice] = real.at(-1);
  const random = seededRandom(`${seed}|${scenario}`);
  const sigma = stats.vol / Math.sqrt(365);
  const points = [];
  let logPrice = Math.log(lastPrice);
  for (let i = 1; i <= days; i++) {
    const z = normal(random);
    let price;
    if (scenario === 'market') {
      logPrice += stats.drift / 365 - sigma * sigma / 2 + sigma * z;
      price = Math.exp(logPrice);
    } else {
      price = lastPrice * TRENDS[scenario](i) * Math.exp(sigma * (scenario === 'flat' ? 0.15 : 0.35) * z);
    }
    points.push([addDays(lastDate, i), Math.round(price * 10000) / 10000]);
  }
  return points;
}

/** Makes sure the account has stored synthetic prints for every GPU up to `untilDate` in its current scenario. */
export function ensurePrints(db, account, history, untilDate) {
  transaction(db, () => {
    for (const [gpu, real] of Object.entries(history.data)) {
      const stored = get(db, 'SELECT MAX(date) AS last, MIN(scenario) AS a, MAX(scenario) AS b FROM prints WHERE account_id = ? AND gpu = ?', account.id, gpu);
      const fresh = stored.last && stored.a === account.scenario && stored.b === account.scenario && stored.last >= untilDate;
      if (fresh) continue;
      db.prepare('DELETE FROM prints WHERE account_id = ? AND gpu = ?').run(account.id, gpu);
      const days = Math.max(daysBetween(real.at(-1)[0], untilDate), 0) + HORIZON_PAD_DAYS;
      const at = new Date().toISOString();
      for (const [date, price] of syntheticSeries(real, { seed: `${account.id}|${gpu}`, scenario: account.scenario, days })) {
        insert(db, 'prints', { account_id: account.id, gpu, scenario: account.scenario, date, price }, at);
      }
    }
  });
}

/** Real points plus the account's synthetic points after the real as-of date, up to and including `upToDate`. */
export function composedSeries(db, account, history, gpu, upToDate) {
  const real = history.data[gpu];
  if (!real) return null;
  const lastReal = real.at(-1)[0];
  const synthetic = all(db, 'SELECT date, price FROM prints WHERE account_id = ? AND gpu = ? AND date > ? AND date <= ? ORDER BY date', account.id, gpu, lastReal, upToDate)
    .map(row => [row.date, row.price]);
  return [...real.filter(([date]) => date <= upToDate), ...synthetic];
}

/** A price history object (same shape as getPriceHistory) as the account sees it at its demo clock. */
export function accountPrices(db, account, history, atIso = account.demo_now) {
  const upTo = atIso.slice(0, 10);
  ensurePrints(db, account, history, upTo);
  const data = Object.fromEntries(Object.keys(history.data).map(gpu => [gpu, composedSeries(db, account, history, gpu, upTo)]));
  return { asOf: history.asOf, live: history.live, source: history.source, data, demoDate: upTo };
}

/** Points for GET /api/index: each flagged synthetic or real. */
export function indexPoints(db, account, history, gpu, from, to) {
  const real = history.data[gpu];
  const lastReal = real.at(-1)[0];
  let series = real;
  if (account) {
    ensurePrints(db, account, history, to);
    series = composedSeries(db, account, history, gpu, to);
  }
  return series.filter(([date]) => date >= from && date <= to).map(([date, price]) => ({ date, price, synthetic: date > lastReal }));
}

export { addDays };

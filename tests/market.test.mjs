import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { fallbackHistory } from '../lib/prices.mjs';
import { createKalshiSource, createMarketSource, eventMonth, impliedMedian, impliedCurve, indexTile, IMPLIED_LABEL, KALSHI_SERIES } from '../lib/market.mjs';
import { listen, close } from './fixture.mjs';

const settings = { operatorName: 'Test fixture operator', contactEmail: 'fixture@example.invalid', retentionDays: null };
const quiet = { error() {} };

// Synthetic ladder: P(settle > X) falls linearly from 0.9 at $7 to 0.1 at $11, so the median is $9.
const ladder = (event, spread = 0.04) => [7, 8, 9, 10, 11].map((strike, i) => {
  const mid = 0.9 - i * 0.2;
  return { event_ticker: event, strike_type: 'greater', floor_strike: strike, yes_bid_dollars: (mid - spread / 2).toFixed(4), yes_ask_dollars: (mid + spread / 2).toFixed(4) };
});

function stubFetch(markets, calls = []) {
  return async url => {
    calls.push(url);
    const series = new URL(url).searchParams.get('series_ticker');
    return new Response(JSON.stringify({ markets: markets[series] || [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

test('event tickers map to expiry months', () => {
  assert.equal(eventMonth('KXB200MS-26NOV'), '2026-11');
  assert.equal(eventMonth('KXH100MS-27JAN'), '2027-01');
  assert.equal(eventMonth('KXB200MS'), null);
});

test('implied median interpolates the 50% crossing of the ladder', () => {
  const row = impliedMedian(ladder('KXB200MS-26NOV'));
  assert.equal(row.implied, 9);
  assert.equal(row.strikesUsed, 5);
});

test('wide spreads are dropped and a non-monotone ladder is smoothed', () => {
  const markets = ladder('KXB200MS-26NOV');
  markets.push({ event_ticker: 'KXB200MS-26NOV', strike_type: 'greater', floor_strike: 12, yes_bid_dollars: '0.0000', yes_ask_dollars: '1.0000' });
  markets[3] = { ...markets[3], yes_bid_dollars: '0.5300', yes_ask_dollars: '0.5700' }; // $10 priced above $9's 0.5
  const row = impliedMedian(markets);
  assert.equal(row.strikesListed, 6);
  assert.equal(row.strikesUsed, 5);
  assert.ok(row.implied > 9 && row.implied < 11, `got ${row.implied}`);
});

test('a ladder that never crosses 50% reports a bound, not a number', () => {
  const high = [3, 4, 5].map(strike => ({ event_ticker: 'X-27MAR', strike_type: 'greater', floor_strike: strike, yes_bid_dollars: '0.8000', yes_ask_dollars: '0.9000' }));
  const row = impliedMedian(high);
  assert.equal(row.implied, null);
  assert.match(row.note, /^above \$5\.00/);
  assert.equal(impliedMedian(high.slice(0, 2)).note, 'too few tight quotes');
});

test('impliedCurve sorts months and returns null when no month is readable', () => {
  const curve = impliedCurve([...ladder('KXB200MS-27JAN'), ...ladder('KXB200MS-26NOV')]);
  assert.deepEqual(curve.map(row => row.month), ['2026-11', '2027-01']);
  assert.equal(impliedCurve(ladder('KXB200MS-26NOV', 0.5)), null);
});

test('index tiles carry last price, changes, vol and a 30-point sparkline', () => {
  const tile = indexTile(fallbackHistory().data.H100);
  assert.equal(tile.spark.length, 30);
  assert.equal(tile.sparkDates.length, 30);
  assert.equal(tile.last, tile.spark.at(-1));
  for (const key of ['change1d', 'change7d', 'change30d', 'vol']) assert.equal(typeof tile[key], 'number', key);
  assert.equal(tile.volSampling, 'weekly');
});

test('the Kalshi source caches for ten minutes and reports failures without throwing', async () => {
  let time = 0;
  const calls = [];
  const series = Object.keys(KALSHI_SERIES).length;
  const source = createKalshiSource({ fetchImpl: stubFetch({ KXB200MS: ladder('KXB200MS-26NOV') }, calls), now: () => time, logger: quiet });
  const first = await source();
  assert.equal(first.error, null);
  assert.equal(first.B200[0].implied, 9);
  assert.equal(first.H100, null);
  await source();
  assert.equal(calls.length, series);
  time += 10 * 60 * 1000 + 1;
  await source();
  assert.equal(calls.length, 2 * series);

  const failing = createKalshiSource({ fetchImpl: async () => new Response('nope', { status: 503 }), logger: quiet });
  const failed = await failing();
  assert.match(failed.error, /503/);
  assert.equal(failed.B200, null);
});

async function appWithStubs(t, fetchImpl) {
  const prices = async () => fallbackHistory();
  const implied = createKalshiSource({ fetchImpl, logger: quiet });
  const server = createApp({ store: null, prices, siteSettings: settings, market: createMarketSource({ prices, implied }) });
  const origin = await listen(server);
  t.after(() => close(server));
  return origin;
}

test('GET /api/market returns the agreed shape with stubbed prices and Kalshi', async t => {
  const origin = await appWithStubs(t, stubFetch({ KXB200MS: ladder('KXB200MS-26NOV') }));
  const response = await fetch(origin + '/api/market');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=300');
  const body = await response.json();
  assert.equal(body.asOf, fallbackHistory().asOf);
  assert.deepEqual(Object.keys(body.index), ['H100', 'H200', 'B200', 'A100']);
  assert.equal(body.implied.source, 'kalshi-public');
  assert.equal(body.implied.label, IMPLIED_LABEL);
  assert.deepEqual(body.implied.B200.map(({ month, implied }) => ({ month, implied })), [{ month: '2026-11', implied: 9 }]);
  assert.equal(body.implied.H100, null);
  assert.equal(body.implied.error, null);
  assert.equal(body.futures.length, 3);
  for (const item of body.futures) assert.match(item.source, /^https:\/\//);
});

test('GET /api/market keeps the index when Kalshi is down', async t => {
  const origin = await appWithStubs(t, async () => { throw new TypeError('fetch failed'); });
  const body = await (await fetch(origin + '/api/market')).json();
  assert.equal(body.implied.error, 'fetch failed');
  assert.equal(body.index.B200.spark.length, 30);
});

test('/methodology renders the method page with its key headings', async t => {
  const origin = await appWithStubs(t, stubFetch({}));
  const response = await fetch(origin + '/methodology');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html/);
  const html = await response.text();
  for (const heading of ['What Dodona Value is', 'Inputs', 'The formula', 'How caps are priced', 'Versioning', 'Limits', 'Data rights', 'Contact']) {
    assert.match(html, new RegExp(`<h2[^>]*>${heading}</h2>`), heading);
  }
  assert.match(html, /not licensed for commercial valuation/);
  assert.doesNotMatch(html, /Coming soon/);
  assert.doesNotMatch(html, /buyback|book-out|cash settlement|sell back|offshore/i);
});

test('the market strip is on the home and contract values pages, with no-JS text', async t => {
  const origin = await appWithStubs(t, stubFetch({}));
  for (const path of ['/', '/contracts']) {
    const html = await (await fetch(origin + path)).text();
    assert.match(html, /<section class="mk-sec" id="market-strip"/, path);
    assert.match(html, /Market data loads with JavaScript/, path);
    assert.match(html, /<script src="\/market\.js" defer><\/script>/, path);
  }
  for (const path of ['/market.js', '/market.css']) assert.equal((await fetch(origin + path)).status, 200, path);
  assert.match(await (await fetch(origin + '/contracts')).text(), /<a href="\/methodology">Methodology<\/a>/);
});

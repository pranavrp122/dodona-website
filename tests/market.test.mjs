import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { fallbackHistory } from '../lib/prices.mjs';
import { createKalshiSource, createMarketSource, eventMonth, monthView, impliedCurve, indexTile, KALSHI_SERIES } from '../lib/market.mjs';
import { listen, close } from './fixture.mjs';

const settings = { operatorName: 'Test fixture operator', contactEmail: 'fixture@example.invalid', retentionDays: null };
const quiet = { error() {} };
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

// Synthetic ladder: P(settle > X) falls linearly from 0.9 at $7 to 0.1 at $11, so every median is $9.
const ladder = (event, spread = 0.04) => [7, 8, 9, 10, 11].map((strike, i) => {
  const mid = 0.9 - i * 0.2;
  return {
    ticker: `${event}-${strike.toFixed(3)}`, event_ticker: event, strike_type: 'greater', floor_strike: strike,
    yes_bid_dollars: (mid - spread / 2).toFixed(4), yes_ask_dollars: (mid + spread / 2).toFixed(4),
    last_price_dollars: mid.toFixed(4), volume_fp: '10.00',
  };
});

function stubFetch(markets, calls = []) {
  return async url => {
    calls.push(url);
    const query = new URL(url).searchParams;
    const body = url.includes('/markets/trades')
      ? { trades: [{ ticker: query.get('ticker'), created_time: query.get('ticker').endsWith('9.000') ? '2026-10-04T10:00:00Z' : '2026-10-09T10:00:00Z' }] }
      : { markets: markets[query.get('series_ticker')] || [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

test('event tickers map to expiry months', () => {
  assert.equal(eventMonth('KXB200MS-26NOV'), '2026-11');
  assert.equal(eventMonth('KXH100MS-27JAN'), '2027-01');
  assert.equal(eventMonth('KXB200MS'), null);
});

test('a month gives a tight-quote median, a bid/ask bracket and a last-trade median', () => {
  const row = monthView(ladder('KXB200MS-26NOV'));
  assert.equal(row.implied, 9);
  assert.equal(row.strikesTight, 5);
  assert.equal(row.bracketLow, 8); // bid 0.68 at $8; bid 0.48 at $9 is below even money
  assert.equal(row.bracketHigh, 10); // ask 0.32 at $10; ask 0.52 at $9 is above even money
  assert.equal(row.lastTradeMedian, 9);
  assert.deepEqual(row.lastTradeTickers, ['KXB200MS-26NOV-9.000', 'KXB200MS-26NOV-10.000']);
});

test('wide spreads are dropped and a rising price is held at the running minimum', () => {
  const markets = ladder('KXB200MS-26NOV');
  markets.push({ ...markets[0], ticker: 'X', floor_strike: 12, yes_bid_dollars: '0.0000', yes_ask_dollars: '1.0000', last_price_dollars: '0', volume_fp: '0' });
  markets[3] = { ...markets[3], yes_bid_dollars: '0.5300', yes_ask_dollars: '0.5700' }; // $10 priced above $9
  const row = monthView(markets);
  assert.equal(row.strikesListed, 6);
  assert.equal(row.strikesTight, 5);
  assert.equal(row.implied, 10); // $10 is held at $9's 0.50, so the curve first drops below 50% after $10
});

test('thin books still give a bracket when no median is computable', () => {
  const thin = [3, 4, 5].map(strike => ({ ticker: `T-${strike}`, event_ticker: 'X-27MAR', strike_type: 'greater', floor_strike: strike, yes_bid_dollars: strike === 4 ? '0.5500' : '0.0000', yes_ask_dollars: '1.0000', last_price_dollars: '0', volume_fp: '0' }));
  const row = monthView(thin);
  assert.equal(row.implied, null);
  assert.equal(row.bracketLow, 4);
  assert.equal(row.bracketHigh, null);
  assert.equal(row.lastTradeMedian, null);
});

test('impliedCurve sorts months and drops months that say nothing', () => {
  const empty = ladder('KXB200MS-27FEB').map(m => ({ ...m, yes_bid_dollars: '0.0000', yes_ask_dollars: '1.0000', last_price_dollars: '0' }));
  const curve = impliedCurve([...ladder('KXB200MS-27JAN'), ...empty, ...ladder('KXB200MS-26NOV')]);
  assert.deepEqual(curve.map(row => row.month), ['2026-11', '2027-01']);
  assert.equal(impliedCurve(empty), null);
});

test('index tiles carry last price, changes, vol and a 30-point sparkline', () => {
  const tile = indexTile(fallbackHistory().data.H100);
  assert.equal(tile.spark.length, 30);
  assert.equal(tile.sparkDates.length, 30);
  assert.equal(tile.last, tile.spark.at(-1));
  for (const key of ['change1d', 'change7d', 'change30d', 'vol']) assert.equal(typeof tile[key], 'number', key);
  assert.equal(tile.volSampling, 'weekly');
});

test('the Kalshi source serves the curve at once, fills trade dates after, and caches for ten minutes', async () => {
  let time = 0;
  const calls = [];
  const source = createKalshiSource({ fetchImpl: stubFetch({ KXB200MS: ladder('KXB200MS-26NOV') }, calls), now: () => time, logger: quiet });
  const first = await source();
  assert.equal(first.error, null);
  assert.equal(first.tradeDates, 'pending');
  assert.equal(first.B200[0].lastTradeAt, null);
  assert.equal('lastTradeTickers' in first.B200[0], false);
  assert.equal(first.H100, null);
  await settle();
  const second = await source();
  assert.equal(second.tradeDates, 'ready');
  assert.equal(second.B200[0].lastTradeAt, '2026-10-04T10:00:00Z'); // the older of the two strikes
  const ladderCalls = calls.filter(url => !url.includes('/trades')).length;
  assert.equal(ladderCalls, Object.keys(KALSHI_SERIES).length);
  time += 10 * 60 * 1000 + 1;
  await source();
  assert.equal(calls.filter(url => !url.includes('/trades')).length, 2 * ladderCalls);
});

test('the Kalshi source backs off on 429 and reports failures without throwing', async () => {
  let attempts = 0;
  const busy = async url => (++attempts < 3 ? new Response('slow down', { status: 429 }) : stubFetch({ KXB200MS: ladder('KXB200MS-26NOV') })(url));
  const recovered = await createKalshiSource({ fetchImpl: busy, backoffMs: 1, logger: quiet })();
  assert.equal(recovered.error, null);

  const failed = await createKalshiSource({ fetchImpl: async () => new Response('nope', { status: 503 }), logger: quiet })();
  assert.match(failed.error, /503/);
  assert.equal(failed.B200, null);
});

async function appWithStubs(t, fetchImpl, calls) {
  const prices = async () => fallbackHistory();
  const counted = async (...args) => { calls?.push(args[0]); return fetchImpl(...args); };
  const implied = createKalshiSource({ fetchImpl: counted, logger: quiet });
  const server = createApp({ store: null, prices, siteSettings: settings, market: createMarketSource({ prices, implied }) });
  const origin = await listen(server);
  t.after(() => close(server));
  return origin;
}

test('GET /api/market leaves Kalshi out unless implied=1 is asked for', async t => {
  const calls = [];
  const origin = await appWithStubs(t, stubFetch({ KXB200MS: ladder('KXB200MS-26NOV') }), calls);
  const response = await fetch(origin + '/api/market');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=300');
  const body = await response.json();
  assert.equal(body.asOf, fallbackHistory().asOf);
  assert.deepEqual(Object.keys(body.index), ['H100', 'H200', 'B200', 'A100']);
  assert.equal('implied' in body, false);
  assert.equal(body.futures.length, 3);
  for (const item of body.futures) assert.match(item.source, /^https:\/\//);
  assert.equal(calls.length, 0, 'public requests never call Kalshi');
});

test('GET /api/market?implied=1 adds the Kalshi view and is not cached', async t => {
  const origin = await appWithStubs(t, stubFetch({ KXB200MS: ladder('KXB200MS-26NOV') }));
  const response = await fetch(origin + '/api/market?implied=1');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.implied.source, 'kalshi-public');
  assert.match(body.implied.label, /^Market-implied from Kalshi public quotes at \d{2}:\d{2} UTC · display only · not stored · not a Dodona price$/);
  assert.match(body.implied.note, /thin past November/);
  const [row] = body.implied.B200;
  assert.deepEqual({ month: row.month, implied: row.implied, bracketLow: row.bracketLow, bracketHigh: row.bracketHigh }, { month: '2026-11', implied: 9, bracketLow: 8, bracketHigh: 10 });
  assert.equal(body.implied.error, null);
});

test('GET /api/market?implied=1 keeps the index when Kalshi is down', async t => {
  const origin = await appWithStubs(t, async () => { throw new TypeError('fetch failed'); });
  const body = await (await fetch(origin + '/api/market?implied=1')).json();
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

test('public pages carry the strip without any Kalshi view', async t => {
  const origin = await appWithStubs(t, stubFetch({}));
  for (const path of ['/', '/contracts']) {
    const html = await (await fetch(origin + path)).text();
    assert.match(html, /<section class="mk-sec" id="market-strip"/, path);
    assert.match(html, /Market data loads with JavaScript/, path);
    assert.match(html, /<script src="\/market\.js" defer><\/script>/, path);
    assert.doesNotMatch(html, /data-implied|data-mk="implied"/, path);
  }
  const script = await (await fetch(origin + '/market.js')).text();
  assert.match(script, /dataset\.implied === 'true'/);
  assert.equal((await fetch(origin + '/market.css')).status, 200);
  assert.match(await (await fetch(origin + '/contracts')).text(), /<a href="\/methodology">Methodology<\/a>/);
});

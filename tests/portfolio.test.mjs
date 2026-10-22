import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { fallbackHistory } from '../lib/prices.mjs';
import { getPortfolio, parseBookings, BookingError } from '../lib/portfolio.mjs';
import { exerciseQuote, intrinsicAt, providerScenarios, fleetUnderShock, FOOTER_LINE } from '../dashboard-view.js';
import { listen, close } from './fixture.mjs';

const settings = { operatorName: 'Test fixture operator', contactEmail: 'fixture@example.invalid', retentionDays: null };
const TODAY = '2026-10-22';
const prices = fallbackHistory();
const close6 = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: ${actual} vs ${expected}`);
const booking = {
  ref: 'DEMO-ABC123', gpu: 'H100', count: 8, start: '2026-12-07T14:00:00Z', end: '2026-12-14T14:00:00Z',
  type: 'call', strike: 2.9, premiumPerGpuHour: 0.11, premiumTotal: 147.84, region: 'US East (Virginia)', config: 'SXM-IB', createdAt: '2026-10-22T10:00:00Z',
};

async function app(t) {
  const server = createApp({ store: null, prices: async () => prices, siteSettings: settings, now: () => Date.parse(TODAY + 'T12:00:00Z') });
  const origin = await listen(server);
  t.after(() => close(server));
  return origin;
}

test('portfolio KPIs and cents on the dollar for the sample set', async () => {
  const p = await getPortfolio({ prices, today: TODAY, quoteCap: null });
  const open = p.positions.filter(x => x.phase !== 'used');
  const fixed = open.filter(x => x.kind !== 'call');
  const cost = fixed.reduce((s, x) => s + x.valuation.remainingCost, 0);
  const value = fixed.reduce((s, x) => s + x.valuation.value, 0);
  assert.equal(p.positions.length, 7);
  assert.deepEqual(p.positions.map(x => x.phase), ['upcoming', 'upcoming', 'window', 'upcoming', 'upcoming', 'used', 'upcoming']);
  assert.equal(p.kpis.openPositions, 6);
  assert.equal(p.kpis.callCount, 2);
  close6(p.kpis.remainingCommittedCost, cost, 'committed cost');
  close6(p.kpis.centsOnDollar, (cost + value) / cost * 100, 'cents on the dollar');
  close6(p.kpis.premiumsPaid, 0.12 * 256 * 62 * 24 + 0.25 * 64 * 7 * 24, 'premiums paid');
  close6(p.kpis.netValue, open.reduce((s, x) => s + x.valuation.value, 0), 'net value');
  assert.ok(p.kpis.centsOnDollar > 100 && p.kpis.centsOnDollar < 130);
  assert.equal(p.kpis.nextDeadline.positionId, 'H1');
  assert.equal(p.kpis.nextDeadline.action, 'Claim');
  assert.ok(p.positions.find(x => x.id === 'H6').used.saving > 0, 'the finished A100 window saved money');
  assert.equal(p.history.at(-1).date, TODAY, 'chart ends on today');
  close6(p.history.at(-1).value, p.kpis.netValue, 'chart ends on the headline');
  assert.ok(p.alerts.some(a => a.id === 'offer-H5') && p.alerts.some(a => a.id === 'ltv-C'));
  assert.equal(p.fleets.find(f => f.id === 'C').mark.ltvStatus, 'breach');
});

test('calls: intrinsic only without the pricing engine, time value with it', async () => {
  const bare = (await getPortfolio({ prices, today: TODAY, quoteCap: null })).positions.find(x => x.id === 'H7');
  assert.equal(bare.valuation.timeValue, null);
  close6(bare.valuation.value, bare.valuation.intrinsic, 'value is intrinsic');
  close6(bare.valuation.moneyness, 2.78 - 2.5, 'moneyness at the cached index');
  close6(bare.valuation.breakEven, 2.75, 'break-even');
  close6(intrinsicAt(bare, bare.valuation.spot), bare.valuation.intrinsic, 'client intrinsic matches server');
  const throwing = () => { throw new Error('not implemented'); };
  assert.equal((await getPortfolio({ prices, today: TODAY, quoteCap: throwing })).positions.find(x => x.id === 'H7').valuation.timeValue, null);
  const stub = () => ({ premiumPerGpuHour: 0.4 });
  const priced = (await getPortfolio({ prices, today: TODAY, quoteCap: stub })).positions.find(x => x.id === 'H7');
  close6(priced.valuation.timeValue, 0.4 * priced.valuation.remainingHours - priced.valuation.intrinsic, 'time value');
  close6(priced.valuation.value, 0.4 * priced.valuation.remainingHours, 'value equals the option price');
});

test('exercise arithmetic for H7 at an index of $3.00', async () => {
  const h7 = (await getPortfolio({ prices, today: TODAY, quoteCap: null })).positions.find(x => x.id === 'H7');
  const x = exerciseQuote(h7, 3);
  assert.equal(x.hours, 64 * 7 * 24);
  close6(x.pay, 2.5 * 10752, 'pay the cap');
  close6(x.saving, 0.5 * 10752, 'saving vs index');
  close6(x.bid, 2.9, 'best bid = index × utilisation − $0.10');
  close6(x.gross, 0.4 * 10752, 'resale proceeds');
  close6(x.fee, 0.004 * 10752, '1% fee');
  close6(x.net, 0.396 * 10752, 'net');
  assert.equal(exerciseQuote(h7, 2.4).net, 0, 'no resale proceeds below the cap');
});

test('provider scenarios and fleet shock arithmetic', () => {
  const rows = providerScenarios({ index: 2.8, strike: 3.1, premium: 0.1, gpuHours: 1000 });
  assert.deepEqual(rows.map(r => r.name), ['Quiet', 'Moderate', 'Spike']);
  close6(rows[0].market, 2.8 * 0.8 * 0.5 * 1000, 'quiet market');
  close6(rows[0].withCap, rows[0].market + 100, 'quiet with cap');
  close6(rows[2].withCap, 3.1 * 1000 + 100, 'spike with cap');
  const fleet = { loanBalance: 50, amortisationMonths: 60, mark: { fleetValue: 100, remainingLifeMonths: 24 } };
  assert.equal(fleetUnderShock(fleet, 0).status, 'ok');
  assert.equal(fleetUnderShock(fleet, 0.4).status, 'breach');
  assert.ok(fleetUnderShock(fleet, 0).monthsToBreach > 0);
});

test('bookings are validated and merged as upcoming positions', async () => {
  const { bookings, rejected } = parseBookings(JSON.stringify([booking, { ...booking, gpu: 'Z9' }]), Object.keys(prices.data));
  assert.equal(rejected, 1);
  assert.equal(bookings[0].region, 'US East');
  const p = await getPortfolio({ prices, today: TODAY, quoteCap: null, bookings });
  const merged = p.positions.find(x => x.source === 'booking');
  assert.equal(p.positions.length, 8);
  assert.equal(merged.phase, 'upcoming');
  assert.equal(merged.kind, 'call');
  assert.equal(p.kpis.callCount, 3);
  for (const bad of ['{', '{"a":1}', JSON.stringify(Array(21).fill(booking)), 'x'.repeat(9000)]) {
    assert.throws(() => parseBookings(bad, ['H100']), BookingError);
  }
});

test('GET /api/portfolio returns the portfolio shape and rejects bad bookings', async t => {
  const origin = await app(t);
  const response = await fetch(`${origin}/api/portfolio?bookings=${encodeURIComponent(JSON.stringify([booking]))}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  for (const key of ['asOf', 'prices', 'account', 'kpis', 'positions', 'history', 'alerts', 'fleets', 'provider']) assert.ok(key in body, key);
  assert.deepEqual(Object.keys(body.prices).sort(), ['asOf', 'live', 'source']);
  assert.equal(body.positions.length, 8);
  assert.equal(body.rejectedBookings, 0);
  const bad = await fetch(`${origin}/api/portfolio?bookings=notjson`);
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /JSON array/);
});

test('GET /dashboard renders the ledger, the attribution line and no inline script or style', async t => {
  const origin = await app(t);
  const response = await fetch(origin + '/dashboard');
  assert.equal(response.status, 200);
  const html = await response.text();
  for (const id of ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7']) assert.ok(html.includes(`data-row="${id}"`), id);
  assert.ok(html.includes(FOOTER_LINE));
  assert.ok(html.includes('Demo account · sample data · nothing here is a live price, order or account'));
  assert.ok(html.includes('<script type="module" src="/dashboard.js"></script>'));
  assert.ok(html.includes('<section id="market-strip" data-implied="true"></section>'), 'market strip container behind the sign-in');
  assert.ok(html.includes('<script src="/market.js" defer></script>') && html.includes('href="/market.css"'));
  assert.ok(html.includes('href="/audit"'), 'audit trail in the rail');
  assert.ok(html.includes('class="tag d-tag-model"') && html.includes('class="tag d-tag-sample"'), 'provenance tags');
  assert.doesNotMatch(html, /\son[a-z]+="|\sstyle="/);
  assert.doesNotMatch(html, /<!-- D_[A-Z_]+ -->/, 'every marker is filled');
  assert.doesNotMatch(html.toLowerCase(), /buyback|book-out|cash settlement|sell back|offshore|rating/);
  for (const path of ['/dashboard.js', '/dashboard.css', '/dashboard-view.js']) assert.equal((await fetch(origin + path)).status, 200, path);
});

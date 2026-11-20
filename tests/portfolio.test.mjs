import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { fallbackHistory } from '../lib/prices.mjs';
import { getPortfolio, valueCall, valuePut } from '../lib/portfolio.mjs';
import {
  exerciseQuote, intrinsicAt, providerScenarios, fleetUnderShock, FOOTER_LINE,
  coverage, savingsToDate, upcomingEvents, billingMonths, PLANNED_GPUS,
} from '../dashboard-view.js';
import { listen, close } from './fixture.mjs';

const settings = { operatorName: 'Test fixture operator', contactEmail: 'fixture@example.invalid', retentionDays: null };
const TODAY = '2026-10-22';
const prices = fallbackHistory();
const close6 = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: ${actual} vs ${expected}`);
async function signIn(origin) {
  const response = await fetch(`${origin}/api/auth/sign-in`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ email: 'demo@dodona.markets', password: 'demo-dodona-2026' }) });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}

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
  close6(bare.valuation.moneyness, 2.78 * bare.valuation.forwardFactor - 2.5, 'moneyness on the expected window average, not the spot print');
  assert.equal(bare.valuation.windowAverage.realised, null, 'no realised days before the window');
  close6(bare.valuation.breakEven, 2.75, 'break-even');
  close6(intrinsicAt(bare, bare.valuation.spot), bare.valuation.intrinsic, 'client intrinsic matches server');
  const throwing = () => { throw new Error('not implemented'); };
  assert.equal((await getPortfolio({ prices, today: TODAY, quoteCap: throwing })).positions.find(x => x.id === 'H7').valuation.timeValue, null);
  const stub = () => ({ premiumPerGpuHour: 0.4 });
  const priced = (await getPortfolio({ prices, today: TODAY, quoteCap: stub })).positions.find(x => x.id === 'H7');
  close6(priced.valuation.timeValue, 0.4 * priced.valuation.remainingHours - priced.valuation.intrinsic, 'time value');
  close6(priced.valuation.value, 0.4 * priced.valuation.remainingHours, 'value equals the option price');
});

test('a cap in its window values on the days-weighted blend of the realised average and the forward', () => {
  const series = Array.from({ length: 40 }, (_, i) => [new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10), i < 30 ? 2 + i * 0.01 : 2.6]);
  const today = series[33][0];
  const cap = { gpu: 'H100', count: 10, pricePerGpuHour: 2.4, premiumPerGpuHour: 0.1, region: 'US East', config: 'SXM-IB', start: series[30][0] + 'T00:00:00Z', end: series[38][0] + 'T00:00:00Z' };
  const val = valueCall(cap, series, { today, quoteCap: null });
  const w = val.windowAverage;
  assert.equal(w.points, 4, 'four printed days inside the window');
  close6(w.realised, 2.6, 'realised average of the window so far');
  close6(w.realisedWeight, 3 / 8, 'three of eight days elapsed at the start of today');
  close6(w.expected, 2.6 * (3 / 8) + val.spot * val.forwardFactor * (5 / 8), 'blend by days');
  close6(val.moneyness, w.expected * val.basis - 2.4, 'moneyness on the blend');
  close6(val.intrinsic, Math.max(w.expected * val.basis - 2.4, 0) * val.remainingHours * val.discountFactor, 'intrinsic on the blend');
  close6(intrinsicAt({ ...cap, valuation: val }, val.spot), val.intrinsic, 'browser what-if matches the server');
});

test('a floor (put) values on the shortfall of the expected window average below the strike', () => {
  const series = Array.from({ length: 40 }, (_, i) => [new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10), 2.4]);
  const floor = { kind: 'put', gpu: 'H100', count: 10, pricePerGpuHour: 2.6, premiumPerGpuHour: 0.08, region: 'US East', config: 'SXM-IB', start: '2026-11-20T00:00:00Z', end: '2026-11-27T00:00:00Z' };
  const put = valuePut(floor, series, { today: series.at(-1)[0], quoteCap: null });
  close6(put.intrinsic, Math.max(2.6 - put.windowAverage.expected * put.basis, 0) * put.remainingHours * put.discountFactor, 'put intrinsic');
  assert.ok(put.intrinsic > 0, 'in the money when the index sits below the floor');
  close6(put.breakEven, 2.52, 'floor break-even is strike minus premium');
  const cap = valueCall({ ...floor, kind: 'call' }, series, { today: series.at(-1)[0], quoteCap: null });
  assert.equal(cap.intrinsic, 0, 'the same terms as a cap are out of the money');
});

test('exercise arithmetic for H7 at an index of $3.00', async () => {
  const h7 = (await getPortfolio({ prices, today: TODAY, quoteCap: null })).positions.find(x => x.id === 'H7');
  const x = exerciseQuote(h7, 3);
  const average = 3 * h7.valuation.forwardFactor;
  assert.equal(x.hours, 64 * 7 * 24);
  close6(x.average, average, 'expected window average at an index of $3.00');
  close6(x.pay, Math.min(average, 2.5) * 10752, 'billed at the lower of the window average and the cap');
  close6(x.saving, (average - 2.5) * 10752, 'saving vs the window average');
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

test('GET /api/portfolio needs a session and returns the portfolio shape for the signed-in account', async t => {
  const origin = await app(t);
  const signedOut = await fetch(`${origin}/api/portfolio`);
  assert.equal(signedOut.status, 401);
  assert.equal((await signedOut.json()).error.code, 'signed_out');
  const cookie = await signIn(origin);
  const response = await fetch(`${origin}/api/portfolio?bookings=ignored`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  for (const key of ['asOf', 'prices', 'account', 'kpis', 'positions', 'history', 'alerts', 'fleets', 'provider']) assert.ok(key in body, key);
  assert.deepEqual(Object.keys(body.prices).sort(), ['asOf', 'live', 'source']);
  assert.equal(body.positions.length, 7);
  assert.ok(!('rejectedBookings' in body), 'the old sessionStorage bookings path is gone');
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

test('GET /theme.js and the console font are served with the right content types', async t => {
  const origin = await app(t);
  const theme = await fetch(origin + '/theme.js');
  assert.equal(theme.status, 200);
  assert.match(theme.headers.get('content-type'), /^text\/javascript/);
  assert.match(await theme.text(), /dodonaTheme/);
  const font = await fetch(origin + '/assets/fonts/open-sans-latin-wght-normal.woff2');
  assert.equal(font.status, 200);
  assert.equal(font.headers.get('content-type'), 'font/woff2');
});

test('console markup: theme script first, no inline script or style, rows are keyboard targets, sprite covers every icon', async t => {
  const origin = await app(t);
  const html = await (await fetch(origin + '/dashboard')).text();
  const head = html.slice(0, html.indexOf('</head>'));
  assert.ok(head.indexOf('<script src="/theme.js"></script>') < head.indexOf('<link rel="stylesheet"'), 'theme.js runs before the stylesheets, not deferred');
  for (const tagText of html.match(/<script\b[^>]*>/g)) assert.ok(/\ssrc="\/[^"]+"/.test(tagText) || tagText.includes('application/ld+json'), `external or structured data only: ${tagText}`);
  assert.doesNotMatch(html, /\sstyle="/);
  const rows = html.match(/<tr data-row="[^"]+"[^>]*>/g);
  assert.equal(rows.length, 7);
  for (const row of rows) assert.ok(row.includes('tabindex="0"') && /aria-selected="(true|false)"/.test(row), row);
  assert.ok(!html.includes('type="radio"'), 'no radio cell');
  const symbols = new Set([...html.matchAll(/<symbol id="i-([a-z-]+)"/g)].map(m => m[1]));
  const nav = html.slice(html.indexOf('<nav class="d-rail"'), html.indexOf('</nav>', html.indexOf('<nav class="d-rail"')));
  const navIcons = [...nav.matchAll(/href="#i-([a-z-]+)"/g)].map(m => m[1]);
  assert.ok(navIcons.length >= 8);
  for (const name of navIcons) assert.ok(symbols.has(name), `nav icon ${name}`);
  for (const [, name] of html.matchAll(/href="#i-([a-z-]+)"/g)) assert.ok(symbols.has(name), `page icon ${name}`);
  const scripts = (await (await fetch(origin + '/dashboard.js')).text()) + (await (await fetch(origin + '/dashboard-view.js')).text());
  for (const [, name] of scripts.matchAll(/icon\('([a-z-]+)'/g)) assert.ok(symbols.has(name), `script icon ${name}`);
  for (const [, name] of scripts.matchAll(/icon: '([a-z-]+)'/g)) assert.ok(symbols.has(name), `action icon ${name}`);
  assert.ok(html.includes('<!-- lucide (ISC) -->'));
  assert.ok(html.includes('data-act="more"'), 'third and later row actions sit under More');
  assert.ok(html.includes('class="btn btn-sm btn-primary"'), 'one primary action per row');
});

test('console panels: coverage, savings, upcoming dates and billing come from the positions', async () => {
  const p = await getPortfolio({ prices, today: TODAY, quoteCap: null });
  const c30 = coverage(p.positions, TODAY, 30);
  close6(c30.planned, PLANNED_GPUS * 30 * 24, 'planned hours');
  close6(c30.fixed, 64 * 14 * 24 + 8 * 121, 'H1 in full plus what is left of H3');
  close6(c30.capped, 64 * 118, 'H7 up to the end of the 30 days');
  const c90 = coverage(p.positions, TODAY, 90);
  assert.ok(c90.capped > c30.capped && c90.fixed > c30.fixed, 'longer horizon picks up H2 and H5');
  const savings = savingsToDate(p.positions, TODAY);
  assert.deepEqual(savings.rows.map(r => r.id).sort(), ['H3', 'H6']);
  close6(savings.rows.find(r => r.id === 'H6').saving, p.positions.find(x => x.id === 'H6').used.saving, 'finished window uses the daily saving');
  const events = upcomingEvents(p.positions, TODAY);
  assert.ok(events.length >= 4);
  assert.deepEqual(events.map(e => e.at), [...events.map(e => e.at)].sort((a, b) => Date.parse(a) - Date.parse(b)), 'dated in order');
  assert.ok(events.some(e => e.id === 'H1' && e.text.startsWith('Claim deadline')) && events.some(e => e.id === 'H7' && e.text.startsWith('Exercise deadline')));
  assert.ok(!events.some(e => e.id === 'H2' && e.text.includes('deadline')), 'H2 deadline is past 30 days');
  const invoices = billingMonths(p.positions, TODAY);
  assert.deepEqual(invoices.map(i => [i.id, i.status]), [['INV-202610', 'due'], ['INV-202609', 'paid']]);
  close6(invoices[1].premiums, 0.12 * 256 * 62 * 24, 'H2 premium billed in September');
  close6(invoices[0].total, 0.25 * 64 * 7 * 24, 'the H7 premium alone in October');
  close6(invoices[0].platformFee, invoices[0].premiums * 0.15, 'platform share sits inside the premium');
});

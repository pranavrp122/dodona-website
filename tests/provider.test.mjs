import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixture } from './fixture.mjs';
import * as view from '../provider-view.js';

const PAGES = ['/provider', '/docs/neocloud-api'];
const ASSETS = [['/provider.js', 'text/javascript'], ['/provider-view.js', 'text/javascript'], ['/provider.css', 'text/css']];
const BANNED = /\b(buyback|buy-back|book-out|cash settlement|sell back|rating|offshore)\b/i;

test('the provider portal and the neocloud guide are served with no inline script, style or handler', async t => {
  const f = await fixture({ platform: true });
  t.after(() => f.cleanup());
  for (const path of PAGES) {
    const response = await fetch(f.origin + path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    const html = await response.text();
    assert.ok(html.split('<script').slice(1).every(tag => tag.split('>')[0].includes(' src=')), `${path}: no inline scripts`);
    assert.doesNotMatch(html, /\son[a-z]+="|\sstyle="/, `${path}: no handlers or style attributes`);
    assert.doesNotMatch(html.replace(/<[^>]+>/g, ' '), BANNED, `${path}: wording`);
    assert.ok(html.includes('Demo'), `${path}: demo banner`);
  }
  for (const [path, type] of ASSETS) {
    const response = await fetch(f.origin + path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type'), new RegExp(type));
  }
});

test('the portal ships the gate, the console shell and every screen', async t => {
  const f = await fixture({ platform: true });
  t.after(() => f.cleanup());
  const html = await (await fetch(f.origin + '/provider')).text();
  assert.ok(html.includes('id="p-gate"') && html.includes('Sign in as a provider'));
  assert.ok(html.includes('class="c-top"') && html.includes('class="d-rail"') && html.includes('/dashboard.css'));
  for (const screen of view.SCREENS) assert.ok(html.includes(`data-screens="${screen}"`), screen);
  for (const id of ['i-key', 'i-webhook', 'i-layout-dashboard']) assert.ok(html.includes(`id="${id}"`), id);
  for (const clock of ['day', 'week', 'next', 'settle', 'reset']) assert.ok(html.includes(`data-clock="${clock}"`), clock);
});

test('the guide names every message the mock neocloud exchanges', async t => {
  const f = await fixture({ platform: true });
  t.after(() => f.cleanup());
  const html = await (await fetch(f.origin + '/docs/neocloud-api')).text();
  for (const type of ['reservation.requested', 'reservation.confirmed', 'usage.reported', 'settlement.computed', 'invoice.issued', 'payout.issued']) assert.ok(html.includes(type), type);
  assert.ok(html.includes('window average'));
  assert.ok(html.includes('escrow agent (simulated)'));
});

test('platform pages answer 404 when the demo platform is off', async t => {
  const f = await fixture({ platform: false });
  t.after(() => f.cleanup());
  for (const [path] of [...PAGES.map(p => [p]), ...ASSETS]) assert.equal((await fetch(f.origin + path)).status, 404, path);
  assert.equal((await fetch(f.origin + '/')).status, 200, 'the public site stays up');
});

test('only provider accounts get the portal; everyone else gets the sign-in-as-provider page', () => {
  assert.equal(view.gateFor({ role: 'provider' }), 'portal');
  for (const role of ['buyer', 'lender', 'admin']) assert.equal(view.gateFor({ role }), 'signin', role);
  assert.equal(view.gateFor(null), 'signin');
});

test('the event log escapes types, refs and JSON payloads', () => {
  const html = view.eventRows({ events: [{
    id: 'e1', orderRef: '<img src=x onerror=alert(1)>', direction: 'dodona_to_neocloud', type: '<script>alert(1)</script>',
    payload: { note: '</code></pre><script>alert(2)</script>', nested: { a: '"quoted" & <b>' } }, httpStatus: 200, at: '2026-11-02T14:00:00.000Z',
  }] });
  assert.doesNotMatch(html, /<script>|<img|<b>/);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&lt;/code&gt;&lt;/pre&gt;&lt;script&gt;alert(2)'));
  assert.ok(html.includes('\\&quot;quoted\\&quot; &amp; &lt;b&gt;'));
  assert.ok(html.includes('<details>') && html.includes('HTTP 200'));
});

test('order, contract and payout rows escape buyer-controlled text', () => {
  const evil = '<svg onload=alert(1)>';
  const orders = view.bucketOrders({ orders: [{ ref: evil, status: 'reserving', gpu: 'H100', count: 8, region: evil, kind: 'call', strike: 2.4, start: '2026-11-16T00:00:00Z', end: '2026-11-30T00:00:00Z', buyer: { company: evil } }] });
  assert.equal(orders.incoming.length, 1);
  const html = view.incomingRows(orders.incoming) + view.payoutRows([{ orderRef: evil, direction: evil, amount: 1, status: 'paid' }]);
  assert.doesNotMatch(html, /<svg onload/);
});

test('provider-side payoffs: a sold cap loses above the strike, a bought floor gains below it', () => {
  const cap = view.normalizeContract({ orderRef: 'A', kind: 'cap', strike: 2, hours: 1000, premium: 150 });
  const floor = view.normalizeContract({ orderRef: 'B', kind: 'put', strike: 2, hours: 1000, premium: 100 });
  assert.equal(view.providerPayoff(cap, 1.5).net, 150);
  assert.equal(view.providerPayoff(cap, 2.5).net, 150 - 500);
  assert.equal(view.providerPayoff(floor, 1.5).net, 500 - 100);
  assert.equal(view.providerPayoff(floor, 2.5).net, -100);
  const summary = view.whatIfSummary([cap, floor], 2.5);
  assert.ok(summary.includes('−$350.00') && summary.includes('−$100.00') && summary.includes('−$450.00'));
});

test('orders are bucketed into incoming, active and settled by status', () => {
  const rows = ['reserving', 'reserved', 'delivering', 'settled', 'declined'].map((status, i) => ({ ref: `R${i}`, status }));
  const { incoming, active, settled } = view.bucketOrders({ orders: rows });
  assert.deepEqual([incoming.map(o => o.ref), active.map(o => o.ref), settled.map(o => o.ref)], [['R0'], ['R1', 'R2'], ['R3', 'R4']]);
});

test('the statement CSV keeps formulas inert and quotes commas', () => {
  const csv = view.statementCsv({ settlements: [{ orderRef: '=HYPERLINK("x")', settlement: { kind: 'cap', windowAvg: 2.5, computeBill: -12.5 } }] }, { payouts: [{ orderRef: 'A,B', direction: 'buyer_to_neocloud', amount: 10, status: 'paid' }] });
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(csv.includes(',-12.5,'));
  assert.ok(csv.includes('"A,B"'));
});

test('portal source files avoid banned wording', async () => {
  for (const file of ['provider.html', 'provider.js', 'provider-view.js', 'neocloud-api.html']) {
    const text = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text.replace(/<symbol[^]*?<\/symbol>/g, ''), BANNED, file);
  }
});

test('real accounts: the Northwind login opens the portal, the seeded buyer and a signed-out visitor get the gate', async t => {
  const { platformFixture } = await import('./fixture.mjs');
  const f = await platformFixture();
  t.after(() => f.cleanup());
  const provider = (await (await f.as('ops@northwind.example')).get('/api/account')).data.account;
  assert.equal(view.gateFor(provider), 'portal');
  assert.match(provider.neocloud.name, /Northwind/);
  assert.equal(provider.home, '/provider');
  const buyer = (await (await f.as('demo@dodona.markets')).get('/api/account')).data.account;
  assert.equal(view.gateFor(buyer), 'signin');
  assert.equal((await f.anonymous.get('/api/account')).status, 401);
  assert.equal((await f.anonymous.get('/provider')).status, 200, 'the page itself is public; the script shows the gate');
});

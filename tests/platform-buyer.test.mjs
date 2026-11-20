// Buyer pages of the demo platform: served HTML, CSP-safe markup, the sign-in gate, range chips, payoff math and the off switch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from '../server.mjs';
import { listen, close, platformFixture } from './fixture.mjs';
import { historyRange, rangeCaption, payoffAt, payoffBreakEven, payoffChart, RANGES } from '../dashboard-view.js';

const PAGES = ['/sign-in', '/offers', '/checkout', '/orders', '/orders/DOD-ABC123'];
const ASSETS = ['/platform.css', '/platform-shell.js', '/sign-in.js', '/offers.js', '/platform-checkout.js', '/orders.js', '/order.js', '/dashboard-platform.js', '/dashboard-charts.js'];
const OWN_FILES = ['sign-in.html', 'offers.html', 'checkout.html', 'orders.html', 'order.html', 'dashboard.html', 'platform.css', ...ASSETS.map(path => path.slice(1)), 'dashboard.js', 'lib/platform-pages.mjs'];
const BANNED = /buyback|book-out|cash settlement|sell back|\brating\b|offshore/i;

async function setup(t, options) { const f = await platformFixture(options); t.after(() => f.cleanup()); return f; }

test('every buyer page is served in the console shell with external scripts only and no style attributes', async t => {
  const f = await setup(t);
  for (const path of PAGES) {
    const response = await fetch(f.origin + path);
    assert.equal(response.status, 200, path);
    const html = await response.text();
    for (const tagText of html.match(/<script\b[^>]*>/g)) assert.ok(/\ssrc="\/[^"]+"/.test(tagText) || tagText.includes('application/ld+json'), `${path}: ${tagText}`);
    assert.doesNotMatch(html, /\sstyle="|\son[a-z]+="/, path);
    assert.doesNotMatch(html, /<!-- P_[A-Z]+ -->/, `${path}: every shell marker is filled`);
    assert.ok(html.includes('class="c-top"') && html.includes('class="c-strip"') && html.includes('href="/platform.css"'), `${path}: console shell`);
    const symbols = new Set([...html.matchAll(/<symbol id="i-([a-z-]+)"/g)].map(m => m[1]));
    for (const [, name] of html.matchAll(/href="#i-([a-z-]+)"/g)) assert.ok(symbols.has(name), `${path}: icon ${name}`);
    assert.doesNotMatch(html, BANNED, path);
  }
  for (const path of ASSETS) assert.equal((await fetch(f.origin + path)).status, 200, path);
});

test('the sign-in page lists the four demo logins and makes accounts with a role choice', async t => {
  const f = await setup(t);
  const html = await (await fetch(f.origin + '/sign-in')).text();
  for (const email of ['demo@dodona.markets', 'credit@meridian.example', 'ops@northwind.example', 'admin@dodona.markets']) assert.ok(html.includes(`data-fill="${email}"`), email);
  assert.ok(html.includes('demo-dodona-2026'));
  for (const role of ['buyer', 'lender', 'provider']) assert.ok(html.includes(`<option value="${role}">`), role);
  assert.ok(!html.includes('<option value="admin">'), 'sign-up cannot make an admin');
});

test('the card form never names its fields, so no submit can put the card in a URL', async t => {
  const f = await setup(t);
  const html = await (await fetch(f.origin + '/checkout')).text();
  const form = html.slice(html.indexOf('<form class="p-form" id="co-form"'), html.indexOf('</form>', html.indexOf('id="co-form"')));
  assert.match(form, /method="post"/);
  for (const id of ['co-name', 'co-number', 'co-exp', 'co-cvc']) {
    const input = form.match(new RegExp(`<input id="${id}"[^>]*>`))[0];
    assert.doesNotMatch(input, /\sname=/, id);
  }
  for (const card of ['4242 4242 4242 4242', '4000 0000 0000 0002', '4000 0000 0000 9995']) assert.ok(html.includes(card), card);
  const script = await readFile(new URL('../platform-checkout.js', import.meta.url), 'utf8');
  assert.doesNotMatch(script, /console\.|localStorage|sessionStorage/, 'the card is never logged or stored');
});

test('without a session the dashboard shows the gate to /sign-in and the APIs answer 401', async t => {
  const f = await setup(t);
  const html = await (await fetch(f.origin + '/dashboard')).text();
  const gate = html.slice(html.indexOf('id="d-signin"'), html.indexOf('</section>', html.indexOf('id="d-signin"')));
  assert.ok(gate.includes('href="/sign-in"') && gate.includes('href="/sign-in#create"'));
  assert.ok(!html.includes('id="d-demo-login"'), 'no sessionStorage demo login left');
  assert.equal((await f.anonymous.get('/api/account')).status, 401);
  assert.equal((await f.anonymous.get('/api/portfolio')).status, 401);
  const script = await readFile(new URL('../dashboard.js', import.meta.url), 'utf8');
  assert.doesNotMatch(script, /dodonaDemoSession|dodonaDemoBookings/, 'positions no longer come from sessionStorage');
});

test('the dashboard carries 1D to All range chips, the demo clock slot and the new rail items', async t => {
  const f = await setup(t);
  const html = await (await fetch(f.origin + '/dashboard')).text();
  const chips = [...html.matchAll(/data-range="([a-z0-9]+)" data-scope="portfolio"/g)].map(m => m[1]);
  assert.deepEqual(chips, RANGES.map(([value]) => value));
  assert.deepEqual(RANGES.map(([, label]) => label), ['1D', '1W', '1M', '1Y', 'YTD', 'All']);
  assert.ok(html.includes('id="p-clock"') && html.includes('id="p-acct"'));
  for (const href of ['/orders', '/offers', '#emails']) assert.ok(html.includes(`class="c-tab" href="${href}"`), href);
  assert.ok(html.includes('data-screens="emails"'));
});

test('signed in, a buyer page loads the account and the order detail the order page needs', async t => {
  const f = await setup(t);
  const buyer = await f.as('demo@dodona.markets');
  const { data } = await buyer.get('/api/orders');
  assert.ok(data.orders.length >= 7);
  const detail = await buyer.get(`/api/orders/${data.orders[0].ref}`);
  for (const key of ['order', 'events', 'payouts', 'emails', 'bids']) assert.ok(key in detail.data, key);
});

test('range filter: 1D, 1W, 1M from the last point; 1Y and YTD say since when history starts', () => {
  const history = Array.from({ length: 120 }, (_, i) => ({ date: new Date(Date.UTC(2026, 5, 1) + i * 86400000).toISOString().slice(0, 10), value: i * 10 }));
  assert.equal(historyRange(history, '1d').points.length, 2);
  assert.equal(historyRange(history, '1d').change, 10);
  assert.equal(historyRange(history, '1w').points.length, 8);
  assert.equal(historyRange(history, '1m').since, '2026-08-28');
  const year = historyRange(history, '1y');
  assert.equal(year.points.length, 120);
  assert.equal(year.partial, true);
  assert.match(rangeCaption(year), /History starts 1 Jun 2026/);
  assert.equal(historyRange(history, 'all').partial, false);
  assert.equal(historyRange([], 'all').points.length, 0);
});

test('payoff on the window average: cap and floor never below zero, net down to minus the premium, lock negative below its price', () => {
  const terms = { strike: 3, hours: 1000, premiumPaid: 200 };
  assert.deepEqual(payoffAt('call', 2, terms), { payoff: 0, net: -200 });
  assert.deepEqual(payoffAt('call', 3.5, terms), { payoff: 500, net: 300 });
  assert.deepEqual(payoffAt('put', 2.5, terms), { payoff: 500, net: 300 });
  assert.deepEqual(payoffAt('put', 4, terms), { payoff: 0, net: -200 });
  assert.deepEqual(payoffAt('lock', 2.5, terms), { payoff: -500, net: -500 });
  assert.equal(payoffBreakEven('call', 3, 0.2), 3.2);
  assert.equal(payoffBreakEven('put', 3, 0.2), 2.8);
  const svg = payoffChart({ kind: 'call', ...terms, premiumPerHour: 0.2, current: 2, lo: 1.5, hi: 4.5 });
  assert.match(svg, /window average/);
  assert.match(svg, /break-even \$3\.20/);
  assert.match(svg, /p-loss-zone/, 'the chart shows the area below zero');
});

test('with the platform off, buyer pages and their scripts are not served', async t => {
  const app = createApp({ store: null, platform: false, db: ':memory:', logger: { error() {} } });
  const origin = await listen(app);
  t.after(() => close(app));
  for (const path of [...PAGES, ...ASSETS]) assert.equal((await fetch(origin + path)).status, 404, path);
});

test('buyer files use none of the banned words', async () => {
  for (const file of OWN_FILES) assert.doesNotMatch(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'), BANNED, file);
});

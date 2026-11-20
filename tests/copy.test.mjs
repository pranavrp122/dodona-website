// Product copy reads as if the platform were live: "mock", "simulated", "fake", "pretend" and "demo" stay inside the
// disclaimer regions (top-bar pill and banner, footers, tag pills, the demo clock, the demo-accounts box, the test-card box).
import test from 'node:test';
import assert from 'node:assert/strict';
import { platformFixture } from './fixture.mjs';
import * as tours from '../tour-steps.js';

const BANNED = /\b(?:mock\w*|simulat\w*|fake\w*|pretend\w*|demo)\b/i;
const BUYER = 'demo@dodona.markets';
const LENDER = 'credit@meridian.example';
const PROVIDER = 'ops@northwind.example';
const ADMIN = 'admin@dodona.markets';
const card = { number: '4242424242424242', expMonth: 12, expYear: 2030, cvc: '123', name: 'Sam Sample' };

const SIGNED_OUT_PAGES = ['/', '/sign-in', '/offers', '/checkout', '/orders', '/orders/DOD-ABC123', '/dashboard', '/provider', '/admin', '/docs/neocloud-api', '/methodology', '/audit'];
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const ALLOWED_CLASS = /(?:^|-)(?:tag|pill|badge|banner)(?:-|$)|^c-demo$|^c-strip$|^p-clock/;

const attr = (attrs, name) => attrs.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];

// Disclaimer regions the rule allows the words in.
function isAllowed(name, attrs) {
  if (name === 'footer' || name === 'script' || name === 'style' || name === 'svg') return true;
  if ((attr(attrs, 'class') || '').split(/\s+/).some(token => ALLOWED_CLASS.test(token))) return true;
  if (attr(attrs, 'id') === 'p-clock') return true;
  if (attr(attrs, 'aria-labelledby') === 'si-demo-h') return true;
  return attr(attrs, 'data-tour') === 'test-cards';
}

// Index just past the element's matching close tag, counting nested tags of the same name.
function elementEnd(html, name, from) {
  const tags = new RegExp(`<(/?)${name}\\b[^>]*>`, 'gi');
  tags.lastIndex = from;
  let depth = 1;
  for (let m = tags.exec(html); m; m = tags.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (!depth) return tags.lastIndex;
  }
  return html.length;
}

function stripAllowed(html) {
  let out = html.replace(/<!--[\s\S]*?-->/g, '');
  const open = /<([a-z][a-z0-9]*)\b([^>]*)>/gi;
  for (let m = open.exec(out); m; m = open.exec(out)) {
    const name = m[1].toLowerCase();
    if (!isAllowed(name, m[2])) continue;
    const end = VOID.has(name) || m[2].endsWith('/') ? open.lastIndex : elementEnd(out, name, open.lastIndex);
    out = out.slice(0, m.index) + ' ' + out.slice(end);
    open.lastIndex = m.index;
  }
  return out;
}

// What a reader sees or hears: text nodes plus the title, description, label, placeholder and alt attributes.
function visibleText(html) {
  const kept = stripAllowed(html);
  const attrs = [...kept.matchAll(/\s(?:content|aria-label|title|placeholder|alt)="([^"]*)"/g)].map(m => m[1]);
  const text = kept.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ');
  return [text, ...attrs].join(' ').replace(/\s+/g, ' ');
}

function assertClean(text, where) {
  const hit = text.match(BANNED);
  if (!hit) return;
  const at = text.indexOf(hit[0]);
  assert.fail(`${where}: "${hit[0]}" in "…${text.slice(Math.max(0, at - 80), at + 80)}…"`);
}

// Email addresses (the seeded demo@ login) are account data, not copy.
const jsonText = data => JSON.stringify(data).replace(/[\w.+-]+@[\w.-]+/g, '');

async function setup(t) { const f = await platformFixture(); t.after(() => f.cleanup()); return f; }

async function buyAndList(buyer) {
  const offer = (await buyer.get('/api/offers?kind=cap&gpu=H100&region=US+West')).data.offers[0];
  const order = (await buyer.post('/api/orders', { offerId: offer.id, count: 8 })).data.order;
  assert.equal((await buyer.post(`/api/orders/${order.ref}/pay`, { card })).status, 200);
  await buyer.post('/api/demo/advance', { until: 'next-event' });
  assert.equal((await buyer.post(`/api/orders/${order.ref}/list`, { askPerHour: 3.5 })).status, 200);
  await buyer.post('/api/demo/advance', { days: 1 });
  return order.ref;
}

test('signed-out pages keep the banned words inside disclaimer regions', async t => {
  const f = await setup(t);
  for (const path of SIGNED_OUT_PAGES) {
    const response = await f.anonymous.get(path);
    assert.equal(response.status, 200, path);
    assertClean(visibleText(response.data), path);
  }
});

test('signed-in pages for the seeded buyer, lender, provider and admin read as the live product', async t => {
  const f = await setup(t);
  const buyer = await f.as(BUYER);
  const [first] = (await buyer.get('/api/orders')).data.orders;
  const pages = [
    [buyer, ['/dashboard', '/offers', '/orders', '/checkout', `/orders/${first.ref}`]],
    [await f.as(LENDER), ['/dashboard']],
    [await f.as(PROVIDER), ['/provider', '/docs/neocloud-api']],
    [await f.as(ADMIN), ['/admin']],
  ];
  for (const [client, paths] of pages) {
    for (const path of paths) {
      const response = await client.get(path);
      assert.equal(response.status, 200, path);
      assertClean(visibleText(response.data), path);
    }
  }
});

test('API answers a user reads carry no banned words: portfolio, orders, emails, statements and events', async t => {
  const f = await setup(t);
  const buyer = await f.as(BUYER);
  const listedRef = await buyAndList(buyer);
  const refs = [...(await buyer.get('/api/orders')).data.orders.map(o => o.ref), listedRef];
  const reads = [[buyer, '/api/portfolio'], [buyer, '/api/emails'], [buyer, '/api/statements'], [buyer, '/api/integration/events'], ...refs.map(ref => [buyer, `/api/orders/${ref}`])];
  const provider = await f.as(PROVIDER);
  for (const path of ['/api/provider/orders', '/api/provider/overview', '/api/provider/settlements', '/api/provider/payouts', '/api/provider/events', '/api/emails']) reads.push([provider, path]);
  reads.push([await f.as(LENDER), '/api/portfolio']);
  const bids = (await buyer.get(`/api/orders/${listedRef}`)).data.bids;
  assert.ok(bids.length && bids.every(bid => !BANNED.test(bid.bidder)), 'the bidder has a company name');
  for (const [client, path] of reads) {
    const response = await client.get(path);
    assert.equal(response.status, 200, path);
    assertClean(jsonText(response.data), path);
  }
});

test('tour steps only mention the demo in the demo-clock steps', () => {
  const isClockStep = step => /clock/i.test(step.title || '');
  let checked = 0;
  for (const [name, steps] of Object.entries(tours)) {
    if (!Array.isArray(steps)) continue;
    for (const step of steps) {
      if (isClockStep(step)) continue;
      assertClean(`${step.title || ''} ${step.body || ''}`, `${name}: ${step.title}`);
      checked++;
    }
  }
  assert.ok(checked > 20, 'every tour was read');
});

/* ---------- colons: prose never introduces an explanation or a list with "word: " ---------- */

const PROSE_TAGS = /<(p|h[1-3]|li|figcaption|dd|summary)\b[^>]*>([\s\S]*?)<\/\1>/gi;
const NOT_PROSE = [/\b\d{1,2}:\d{2}\b/g, /\b[a-z][\w+.-]*:\/\/\S+/gi];
const CLIENT_SOURCES = ['dashboard.js', 'dashboard-view.js', 'dashboard-platform.js', 'dashboard-charts.js', 'provider.js', 'provider-view.js', 'admin.js', 'admin-view.js',
  'platform-shell.js', 'platform-checkout.js', 'order.js', 'orders.js', 'offers.js', 'sign-in.js', 'checkout.js', 'market.js', 'lib/portfolio.mjs', 'lib/outbox.mjs', 'lib/orders.mjs'];

const proseColon = text => NOT_PROSE.reduce((t, pattern) => t.replace(pattern, ''), text).match(/\S{0,40}:\s\S{0,40}/)?.[0];

// Every prose colon in [where, text] pairs, so one failing run lists them all.
const colonHits = pairs => pairs.map(([where, text]) => [where, proseColon(text)]).filter(([, hit]) => hit).map(([where, hit]) => `${where}: …${hit}…`);

// Prose elements of a page, minus code, the demo clock and the demo-accounts box (its password row is a key and value).
function proseBlocks(html) {
  let out = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|svg|code|pre)\b[\s\S]*?<\/\1>/gi, ' ');
  out = stripAllowed(out.replace(/<footer\b/gi, '<div data-footer')).replace(/data-footer/g, '');
  return [...out.matchAll(PROSE_TAGS)].map(m => m[2].replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim());
}

// String literals on lines of client code that show a toast or render prose: `${…}` holes read as a word.
function sourceStrings(file, text) {
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    for (const m of line.matchAll(/(['"`])((?:(?!\1)[^\\]|\\.)*?)\1/g)) {
      const s = m[2].replace(/\$\{[^}]*\}/g, 'X');
      if (!/[A-Za-z]{3}/.test(s) || s.includes('${') || line.includes('p-clock')) continue;
      const isToast = /toast\(|data-toast=/.test(line);
      const isSentence = /^[A-Z<]/.test(s) && /\.(<\/[a-z]+>)?$/.test(s) && / /.test(s);
      if (isToast || isSentence) out.push([`${file}:${i + 1}`, s]);
    }
  });
  return out;
}

test('prose on every served page uses no colon to introduce an explanation or a list', async t => {
  const f = await setup(t);
  const buyer = await f.as(BUYER);
  const [first] = (await buyer.get('/api/orders')).data.orders;
  const reads = [...SIGNED_OUT_PAGES.map(path => [f.anonymous, path]), ...['/dashboard', '/offers', '/orders', '/checkout', `/orders/${first.ref}`].map(path => [buyer, path]),
    [await f.as(LENDER), '/dashboard'], [await f.as(PROVIDER), '/provider'], [await f.as(ADMIN), '/admin']];
  const pairs = [];
  for (const [client, path] of reads) {
    const response = await client.get(path);
    assert.equal(response.status, 200, path);
    pairs.push(...proseBlocks(response.data).map(block => [path, block]));
  }
  assert.deepEqual(colonHits(pairs), []);
});

test('email subjects and bodies for the seeded accounts read without prose colons', async t => {
  const f = await setup(t);
  const buyer = await f.as(BUYER);
  await buyAndList(buyer);
  // Statement lines such as "Compute bill: $1,234.00" are a key and its value, not prose.
  const keyValue = line => /^[A-Z][A-Za-z ,'()-]{0,60}: \S/.test(line) && !/\. /.test(line);
  const pairs = [];
  for (const email of [BUYER, PROVIDER]) {
    const { emails } = (await (await f.as(email)).get('/api/emails')).data;
    assert.ok(emails.length, `${email} has emails`);
    for (const { subject, body } of emails) {
      pairs.push([`${email} subject`, subject], ...body.split('\n').filter(line => !keyValue(line)).map(line => [`${email}: ${subject}`, line]));
    }
  }
  assert.deepEqual(colonHits(pairs), []);
});

test('toasts, rendered sentences and tour step bodies use no prose colons', async () => {
  const { readFile } = await import('node:fs/promises');
  const pairs = [];
  for (const file of CLIENT_SOURCES) pairs.push(...sourceStrings(file, await readFile(new URL(`../${file}`, import.meta.url), 'utf8')));
  for (const [name, steps] of Object.entries(tours)) if (Array.isArray(steps)) for (const step of steps) pairs.push([`${name}: ${step.title}`, step.body || '']);
  assert.ok(pairs.length > 200, 'the sources were read');
  assert.deepEqual(colonHits(pairs), []);
});

test('the colon check flags an explanation colon and skips times, URLs and code', () => {
  assert.ok(proseColon('Three things matter: price, window and strike.'));
  assert.equal(proseColon('Starts 14:00 UTC at https://dodona.markets/docs.'), undefined);
  assert.deepEqual(proseBlocks('<p>Send it in the <code>Authorization: Bearer</code> header.</p>'), ['Send it in the header.']);
});

test('the copy check catches a banned word outside a disclaimer and ignores one inside', () => {
  assert.throws(() => assertClean(visibleText('<main><p>Your mock neocloud</p></main>'), 'probe'));
  assert.throws(() => assertClean(visibleText('<meta name="description" content="Demo console">'), 'probe'));
  assertClean(visibleText('<main><h2>Capacity <span class="tag d-tag-demo">demo data</span></h2><footer><p>Payouts are simulated.</p></footer><div class="c-strip"><b>Demo</b><span>a <b>mock</b> outbox</span></div></main>'), 'probe');
});

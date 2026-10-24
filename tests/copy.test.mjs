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

test('the copy check catches a banned word outside a disclaimer and ignores one inside', () => {
  assert.throws(() => assertClean(visibleText('<main><p>Your mock neocloud</p></main>'), 'probe'));
  assert.throws(() => assertClean(visibleText('<meta name="description" content="Demo console">'), 'probe'));
  assertClean(visibleText('<main><h2>Capacity <span class="tag d-tag-demo">demo data</span></h2><footer><p>Payouts are simulated.</p></footer><div class="c-strip"><b>Demo</b><span>a <b>mock</b> outbox</span></div></main>'), 'probe');
});

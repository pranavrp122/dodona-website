// Guided tour: every page with a Help button loads the tour files under the strict CSP, and every step reads well and points at something real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { platformFixture } from './fixture.mjs';
import * as steps from '../tour-steps.js';

const BANNED = /buyback|book-out|cash settlement|sell back|\brating\b|offshore/i;
const MAX_BODY = 280;
// Tour name → the page its steps live on.
const PAGES = {
  home: '/', dashboard: '/dashboard', lender: '/dashboard', provider: '/provider', admin: '/admin',
  order: '/orders/DOD-ABC123', orders: '/orders', offers: '/offers', checkout: '/checkout',
};
const TOUR_EXPORTS = {
  home: steps.homeTour, dashboard: steps.dashboardTour, lender: steps.lenderTour, provider: steps.providerTour, admin: steps.adminTour,
  order: steps.orderTour, orders: steps.ordersTour, offers: steps.offersTour, checkout: steps.checkoutTour,
};
// Targets the page's script renders after load; tests/tour-browser.mjs checks each one live.
const DYNAMIC = new Set([
  '[data-tour="detail-head"]', '[data-tour="terms"]', '[data-tour="what-if"]', '#p-acct-pop', 'section[aria-labelledby="d-set-bill"]',
  'section[aria-labelledby="a-acc-h"]', '[data-act="create-open"]', 'section[aria-labelledby="a-d-contact-h"]', 'section[aria-labelledby="a-d-notes-h"]',
  'section[aria-labelledby="a-d-orders-h"]', 'section[aria-labelledby="a-d-clock-h"]', 'section[aria-labelledby="a-orders-h"]', '[aria-labelledby^="a-nc-"]',
  'section[aria-labelledby="a-activity-h"]', 'section[aria-labelledby="a-sync-state-h"]', '#of-rows a[href^="/checkout"]',
]);

async function setup(t) { const f = await platformFixture(); t.after(() => f.cleanup()); return f; }

// The id and attribute hooks in a selector, as they would appear in HTML: #a → id="a", [b="c"] → b="c".
function hooks(selector) {
  const ids = [...selector.matchAll(/#([\w-]+)/g)].map(m => `id="${m[1]}"`);
  const attrs = [...selector.matchAll(/\[([\w-]+)([\^]?)="([^"]*)"\]/g)].map(([, name, prefix, value]) => `${name}="${value}${prefix ? '' : '"'}`);
  return [...ids, ...attrs];
}

test('every page with a Help button loads the tour files and stays free of inline scripts and style attributes', async t => {
  const f = await setup(t);
  for (const [name, path] of Object.entries(PAGES)) {
    const response = await fetch(f.origin + path);
    assert.equal(response.status, 200, path);
    const html = await response.text();
    assert.ok(html.includes('href="/tour.css"'), `${path}: tour stylesheet`);
    assert.ok(/(src|href)="\/tour\.js"/.test(html), `${path}: tour script`);
    assert.ok(name === 'home' ? html.includes('data-tour-start="home"') : html.includes('id="p-tour"'), `${path}: Help button`);
    for (const tag of html.match(/<script\b[^>]*>/g)) assert.ok(/\ssrc="\/[^"]+"/.test(tag) || tag.includes('application/ld+json'), `${path}: ${tag}`);
    assert.doesNotMatch(html, /\sstyle="|\son[a-z]+="/, path);
  }
  const signIn = await (await fetch(f.origin + '/sign-in')).text();
  assert.ok(!signIn.includes('id="p-tour"'), 'the sign-in page has no Help menu');
  for (const [path, type] of [['/tour.js', 'text/javascript'], ['/tour-steps.js', 'text/javascript'], ['/tour.css', 'text/css']]) {
    const response = await fetch(f.origin + path);
    assert.equal(response.status, 200, path);
    assert.ok(response.headers.get('content-type').startsWith(type), path);
  }
  const docker = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  for (const file of ['tour.js', 'tour-steps.js', 'tour.css']) assert.match(docker, new RegExp(`COPY [^\\n]*\\s${file.replace('.', '\\.')}\\s`), `Dockerfile copies ${file}`);
});

test('every step has a title and a short, plain body', () => {
  for (const [name, list] of Object.entries(TOUR_EXPORTS)) {
    assert.ok(list.length >= 3, `${name} has steps`);
    for (const step of list) {
      const label = `${name}: ${step.title}`;
      assert.ok(step.title?.trim(), `${name}: a step has no title`);
      assert.ok(step.body?.trim(), `${label}: body`);
      assert.ok(step.body.length < MAX_BODY, `${label}: ${step.body.length} characters`);
      assert.doesNotMatch(`${step.title} ${step.body}`, BANNED, label);
      assert.doesNotMatch(`${step.title} ${step.body}`, /!/, `${label}: no exclamation marks`);
      assert.ok(step.target === null || typeof step.target === 'string', `${label}: target`);
      if (step.placement) assert.ok(['top', 'bottom', 'left', 'right', 'auto'].includes(step.placement), `${label}: placement`);
    }
  }
});

test('every static step target is in the served page, and dynamic ones are listed for the browser pass', async t => {
  const f = await setup(t);
  const html = new Map();
  for (const path of new Set(Object.values(PAGES))) html.set(path, await (await fetch(f.origin + path)).text());
  for (const [name, list] of Object.entries(TOUR_EXPORTS)) {
    const page = html.get(PAGES[name]);
    for (const { target, title } of list) {
      if (!target || DYNAMIC.has(target)) continue;
      const found = hooks(target);
      assert.ok(found.length, `${name}: "${target}" uses an id or attribute hook`);
      for (const hook of found) assert.ok(page.includes(hook), `${name} · ${title}: ${hook} is on ${PAGES[name]}`);
    }
  }
});

test('each console path maps to its own tour, and role-only tours stay with their role', () => {
  assert.equal(steps.tourName('/dashboard', 'buyer'), 'dashboard');
  assert.equal(steps.tourName('/dashboard', 'lender'), 'lender');
  assert.equal(steps.tourName('/orders/DOD-ABC123', 'buyer'), 'order');
  for (const name of ['provider', 'admin', 'orders', 'offers', 'checkout']) assert.equal(steps.tourName(`/${name}`, 'buyer'), name);
  assert.equal(steps.tourName('/sign-in', 'buyer'), null);
  assert.equal(steps.tourFor('admin', { role: 'buyer' }), null);
  assert.equal(steps.tourFor('provider', { role: 'buyer' }), null);
  assert.equal(steps.tourFor('admin', { role: 'admin' }).key, 'admin');
  assert.equal(steps.tourFor('home').steps, steps.homeTour);
  assert.equal(steps.lenderTour[1].title, 'Rent shock', 'a lender starts with the Lender view');
  for (const name of ['dashboard', 'lender', 'provider', 'admin', 'order', 'orders', 'offers', 'checkout']) assert.ok(steps.tourFor(name, { role: name === 'provider' || name === 'admin' ? name : 'buyer' }).links.length, `${name} Help links`);
});

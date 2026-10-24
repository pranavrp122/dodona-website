// Guided tours in a real browser: for the home page and every console page, open Help, take the tour with Next to the end,
// check each spotlight sits on a visible target with the card fully on screen, then check the "new" dot is gone.
// Screenshots of two steps per tour at 1440 and 400 wide, light and dark. Fails on any console, CSP or script error.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { createApp } from '../server.mjs';
import { listen, close } from './fixture.mjs';
import * as steps from '../tour-steps.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const OUT = process.env.SHOTS_DIR || 'C:/Users/prana/AppData/Local/Temp/claude/C--Users-prana/95ec3bc8-242a-4566-a54d-6ad9c59b42ac/scratchpad/tour-shots/';
const PASSWORD = 'demo-dodona-2026';
const SIZES = [['1440', { width: 1440, height: 900 }], ['400', { width: 400, height: 860 }]];
const THEMES = ['light', 'dark'];

process.env.AUDIT_LOG_FILE ??= 'off';
await mkdir(OUT, { recursive: true });
const app = createApp({ store: null, platform: true, db: process.env.DEMO_DB_FILE || ':memory:', logger: { error() {} } });
const origin = process.env.PORT ? await new Promise(r => app.listen(Number(process.env.PORT), '127.0.0.1', () => r(`http://127.0.0.1:${process.env.PORT}`))) : await listen(app);
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined, headless: true });
const errors = [];
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; };

// One sign-in per account (the sign-in route is rate limited); later contexts reuse its cookie with fresh, empty localStorage.
const sessions = new Map();
async function context(email, viewport, theme) {
  if (email && !sessions.has(email)) {
    const login = await browser.newContext();
    const response = await login.request.post(`${origin}/api/auth/sign-in`, { headers: { Origin: origin }, data: { email, password: PASSWORD } });
    check(response.ok(), `${email} signs in`);
    sessions.set(email, { cookies: (await login.storageState()).cookies, origins: [] });
    await login.close();
  }
  return browser.newContext({ viewport, colorScheme: theme, reducedMotion: 'reduce', storageState: email ? sessions.get(email) : undefined });
}

// A buyer order ref and an offer id, so the order and checkout pages have something to show.
async function seededPaths() {
  const ctx = await context('demo@dodona.markets', SIZES[0][1], 'light');
  const orders = await (await ctx.request.get(`${origin}/api/orders`)).json();
  const offers = await (await ctx.request.get(`${origin}/api/offers`)).json();
  await ctx.close();
  const ref = orders.orders?.[0]?.ref;
  const offer = (offers.offers || [])[0]?.id;
  assert.ok(ref && offer, 'the seed has an order and an offer');
  return { order: `/orders/${encodeURIComponent(ref)}`, checkout: `/checkout?offer=${encodeURIComponent(offer)}` };
}

// Which steps get a screenshot: the second one shown and one near the middle.
const shotAt = (shown, total) => shown === 2 || shown === Math.max(3, Math.ceil(total / 2) + 1);

async function stepState(page, list) {
  return page.evaluate(selectors => {
    const root = document.querySelector('.tour');
    if (!root) return { closed: true };
    const index = Number(root.dataset.step);
    const selector = selectors[index];
    const target = selector ? [...document.querySelectorAll(selector)].find(el => el.getClientRects().length) : null;
    const box = node => { const r = node.getBoundingClientRect(); return { top: r.top, left: r.left, bottom: r.bottom, right: r.right, width: r.width, height: r.height }; };
    // What a reader can see of the target: cut by scrolling ancestors (a panel that scrolls inside the page) and by the viewport.
    const seen = node => {
      let { top, left, bottom, right } = node.getBoundingClientRect();
      for (let p = node.parentElement; p && p !== document.body; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
        const c = p.getBoundingClientRect();
        top = Math.max(top, c.top); left = Math.max(left, c.left); bottom = Math.min(bottom, c.bottom); right = Math.min(right, c.right);
      }
      top = Math.max(top, 0); left = Math.max(left, 0); bottom = Math.min(bottom, innerHeight); right = Math.min(right, document.documentElement.clientWidth);
      return { top, left, bottom, right, width: right - left, height: bottom - top, full: node.getBoundingClientRect().height };
    };
    const spot = document.querySelector('.tour-spot');
    return {
      index, title: document.querySelector('.tour-title').textContent, count: document.querySelector('.tour-count').textContent,
      next: document.querySelector('.tour-next').textContent, card: box(document.querySelector('.tour-card')),
      spot: spot.hidden ? null : box(spot), target: target ? seen(target) : null, hasSelector: !!selector,
      vw: document.documentElement.clientWidth, vh: window.innerHeight,
    };
  }, list.map(s => s.target));
}

async function nextStep(page, previous) {
  await page.click('.tour-next');
  await page.waitForFunction(prev => {
    const root = document.querySelector('.tour');
    return !root || (!root.hasAttribute('aria-busy') && root.dataset.step !== prev);
  }, previous, { timeout: 30000 });
}

async function openTour(page, name) {
  if (name === 'home') {
    const button = page.locator('[data-tour-start="home"]:visible').first();
    check(await button.locator('.tour-dot').count() === 1, `${name}: the Help button shows the new dot`);
    await button.click();
    return button;
  }
  await page.waitForSelector('#p-tour-btn');
  check(await page.locator('#p-tour-btn .tour-dot').count() === 1, `${name}: the Help button shows the new dot`);
  await page.click('#p-tour-btn');
  check(await page.locator('#p-tour-pop').isVisible(), `${name}: the Help menu opens`);
  check(await page.locator('#p-tour-pop a.c-menu-item').count() >= 1, `${name}: the Help menu has a link`);
  await page.click('#p-tour-pop [data-shell="tour"]');
  return page.locator('#p-tour-btn');
}

async function runTour({ name, key, email, path, ready, list }, [sizeName, viewport], theme) {
  const ctx = await context(email, viewport, theme);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${name} ${sizeName} ${theme}: ${e.message}`));
  // The waitlist answers 503 here on purpose: this script runs without a signup store.
  page.on('console', m => { if (m.type() === 'error' && !m.location()?.url?.includes('/api/waitlist/')) errors.push(`${name} ${sizeName} ${theme}: ${m.text()} ${m.location()?.url || ''}`); });
  await page.goto(origin + path);
  await page.waitForSelector(ready, { timeout: 15000 });
  const opener = await openTour(page, name);
  await page.waitForSelector('.tour.is-on:not([aria-busy])', { timeout: 20000 });
  const seen = [];
  for (let guard = 0; guard < 40; guard++) {
    const s = await stepState(page, list);
    if (s.closed) break;
    const label = `${name} ${sizeName} ${theme} · ${s.title}`;
    check(!s.hasSelector || s.target, `${label}: the target is on the page`);
    if (s.target) {
      check(s.spot && s.spot.width > 0 && s.spot.height > 0, `${label}: the spotlight shows`);
      check(s.target.height > Math.min(24, s.target.full - 1) && s.target.width > 0, `${label}: the target is in view`);
      const covers = s.spot.left <= s.target.left + 3 && s.spot.right >= s.target.right - 3 && s.spot.top <= s.target.top + 3 && s.spot.bottom >= s.target.bottom - 3;
      check(covers, `${label}: the spotlight covers what shows of the target ${JSON.stringify({ spot: s.spot, target: s.target })}`);
    }
    check(s.card.left >= 0 && s.card.right <= s.vw + 0.5 && s.card.top >= 0 && s.card.bottom <= s.vh + 0.5, `${label}: the card is fully on screen`);
    const [shown, total] = s.count.split(' of ').map(Number);
    seen.push(s.title);
    if (shotAt(shown, total)) await page.screenshot({ path: `${OUT}${name}-${sizeName}-${theme}-step${shown}.png` });
    if (s.next === 'Done') {
      check(shown === total, `${label}: the last step reads ${total} of ${total}`);
      await page.click('.tour-next');
      break;
    }
    await nextStep(page, String(s.index));
  }
  await page.waitForSelector('.tour', { state: 'detached' });
  check(seen.length >= 3, `${name} ${sizeName} ${theme}: walked ${seen.length} steps`);
  check(await page.evaluate(k => localStorage.getItem(`dodonaTour.${k}`), key) === 'seen', `${name}: the tour is marked seen`);
  check(await page.locator('.tour-dot').count() === 0, `${name}: the dot is gone`);
  check(await opener.evaluate(el => el === document.activeElement), `${name}: focus returns to the Help button`);
  await ctx.close();
  return seen;
}

// Keyboard: Right moves on, Left goes back, Escape closes and still counts as seen; clicks outside the card do nothing.
async function keyboardCheck(tour) {
  const ctx = await context(tour.email, SIZES[0][1], 'light');
  const page = await ctx.newPage();
  await page.goto(origin + tour.path);
  await page.waitForSelector(tour.ready, { timeout: 15000 });
  await openTour(page, tour.name);
  await page.waitForSelector('.tour.is-on:not([aria-busy])');
  const first = await page.locator('.tour-title').textContent();
  check(await page.evaluate(() => document.activeElement?.classList.contains('tour-next')), 'focus moves into the card');
  await page.mouse.click(5, 300);
  check(await page.locator('.tour').count() === 1 && await page.locator('.tour-title').textContent() === first, 'a click outside the card does nothing');
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(t => document.querySelector('.tour-title')?.textContent !== t && !document.querySelector('.tour')?.hasAttribute('aria-busy'), first);
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(t => document.querySelector('.tour-title')?.textContent === t && !document.querySelector('.tour')?.hasAttribute('aria-busy'), first);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.tour', { state: 'detached' });
  check(await page.evaluate(k => localStorage.getItem(`dodonaTour.${k}`), tour.key) === 'seen', 'Escape counts as seen');
  await ctx.close();
}

try {
  const paths = await seededPaths();
  const TOURS = [
    { name: 'home', key: 'home', email: null, path: '/', ready: '#co-q-upfront:not(:empty)', list: steps.homeTour },
    { name: 'dashboard', key: 'dashboard', email: 'demo@dodona.markets', path: '/dashboard', ready: 'body[data-portfolio="loaded"]', list: steps.dashboardTour },
    { name: 'lender', key: 'lender', email: 'credit@meridian.example', path: '/dashboard', ready: 'body[data-portfolio="loaded"]', list: steps.lenderTour },
    { name: 'provider', key: 'provider', email: 'ops@northwind.example', path: '/provider', ready: 'body[data-portal="loaded"]', list: steps.providerTour },
    { name: 'admin', key: 'admin', email: 'admin@dodona.markets', path: '/admin', ready: 'body[data-admin="ready"]', list: steps.adminTour },
    { name: 'order', key: 'order', email: 'demo@dodona.markets', path: paths.order, ready: 'body[data-ready="1"]', list: steps.orderTour },
    { name: 'orders', key: 'orders', email: 'demo@dodona.markets', path: '/orders', ready: 'body[data-ready="1"]', list: steps.ordersTour },
    { name: 'offers', key: 'offers', email: 'demo@dodona.markets', path: '/offers', ready: 'body[data-ready="1"]', list: steps.offersTour },
    { name: 'checkout', key: 'checkout', email: 'demo@dodona.markets', path: paths.checkout, ready: 'body[data-ready="1"]', list: steps.checkoutTour },
  ];
  const only = process.env.TOURS ? process.env.TOURS.split(',') : null;
  for (const tour of TOURS.filter(t => !only || only.includes(t.name))) {
    for (const size of SIZES) {
      for (const theme of THEMES) {
        const seen = await runTour(tour, size, theme);
        console.log(`${tour.name} ${size[0]} ${theme}: ${seen.length} steps · ${seen.join(' → ')}`);
      }
    }
  }
  if (!only || only.includes('dashboard')) await keyboardCheck(TOURS[1]);
  assert.deepEqual(errors, [], 'no console, CSP or script errors');
  console.log(`tour browser checks passed: ${checks}`);
} finally {
  await browser.close();
  await close(app);
}

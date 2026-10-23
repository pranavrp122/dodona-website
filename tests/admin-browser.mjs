// Admin portal flow in a real browser: sign in as the seeded admin, open Sample Labs, add a note, change the stage,
// run Sync now with the mirror unconfigured, and check the gate for a buyer. Screenshots at 1440 and 400 in both themes.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../server.mjs';
import { close } from './fixture.mjs';

process.env.AUDIT_LOG_FILE ??= 'off';
const OUT = process.env.ADMIN_SHOTS || join(process.cwd(), 'artifacts', 'admin');
const PORT = Number(process.env.PORT || 3114);
const PASSWORD = 'demo-dodona-2026';
await mkdir(OUT, { recursive: true });

const app = createApp({ store: null, platform: true, db: ':memory:', environment: {}, logger: { log() {}, error() {} } });
await new Promise((resolve, reject) => { app.once('error', reject); app.listen(PORT, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined, headless: true });
const errors = [];
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; };

async function session(email, { width = 1440, scheme = 'light', video = false } = {}) {
  const context = await browser.newContext({
    viewport: { width, height: width > 600 ? 1000 : 860 }, colorScheme: scheme, reducedMotion: 'reduce', timezoneId: 'UTC',
    ...(video ? { recordVideo: { dir: OUT, size: { width: 1440, height: 1000 } } } : {}),
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  if (email) {
    const response = await context.request.post(origin + '/api/auth/sign-in', { headers: { Origin: origin }, data: { email, password: PASSWORD } });
    check(response.ok(), `sign in as ${email}`);
  }
  return { context, page };
}

const ready = page => page.waitForFunction(() => document.body.dataset.admin === 'ready');
const shot = (page, name) => page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });

async function mainFlow() {
  const { context, page } = await session('admin@dodona.markets', { video: true });
  await page.goto(origin + '/admin');
  await ready(page);
  await page.waitForSelector('#a-acc-rows .a-row');
  check(await page.locator('#a-acc-rows .a-row').count() >= 4, 'the seeded accounts are listed');
  await page.fill('#a-q', 'sample');
  await page.waitForFunction(() => document.querySelectorAll('#a-acc-rows .a-row').length === 1);
  check((await page.locator('#a-acc-rows').innerText()).includes('Sample Labs'), 'search finds Sample Labs');
  await page.fill('#a-q', '');
  await page.waitForFunction(() => document.querySelectorAll('#a-acc-rows .a-row').length >= 4);
  await shot(page, 'accounts-1440-light');

  await page.locator('#a-acc-rows .a-row', { hasText: 'Sample Labs' }).click();
  await page.waitForSelector('#a-contact');
  check((await page.locator('#a-title').innerText()) === 'Sample Labs', 'account detail opens');
  check(await page.locator('#a-d-orders-h').isVisible(), 'orders container shows');
  const note = 'Walked the founders through caps and floors; follow up on Friday.';
  await page.fill('#a-note-text', note);
  await page.click('#a-note-form [type=submit]');
  await page.waitForFunction(text => document.querySelector('.a-notes')?.textContent.includes(text), note);
  await page.selectOption('#a-e-stage', 'active');
  await page.click('#a-contact [type=submit]');
  await page.waitForFunction(() => document.querySelector('#a-d-contact-h')?.closest('.c-ctr').textContent.includes('Active'));
  await page.click('[data-act="reset"]');
  check(await page.locator('[data-act="reset-confirm"]').isVisible(), 'reset asks for confirmation');
  await page.click('[data-act="reset-cancel"]');
  await shot(page, 'account-1440-light');

  for (const name of ['orders', 'neoclouds', 'activity']) {
    await page.goto(`${origin}/admin#${name}`);
    await page.waitForFunction(n => document.querySelector(`[data-nav="${n}"]`)?.getAttribute('aria-current') === 'page' && !document.querySelector('#a-screen > .d-empty'), name);
    await shot(page, `${name}-1440-light`);
  }

  await page.goto(origin + '/admin#sync');
  await page.waitForSelector('[data-act="sync-now"]');
  await page.click('[data-act="sync-now"]');
  await page.waitForFunction(() => !document.getElementById('a-sync-msg')?.hidden);
  const message = await page.locator('#a-sync-msg').innerText();
  check(/not configured/i.test(message), `Sync now is honest when unconfigured: ${message}`);
  await shot(page, 'sync-1440-light');

  const csv = await context.request.get(origin + '/api/admin/accounts.csv');
  check(csv.ok() && (await csv.text()).includes('Sample Labs'), 'CSV export downloads');
  await context.close();
}

async function themeAndWidthShots() {
  for (const [width, scheme] of [[1440, 'dark'], [400, 'light'], [400, 'dark']]) {
    const { context, page } = await session('admin@dodona.markets', { width, scheme });
    await page.goto(origin + '/admin');
    await ready(page);
    await page.waitForSelector('#a-acc-rows .a-row');
    await shot(page, `accounts-${width}-${scheme}`);
    await page.locator('#a-acc-rows .a-link', { hasText: 'Sample Labs' }).click();
    await page.waitForSelector('#a-contact');
    await shot(page, `account-${width}-${scheme}`);
    await page.goto(origin + '/admin#sync');
    await page.waitForSelector('[data-act="sync-now"]');
    await shot(page, `sync-${width}-${scheme}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(overflow <= 0, `no sideways scroll at ${width} ${scheme} (${overflow}px)`);
    await context.close();
  }
}

async function gates() {
  const anon = await session(null);
  await anon.page.goto(origin + '/admin');
  await anon.page.waitForSelector('#a-gate:not([hidden])');
  check((await anon.page.locator('#a-gate-h').innerText()) === 'Sign in as an admin', 'signed-out visitors see the admin gate');
  await shot(anon.page, 'gate-signed-out-1440-light');
  await anon.context.close();
  const buyer = await session('demo@dodona.markets');
  await buyer.page.goto(origin + '/admin');
  await buyer.page.waitForSelector('#a-gate:not([hidden])');
  check((await buyer.page.locator('#a-gate-say').innerText()).includes('demo@dodona.markets'), 'a buyer is told to sign in as an admin');
  check((await buyer.context.request.get(origin + '/api/admin/accounts')).status() === 403, 'the admin API refuses a buyer');
  await shot(buyer.page, 'gate-buyer-1440-light');
  await buyer.context.close();
}

try {
  await gates();
  await mainFlow();
  await themeAndWidthShots();
  check(errors.length === 0, `no page or console errors: ${errors.join(' | ')}`);
  console.log(`Admin browser flow passed ${checks} checks. Screenshots in ${OUT}`);
} finally {
  await browser.close();
  await close(app);
}

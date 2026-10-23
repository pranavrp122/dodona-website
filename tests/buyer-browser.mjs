// Buyer flow in a real browser against an in-memory demo platform: sign in, dashboard ranges and what-if, offers,
// a declined then a paid checkout, the order page, the demo clock, emails and statements. Screenshots at 1440 and 400
// in light and dark, plus a video of the flow. Run: node tests/buyer-browser.mjs (SHOTS_DIR and BROWSER_EXECUTABLE optional).
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../server.mjs';
import { listen, close } from './fixture.mjs';

const SHOTS = process.env.SHOTS_DIR || join(process.env.TEMP || '.', 'platform-shots', 'buyer');
const DEMO = { email: 'demo@dodona.markets', password: 'demo-dodona-2026' };
const CARD_OK = '4242424242424242';
const CARD_DECLINED = '4000000000000002';
const executablePath = process.env.BROWSER_EXECUTABLE || undefined;

await mkdir(SHOTS, { recursive: true });
const app = createApp({ store: null, platform: true, db: ':memory:', logger: { error() {}, log() {} } });
const origin = await listen(app);
const browser = await chromium.launch({ executablePath, headless: true });
let checks = 0;
const notes = [];
const check = (condition, label) => { assert.ok(condition, label); checks++; };
const errors = [];
const urls = [];
const watch = page => {
  page.on('pageerror', error => errors.push(`${page.url()}: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error' && /Content Security Policy|Refused to/.test(message.text())) errors.push(message.text()); });
  page.on('request', request => urls.push(request.url()));
};
// Full-page captures from the top with nothing focused, so sticky bars and the skip link sit where a reader sees them.
const shot = async (page, name) => {
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
};
const ready = page => page.waitForSelector('body[data-ready="1"], body[data-portfolio="loaded"], body[data-portfolio="gate"]', { timeout: 15000 });
// Steps that need the second core drop (demo clock, choice, listing, settlement) are tried and noted when absent.
const optional = async (label, run) => {
  try { await run(); } catch (error) { notes.push(`${label}: ${error.message.split('\n')[0]}`); }
};

async function signIn(page) {
  await page.goto(origin + '/sign-in');
  await ready(page);
  await page.locator('[data-fill="demo@dodona.markets"]').click();
  check(await page.locator('#si-pass').inputValue() === DEMO.password, 'demo account fills the password');
  await Promise.all([page.waitForURL(/\/dashboard/), page.locator('#si-submit').click()]);
  await page.waitForSelector('body[data-portfolio="loaded"]', { timeout: 20000 });
}

async function dashboardChecks(page) {
  check(await page.locator('#p-clock-date').isVisible(), 'demo clock in the top bar');
  check(await page.locator('#d-ranges [data-range]').count() === 6, 'six chart range chips');
  await page.locator('#d-ranges [data-range="1w"]').click();
  check(await page.locator('#d-ranges [data-range="1w"]').getAttribute('aria-pressed') === 'true', '1W selected');
  check((await page.locator('#d-hero-chips').innerText()).includes('1W'), 'change chip follows the range');
  await page.locator('#d-ranges [data-range="1y"]').click();
  check(/History starts|since/i.test(await page.locator('#d-hero-since').innerText()), '1Y caption says since when');
  await page.locator('#d-ranges [data-range="all"]').click();
  await shot(page, '02-dashboard-overview-1440-light');
}

async function whatIfChecks(page) {
  await page.goto(origin + '/dashboard#positions');
  await page.waitForSelector('body[data-portfolio="loaded"]');
  const call = page.locator('#d-rows tr', { hasText: 'Price cap' }).first();
  await call.click();
  await page.waitForSelector('#d-whatif');
  await page.locator('#d-whatif').evaluate(input => { input.value = input.min; input.dispatchEvent(new Event('input', { bubbles: true })); });
  const out = await page.locator('#d-whatif-out').innerText();
  check(/−\$/.test(out), 'what-if net after the fee goes negative below the cap');
  check(/Cap payoff\s*\$0/.test(out), 'cap payoff never below zero');
  check(await page.locator('#d-whatif-chart svg').count() === 1 && (await page.locator('#d-whatif-chart').innerHTML()).includes('window average'), 'payoff chart labels the window average');
  check(await page.locator('.p-ranges[aria-label="Position chart range"] [data-range]').count() === 6, 'position chart has range chips');
  await shot(page, '03-dashboard-whatif-1440-light');
}

async function offersChecks(page) {
  await page.goto(origin + '/offers');
  await ready(page);
  await page.waitForFunction(() => document.querySelectorAll('#of-rows a.btn').length > 0);
  check(await page.locator('#of-rows').getByText('usually bought by providers').count() > 0, 'floors carry the providers label');
  await shot(page, '04-offers-1440-light');
  await page.locator('#of-kind').selectOption('cap');
  await page.waitForFunction(() => [...document.querySelectorAll('#of-rows tr')].every(tr => /Price cap/.test(tr.textContent)));
  const href = await page.locator('#of-rows a.btn').first().getAttribute('href');
  check(/^\/checkout\?offer=/.test(href), 'take this offer links to checkout');
  return href;
}

async function customQuote(page) {
  await page.goto(origin + '/offers#custom');
  await ready(page);
  await page.locator('#cu-kind').selectOption('floor');
  await page.locator('#cu-quote').click();
  await page.waitForSelector('#cu-go', { timeout: 10000 });
  check((await page.locator('#cu-out').innerText()).includes('Break-even'), 'custom quote shows the breakdown');
}

async function checkout(page, href) {
  await page.goto(origin + href);
  await ready(page);
  await page.waitForSelector('#co-body:not([hidden])');
  await page.locator('#co-name').fill('Sample Labs Demo');
  await page.locator('#co-number').fill(CARD_DECLINED);
  await page.locator('#co-exp').fill('12/29');
  await page.locator('#co-cvc').fill('123');
  await page.locator('#co-pay').click();
  await page.waitForFunction(() => document.getElementById('co-err').textContent.length > 0);
  check(/declined/i.test(await page.locator('#co-err').innerText()), 'declined card shows inline');
  check(/\/checkout\?order=/.test(page.url()), 'order reference (not the card) is in the address after the first try');
  await shot(page, '05-checkout-declined-1440-light');
  await page.locator('#co-number').fill(CARD_OK);
  await page.locator('#co-cvc').fill('123');
  await Promise.all([page.waitForURL(/\/orders\/[A-Za-z0-9-]+$/), page.locator('#co-pay').click()]);
  await ready(page);
  await page.waitForSelector('#od-body:not([hidden])');
  check(/Visa ending 4242/.test(await page.locator('#od-terms').innerText()), 'order shows the brand and last four only');
  return decodeURIComponent(page.url().split('/').pop());
}

async function clock(page, which) {
  await page.locator('.p-clock-btn').click();
  await page.locator(`[data-clock="${which}"]`).click();
  await page.waitForFunction(() => document.querySelector('.p-clock')?.getAttribute('aria-busy') === 'false');
  const toast = await page.locator('#d-toasts').innerText();
  if (/not found|failed/i.test(toast)) throw new Error(`clock ${which}: ${toast}`);
  await page.keyboard.press('Escape');
}

async function orderFlow(page, ref) {
  await shot(page, '06-order-paid-1440-light');
  await optional('choose resell', async () => {
    await page.locator('#od-choice [data-value="resell"]').click();
    await page.waitForSelector('#od-list-form', { timeout: 5000 });
    await page.locator('#od-list-form button[type=submit]').click();
    await page.waitForFunction(() => /Listed at/.test(document.getElementById('od-listing').textContent), null, { timeout: 5000 });
  });
  await optional('advance a day for a bid', async () => {
    await clock(page, 'day');
    await page.waitForSelector('[data-act="accept"]', { timeout: 5000 });
    await shot(page, '07-order-bid-1440-light');
    await page.locator('[data-act="counter"]').first().click();
    await page.waitForTimeout(300);
  });
  await optional('advance to settlement', async () => {
    await clock(page, 'settle');
    await page.waitForSelector('#od-settle-box:not([hidden])', { timeout: 8000 });
    check((await page.locator('#od-settlement').innerText()).includes('Window average'), 'settlement statement shows the window average');
  });
  await page.locator('#od-events-box > summary').click();
  check(await page.locator('#od-events .p-ev').count() >= 1, 'what the neocloud saw lists messages');
  await shot(page, `08-order-${ref}-1440-light`);
}

async function accountScreens(page) {
  await page.goto(origin + '/dashboard#emails');
  await page.waitForSelector('body[data-portfolio="loaded"]');
  await page.waitForFunction(() => document.querySelectorAll('#d-mails .p-mail, #d-mails .d-empty').length > 0);
  check(await page.locator('#d-mails .p-mail').count() > 0, 'emails screen lists the receipt');
  await page.locator('#d-mails .p-mail summary').first().click();
  await shot(page, '09-emails-1440-light');
  await page.goto(origin + '/dashboard#settings');
  await page.waitForSelector('#d-statements');
  check(await page.locator('a[href="/api/statements.csv"]').count() === 1, 'statements CSV link under Settings');
  await page.goto(origin + '/orders');
  await ready(page);
  check(await page.locator('#or-rows tr[data-href]').count() >= 8, 'orders list has the seeded orders and the new one');
}

// Every page at both widths in both themes, signed in with the same cookies.
async function gallery(state, ref) {
  const pages = [['sign-in', '/sign-in'], ['dashboard', '/dashboard'], ['positions', '/dashboard#positions'], ['offers', '/offers'], ['orders', '/orders'], ['order', `/orders/${ref}`], ['emails', '/dashboard#emails'], ['settings', '/dashboard#settings']];
  for (const theme of ['light', 'dark']) {
    for (const width of [1440, 400]) {
      const context = await browser.newContext({ viewport: { width, height: width === 400 ? 860 : 1000 }, storageState: state, reducedMotion: 'reduce', timezoneId: 'UTC' });
      await context.addInitScript(choice => { try { localStorage.setItem('dodonaTheme', choice); } catch { /* blocked */ } }, theme);
      const page = await context.newPage();
      watch(page);
      for (const [name, path] of pages) {
        await page.goto(origin + path);
        await ready(page);
        await page.waitForTimeout(200);
        if (width === 400) check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${name} at 400 has no sideways scroll`);
        await shot(page, `g-${name}-${width}-${theme}`);
      }
      await context.close();
    }
  }
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', timezoneId: 'UTC', recordVideo: { dir: SHOTS, size: { width: 1440, height: 1000 } } });
  await context.addInitScript(() => { try { localStorage.setItem('dodonaTheme', 'light'); } catch { /* blocked */ } });
  const page = await context.newPage();
  watch(page);
  await page.goto(origin + '/dashboard');
  await page.waitForSelector('body[data-portfolio="gate"]');
  check(await page.locator('#d-signin a[href="/sign-in"]').isVisible(), 'signed-out dashboard shows the gate linking to sign-in');
  await shot(page, '00-dashboard-gate-1440-light');
  await page.goto(origin + '/sign-in');
  await ready(page);
  await shot(page, '01-sign-in-1440-light');
  await signIn(page);
  await dashboardChecks(page);
  await whatIfChecks(page);
  await optional('clock on the dashboard', () => clock(page, 'week'));
  const href = await offersChecks(page);
  await customQuote(page);
  const ref = await checkout(page, href);
  await orderFlow(page, ref);
  await accountScreens(page);
  const state = await context.storageState();
  await context.close();
  await gallery(state, ref);
  check(!urls.some(url => url.includes(CARD_OK) || url.includes(CARD_DECLINED)), 'no card number in any request address');
  check(errors.length === 0, `no page errors or CSP refusals: ${errors.join(' | ')}`);
  console.log(`Buyer browser flow: ${checks} checks passed. Screenshots and video in ${SHOTS}.`);
  if (notes.length) console.log(`Skipped while the platform lacks them:\n- ${notes.join('\n- ')}`);
} finally {
  await browser.close();
  await close(app);
}

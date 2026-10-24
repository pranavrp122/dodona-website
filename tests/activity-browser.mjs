// Activity log in a real browser: Sample Labs clicks through Overview, Positions and Offers and pays with the declining
// card; then the admin opens Sample Labs and finds those clicks, page views and the failed payment with its code.
// Screenshots of the log and the cross-account failures at 1440 and 400 in light and dark.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../server.mjs';
import { close } from './fixture.mjs';

process.env.AUDIT_LOG_FILE ??= 'off';
const OUT = process.env.ACTIVITY_SHOTS || join(process.cwd(), 'artifacts', 'activity');
const PORT = Number(process.env.PORT || 3141);
const PASSWORD = 'demo-dodona-2026';
const CARD_DECLINED = '4000000000000002';
const FAILURES = 'section[aria-labelledby="a-failures-h"]';
await mkdir(OUT, { recursive: true });

const app = createApp({ store: null, platform: true, db: ':memory:', logger: { log() {}, error() {} } });
await new Promise((resolve, reject) => { app.once('error', reject); app.listen(PORT, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined, headless: true });
const errors = [];
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; };

async function session(email, { width = 1440, scheme = 'light' } = {}) {
  const context = await browser.newContext({ viewport: { width, height: width > 600 ? 1000 : 860 }, colorScheme: scheme, reducedMotion: 'reduce', timezoneId: 'UTC' });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(`${email}: ${error.message}`));
  // The declined card answers 402 on purpose; any other console error (a CSP violation included) fails the run.
  page.on('console', message => { if (message.type() === 'error' && !/status of 402\b/.test(message.text())) errors.push(`${email}: ${message.text()}`); });
  const response = await context.request.post(origin + '/api/auth/sign-in', { headers: { Origin: origin }, data: { email, password: PASSWORD } });
  check(response.ok(), `sign in as ${email}`);
  return { context, page };
}

async function buyerFlow() {
  const { context, page } = await session('demo@dodona.markets');
  await page.goto(origin + '/dashboard');
  await page.waitForSelector('body[data-portfolio="loaded"]', { timeout: 20000 });
  await page.locator('#d-rail [data-nav="positions"]').click();
  await page.waitForFunction(() => location.hash === '#positions');
  await page.locator('#d-rail [data-nav="overview"]').click();
  await page.waitForFunction(() => location.hash === '#overview');
  await Promise.all([page.waitForURL(/\/offers$/), page.locator('#d-rail [data-nav="offers"]').click()]);
  await page.waitForFunction(() => document.querySelectorAll('#of-rows a.btn').length > 0);
  await page.locator('#of-kind').selectOption('cap');
  await page.waitForFunction(() => [...document.querySelectorAll('#of-rows tr')].every(tr => /Price cap/.test(tr.textContent)));
  await Promise.all([page.waitForURL(/\/checkout\?/), page.locator('#of-rows a.btn').first().click()]);
  await page.waitForSelector('#co-body:not([hidden])');
  await page.locator('#co-name').fill('Sample Labs Demo');
  await page.locator('#co-number').fill(CARD_DECLINED);
  await page.locator('#co-exp').fill('12/29');
  await page.locator('#co-cvc').fill('123');
  await page.locator('#co-pay').click();
  await page.waitForFunction(() => document.getElementById('co-err').textContent.length > 0);
  // Let the three-second batch go out; closing the page then sends anything left by sendBeacon.
  await page.waitForTimeout(3500);
  await context.close();
}

async function openSampleLabs(page) {
  await page.goto(origin + '/admin#accounts');
  await page.waitForFunction(() => document.body.dataset.admin === 'ready');
  await page.locator('#a-acc-rows .a-row', { hasText: 'Sample Labs' }).click();
  await page.waitForFunction(() => document.querySelectorAll('#a-act-rows tr:not(:has(.d-empty))').length > 0, null, { timeout: 10000 });
}

async function adminChecks() {
  const { context, page } = await session('admin@dodona.markets');
  await openSampleLabs(page);
  const log = await page.locator('#a-act-rows').innerText();
  for (const text of ['Clicked Positions on /dashboard', 'Clicked Overview on /dashboard#positions', 'Clicked Offers on /dashboard#overview', 'Viewed /dashboard#positions', 'Opened /dashboard', 'Opened /offers', 'Opened /checkout?offer']) {
    check(log.includes(text), `the log shows "${text}"`);
  }
  check(/POST \/api\/orders\/DOD-[A-Z]+\/pay 402 card_declined/.test(log), 'the log shows the declined payment with its code');
  check(log.includes('Failed · card declined'), 'the declined payment has a failed result pill');
  check(/GET \/api\/portfolio 200 in \d+ ms/.test(log), 'the dashboard data call is logged with its time');
  check(!log.includes(CARD_DECLINED) && !log.includes('Sample Labs Demo'), 'no card number or cardholder name in the log');

  await page.locator('[data-act="act-failed"]').click();
  await page.waitForFunction(() => [...document.querySelectorAll('#a-act-rows tr')].every(tr => tr.classList.contains('a-act-fail')));
  check((await page.locator('#a-act-rows').innerText()).includes('card_declined'), 'only failures keeps the declined payment');
  await page.locator('[data-act="act-failed"]').click();
  await page.locator('[data-act="act-kind"][data-kind="click"]').click();
  await page.waitForFunction(() => [...document.querySelectorAll('#a-act-rows tr')].every(tr => tr.textContent.includes('Clicked')));
  check((await page.locator('#a-act-csv').getAttribute('href')).includes('kind=click'), 'the CSV link follows the filter');
  const allClicks = await page.locator('#a-act-rows tr').count();
  await page.locator('#a-act-q').fill('Positions');
  await page.waitForFunction(n => { const rows = [...document.querySelectorAll('#a-act-rows tr')]; return rows.length < n && rows.every(tr => /positions/i.test(tr.textContent)); }, allClicks);
  check((await page.locator('#a-act-rows').innerText()).includes('Clicked Positions'), 'search narrows the log');
  const csv = await context.request.get(origin + await page.locator('#a-act-csv').getAttribute('href'));
  check(csv.ok() && (await csv.text()).startsWith('at,kind,result'), 'the CSV export downloads');

  await page.goto(origin + '/admin#activity');
  await page.waitForSelector('#a-failures-h');
  const failures = await page.locator(FAILURES).innerText();
  check(failures.includes('card_declined') && failures.includes('Sample Labs'), 'recent failures lists the declined payment with the account');
  await Promise.all([page.waitForFunction(() => location.hash.startsWith('#account/')), page.locator(FAILURES + ' a.a-link').first().click()]);
  await page.waitForSelector('#a-act-rows');
  check((await page.locator('#a-title').innerText()) === 'Sample Labs', 'the failure links to the account');
  await context.close();
}

async function screenshots() {
  for (const width of [1440, 400]) {
    for (const scheme of ['light', 'dark']) {
      const { context, page } = await session('admin@dodona.markets', { width, scheme });
      await openSampleLabs(page);
      await page.locator('#a-act-rows details summary').first().click();
      // A phone shot is the viewport scrolled to the log, so the fixed top bar and tab bar show as they would on the device.
      const capture = async (selector, name) => {
        if (width > 600) return page.locator(selector).screenshot({ path: join(OUT, `${name}-${width}-${scheme}.png`) });
        await page.locator(selector).evaluate(el => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 70));
        return page.screenshot({ path: join(OUT, `${name}-${width}-${scheme}.png`) });
      };
      await capture('#a-d-activity-slot', 'account-log');
      await page.goto(origin + '/admin#activity');
      await page.waitForSelector('#a-failures-h');
      await capture(FAILURES, 'failures');
      check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `no page overflow at ${width} ${scheme}`);
      await context.close();
    }
  }
}

try {
  await buyerFlow();
  await adminChecks();
  await screenshots();
  check(errors.length === 0, `no page or console errors: ${errors.join(' | ')}`);
  console.log(JSON.stringify({ activityChecksPassed: checks, screenshots: OUT }, null, 2));
} finally {
  await browser.close();
  await close(app);
}

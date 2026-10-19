import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { createApp } from '../server.mjs';
import { listen, close } from './fixture.mjs';

const require = createRequire(import.meta.url);
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const app = createApp({ store: null });
const origin = await listen(app);
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; };
const errors = [];
const writes = [];
const watch = page => {
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && /Content Security Policy|Refused to/.test(message.text())) errors.push(message.text()); });
  page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(request.url()); });
};
const ready = page => page.waitForFunction(() => document.getElementById('co-q-total').textContent.startsWith('$'));
const money = async (page, id) => Number((await page.locator('#' + id).innerText()).replace(/[$,]/g, ''));
const setDate = async (page, id, value) => { await page.locator('#' + id).fill(value); await page.locator('#' + id).dispatchEvent('change'); };
const plusDays = (date, days) => new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
const prices = JSON.parse(await readFile(new URL('../data/ornn-index.json', import.meta.url), 'utf8'));
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce', timezoneId: 'UTC' });
const page = await context.newPage();
watch(page);
try {
  await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
  await page.goto(origin + '/#paper-order');
  await ready(page);
  await page.waitForFunction(() => /cached|live/.test(document.getElementById('co-asof').textContent));
  await page.evaluate(() => document.fonts.ready);
  check((await page.locator('#co-asof').innerText()).includes('cached'), 'prices from /api/prices are labelled with their source');

  // Default quote: 8 GPUs for one week from the next Monday 09:00 in the viewer's zone.
  check(await page.locator('#co-tz').inputValue() === 'UTC', 'time zone defaults to the viewer zone');
  check(await page.locator('#co-qty').inputValue() === '8', 'default quantity is one node');
  check(await page.locator('#co-dur').innerText() === '168 h', 'default window is one week');
  check(await page.locator('#co-q-hours').innerText() === '1,344', 'GPU-hours multiply GPUs by window hours');
  const price = Number((await page.locator('#co-q-price').innerText()).match(/[\d.]+/)[0]);
  check(price === prices.H100.at(-1)[1], 'locked price is the latest H100 index price');
  const fee = await money(page, 'co-q-fee'), upfront = await money(page, 'co-q-upfront'), compute = await money(page, 'co-q-compute');
  check(upfront === fee + 2, 'pay now is protection plus the $2 booking fee');
  check(compute === Math.round(price * 1344), 'compute if used is price times GPU-hours');
  check(await money(page, 'co-q-total') === upfront + compute, 'total adds pay now and compute');
  check(/\/ GPU-h$/.test(await page.locator('#co-q-per').innerText()), 'protection fee shows its per-hour rate');
  check((await page.locator('#co-win-local').innerText()).includes('Mon') && (await page.locator('#co-win-utc').innerText()).startsWith('UTC '), 'window shows local time and UTC');
  check(await page.locator('.co-timeline li').count() === 4 && !(await page.locator('#co-t-claim').innerText()).includes('—'), 'key-dates timeline is filled in');
  check(await page.locator('#co-buy').isEnabled(), 'valid quote can be bought');

  // GPU tabs, chart, and quantity.
  check(await page.locator('.co-tab').count() === 5, 'five GPU tabs');
  check(await page.locator('.co-tab svg path').evaluateAll(paths => paths.every(path => path.getAttribute('d').startsWith('M'))), 'every tab has a sparkline');
  check(await page.locator('#co-svg path').count() >= 1 && await page.locator('#co-s-high').innerText() !== '', 'chart and tiles render');
  await page.locator('.co-tab[data-gpu="H200"]').click();
  check(await page.locator('#co-quote-title').innerText() === 'H200 · Lock' && (await page.locator('#co-chart-title').innerText()).startsWith('H200'), 'tab switches the quote and chart');
  check(await page.locator('.co-tab[data-gpu="H200"]').getAttribute('aria-pressed') === 'true', 'selected tab is pressed');
  await page.locator('#co-qty').selectOption('1');
  check(await page.locator('#co-q-hours').innerText() === '168', 'quantity updates GPU-hours');
  check(await page.locator('#co-qty option').count() === 19, 'quantity offers 1, 2, 4 GPUs and 1 to 16 nodes');

  // Presets.
  await page.locator('[data-preset="1"]').click();
  check(await page.locator('#co-dur').innerText() === '24 h', '1 day preset');
  await page.locator('[data-preset="14"]').click();
  check(await page.locator('#co-dur').innerText() === '336 h', '2 weeks preset');
  await page.locator('[data-preset="m1"]').click();
  check(await page.locator('[data-preset="m1"]').getAttribute('aria-pressed') === 'true', '1 month preset is pressed');
  await page.locator('[data-preset="7"]').click();

  // Lock and Cap.
  await page.locator('[data-kind="cap"]').click();
  check(await page.locator('#co-q-total-l').innerText() === 'Total, at most' && await page.locator('#co-q-price-l').innerText() === 'Cap price', 'Cap relabels the quote');
  check((await page.locator('#co-svg').textContent()).includes('Cap $'), 'chart marks the cap');
  await page.locator('[data-kind="lock"]').click();
  check(await page.locator('#co-q-total-l').innerText() === 'Total, if used', 'Lock restores the labels');

  // Validation.
  const start = await page.locator('#co-start-d').inputValue();
  const today = await page.evaluate(() => new Date().toISOString().slice(0, 10));
  await setDate(page, 'co-start-d', today);
  check((await page.locator('#co-error').innerText()).includes('48 hours') && await page.locator('#co-buy').isDisabled(), 'start under 48 hours away is rejected');
  check(await page.locator('#co-start-d').getAttribute('aria-invalid') === 'true', 'invalid start is marked');
  await setDate(page, 'co-start-d', plusDays(today, 400));
  check((await page.locator('#co-error').innerText()).includes('12 months'), 'start beyond 12 months is rejected');
  await setDate(page, 'co-start-d', start);
  await setDate(page, 'co-end-d', plusDays(start, -1));
  check((await page.locator('#co-error').innerText()).includes('after the start') && await page.locator('#co-end-d').getAttribute('aria-invalid') === 'true', 'end before start is rejected');
  await setDate(page, 'co-end-d', start);
  await page.locator('#co-end-h').selectOption('11');
  check((await page.locator('#co-error').innerText()).includes('4 hours'), 'window under 4 hours is rejected');
  check(await page.locator('#co-q-total').innerText() === '—', 'invalid window shows no total');
  await page.locator('[data-preset="7"]').click();
  check(await page.locator('#co-error').isHidden() && await page.locator('#co-buy').isEnabled(), 'a preset repairs the window');

  // Time zone changes the real start time.
  await page.locator('#co-tz').selectOption('America/New_York');
  check(/1[34]:00/.test(await page.locator('#co-win-utc').innerText()) && /E[DS]T/.test(await page.locator('#co-win-local').innerText()), 'time zone applies to the window');
  await page.locator('#co-tz').selectOption('UTC');

  // Review, consent, receipt.
  const reviewedUpfront = await page.locator('#co-q-upfront').innerText();
  await page.locator('#co-buy').click();
  check(await page.locator('#co-dialog').evaluate(dialog => dialog.open) && await page.locator('#co-review').isVisible(), 'Buy opens the review');
  check((await page.locator('#co-review-list').innerText()).includes(reviewedUpfront), 'review shows the quoted pay-now amount');
  check(await page.locator('#co-confirm').isDisabled(), 'confirm needs consent');
  await page.locator('#co-back').click();
  check(!(await page.locator('#co-dialog').evaluate(dialog => dialog.open)), 'Back closes the review');
  await page.locator('#co-buy').click();
  await page.locator('#co-consent').check();
  await page.locator('#co-confirm').click();
  check(await page.locator('#co-receipt').isVisible() && await page.locator('#co-review').isHidden(), 'confirmation shows the receipt');
  check(/^DEMO-[A-Z2-9]{6}$/.test(await page.locator('#co-ref').innerText()), 'receipt has a DEMO reference');
  check(await page.locator('#co-r-title').evaluate(element => element === document.activeElement), 'receipt heading receives focus');
  check((await page.locator('#co-receipt-list').innerText()).includes('Claim by'), 'receipt lists the claim deadline');
  await page.screenshot({ path: 'artifacts/checkout-receipt.png' });
  check(writes.length === 0, 'calculator sends no server writes');
  check(await page.evaluate(() => localStorage.length === 0 && sessionStorage.length === 0), 'calculator uses no browser storage');
  await page.locator('#co-again').click();
  check(!(await page.locator('#co-dialog').evaluate(dialog => dialog.open)) && await page.locator('#co-qty').inputValue() === '8', 'Start another resets the form');
  check(await page.locator('[data-kind="lock"]').getAttribute('aria-pressed') === 'true' && await page.locator('#co-dur').innerText() === '168 h', 'reset restores Lock and one week');

  // Layout.
  for (const width of [320, 390, 400, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `calculator fits ${width}px`);
  }
  // Hide the sticky nav through the DOM; a screenshot style tag would trip the page CSP.
  await page.evaluate(() => { for (const element of document.querySelectorAll('.nav,.skip-link')) element.style.visibility = 'hidden'; });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.locator('#paper-order').screenshot({ path: 'artifacts/checkout-desktop.png' });
  await page.setViewportSize({ width: 400, height: 844 });
  await page.locator('#paper-order').screenshot({ path: 'artifacts/checkout-mobile.png' });

  // Price sources: live data is used, failures and slow answers keep the embedded index.
  const embeddedAsOf = 'Ornn daily index. Prices as of 17 Oct 2026.';
  const live = { ...prices, H100: [...prices.H100.slice(0, -1), [prices.H100.at(-1)[0], 3.21]] };
  const sourced = async (handler, wait) => {
    const other = await context.newPage();
    watch(other);
    await other.route('**/api/prices', handler);
    await other.goto(origin + '/#paper-order');
    await ready(other);
    if (wait) await other.waitForTimeout(wait);
    else await other.waitForLoadState('networkidle');
    const result = { asOf: await other.locator('#co-asof').innerText(), h100: await other.locator('.co-tab[data-gpu="H100"] .co-tab-price').innerText() };
    await other.close();
    return result;
  };
  const liveResult = await sourced(route => route.fulfill({ json: { asOf: '2026-10-17', source: 'ornn', live: true, data: live } }));
  check(liveResult.asOf.endsWith('· live.') && liveResult.h100.startsWith('$3.21'), 'live prices replace the embedded index');
  const missing = await sourced(route => route.fulfill({ status: 404, json: { message: 'Not found.' } }));
  check(missing.asOf === embeddedAsOf && missing.h100.startsWith('$' + prices.H100.at(-1)[1]), 'a missing endpoint falls back silently');
  const partial = await sourced(route => route.fulfill({ json: { asOf: '2026-10-17', live: true, data: { H100: live.H100, H200: [] } } }));
  check(partial.asOf === embeddedAsOf, 'incomplete price data is ignored');
  const slow = await sourced(async route => { await new Promise(done => setTimeout(done, 4000)); await route.fulfill({ json: { asOf: '2026-10-17', live: true, data: live } }).catch(() => {}); }, 4500);
  check(slow.asOf === embeddedAsOf, 'prices slower than 3 seconds are skipped');

  // Accessibility of the default quote and the receipt.
  const auditContext = await browser.newContext({ bypassCSP: true, viewport: { width: 400, height: 844 }, timezoneId: 'UTC' });
  const audit = await auditContext.newPage();
  await audit.goto(origin);
  await ready(audit);
  await audit.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
  const accessible = async label => {
    const result = await audit.evaluate(() => axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
    check(result.violations.length === 0, label + ': ' + JSON.stringify(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))));
  };
  await accessible('calculator accessibility');
  await audit.locator('#co-buy').click();
  await audit.locator('#co-consent').check();
  await audit.locator('#co-confirm').click();
  await accessible('receipt accessibility');
  await auditContext.close();

  // The standalone preview inlines the same script and works offline on embedded prices.
  const offlineContext = await browser.newContext({ offline: true, viewport: { width: 400, height: 844 } });
  const offline = await offlineContext.newPage();
  watch(offline);
  await offline.setContent(await readFile(new URL('../artifacts/dodona-preview.html', import.meta.url), 'utf8'));
  await ready(offline);
  await offline.locator('#co-buy').click();
  await offline.locator('#co-consent').check();
  await offline.locator('#co-confirm').click();
  check(/^DEMO-/.test(await offline.locator('#co-ref').innerText()), 'standalone preview completes a booking offline');
  check(await offline.locator('#co-asof').innerText() === embeddedAsOf, 'standalone preview uses the embedded prices');
  check(await offline.locator('#submit-button').isDisabled(), 'offline preview does not enable real signups');
  await offlineContext.close();

  check(errors.length === 0, 'no JavaScript errors or CSP violations: ' + errors.join('; '));
  console.log(JSON.stringify({ checkoutChecksPassed: checks, serverWrites: writes.length, offlineBookings: true, storage: 'none; no payments, capacity holds, or saved bookings' }, null, 2));
} finally { await context.close(); await browser.close(); await close(app); }

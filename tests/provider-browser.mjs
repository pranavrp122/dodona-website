// Provider flow in a real browser against the platform API: sign in as Northwind, confirm an order the seeded buyer pays for,
// advance the buyer's demo clock through settlement in a second context, check payouts, and screenshot every screen in both themes.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { createApp } from '../server.mjs';
import { listen, close } from './fixture.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const OUT = process.env.SHOTS_DIR || 'C:/Users/prana/AppData/Local/Temp/claude/C--Users-prana/95ec3bc8-242a-4566-a54d-6ad9c59b42ac/scratchpad/platform-shots/provider/';
const PASSWORD = 'demo-dodona-2026';
const SCREENS = ['overview', 'orders', 'contracts', 'settlements', 'integration', 'settings'];

process.env.AUDIT_LOG_FILE ??= 'off';
await mkdir(OUT, { recursive: true });
const app = createApp({ store: null, platform: true, db: ':memory:', logger: { error() {} } });
const origin = process.env.PORT ? await new Promise(r => app.listen(Number(process.env.PORT), '127.0.0.1', () => r(`http://127.0.0.1:${process.env.PORT}`))) : await listen(app);
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined, headless: true });
const errors = [];
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; };

async function signedIn(email, options = {}) {
  const context = await browser.newContext({ reducedMotion: 'reduce', ...options });
  const response = await context.request.post(`${origin}/api/auth/sign-in`, { headers: { Origin: origin }, data: { email, password: PASSWORD } });
  check(response.ok(), `${email} signs in`);
  return context;
}
const call = async (context, method, path, data) => {
  const response = await context.request.fetch(origin + path, { method, headers: { Origin: origin }, data });
  const body = await response.json().catch(() => ({}));
  if (!response.ok()) throw new Error(`${method} ${path} → ${response.status()} ${JSON.stringify(body)}`);
  return body;
};
const watch = page => {
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
};

try {
  // A buyer is turned away from the portal.
  const buyer = await signedIn('demo@dodona.markets');
  const buyerPage = await buyer.newPage();
  watch(buyerPage);
  await buyerPage.goto(`${origin}/provider`);
  await buyerPage.waitForSelector('body[data-portal="gate"]');
  check(await buyerPage.locator('#p-gate').isVisible(), 'buyer sees the sign-in-as-provider page');
  check((await buyer.request.get(`${origin}/api/provider/overview`)).status() === 403, 'provider API refuses a buyer');

  // The provider turns auto-confirm off so the order waits for a decision.
  const provider = await signedIn('ops@northwind.example', { viewport: { width: 1440, height: 1000 }, recordVideo: { dir: OUT, size: { width: 1440, height: 1000 } } });
  const page = await provider.newPage();
  watch(page);
  await page.goto(`${origin}/provider#settings`);
  await page.waitForSelector('body[data-portal="loaded"]');
  if (await page.locator('#p-auto').isChecked()) {
    await page.locator('#p-auto').uncheck();
    await page.waitForFunction(() => document.querySelector('#d-toasts').textContent.includes('Auto-confirm off'));
  }
  check((await call(provider, 'GET', '/api/provider/settings')).settings.autoConfirm === false, 'auto-confirm saved off');

  // The buyer takes a Northwind cap offer and pays with the test card.
  const { offers } = await call(buyer, 'GET', '/api/offers');
  const offer = offers.find(o => /northwind/i.test(o.neocloud.name) && o.kind === 'cap') || offers.find(o => /northwind/i.test(o.neocloud.name));
  check(Boolean(offer), 'a Northwind offer is on the board');
  const { order } = await call(buyer, 'POST', '/api/orders', { offerId: offer.id, count: offer.minGpus || 8 });
  await call(buyer, 'POST', `/api/orders/${order.ref}/pay`, { card: { number: '4242424242424242', expMonth: 12, expYear: 2030, cvc: '123', name: 'Sample Labs' } });

  // The provider sees it incoming and confirms.
  await page.goto(`${origin}/provider#orders`);
  await page.waitForSelector('body[data-portal="loaded"]');
  const row = page.locator(`#p-incoming tr[data-ref="${order.ref}"]`);
  await row.waitFor();
  check((await row.innerText()).includes('Holds'), 'incoming row shows the capacity it holds');
  await page.screenshot({ path: `${OUT}flow-1-incoming.png`, fullPage: true });
  await row.getByRole('button', { name: 'Confirm' }).click();
  await page.locator(`#p-active tr[data-ref="${order.ref}"]`).waitFor();
  check(true, 'confirmed order moves to active');
  await page.goto(`${origin}/provider#integration`);
  await page.waitForSelector('body[data-portal="loaded"]');
  check((await page.locator('#p-events').innerText()).includes('reservation.confirmed'), 'event log shows the confirmation');

  // The buyer's clock runs the window to settlement, then a few days more so payouts are paid.
  await call(buyer, 'POST', '/api/demo/advance', { until: 'settlement' });
  await call(buyer, 'POST', '/api/demo/advance', { days: 3 });
  const detail = await call(buyer, 'GET', `/api/orders/${order.ref}`);
  check(detail.order.status === 'settled', 'order settled');

  await page.goto(`${origin}/provider#settlements`);
  await page.waitForSelector('body[data-portal="loaded"]');
  check((await page.locator('#p-settlements').innerText()).includes(order.ref), 'settlement statement listed');
  const payouts = await page.locator('#p-payouts').innerText();
  check(payouts.includes(order.ref) && payouts.includes('Paid'), 'payouts listed and paid');
  await page.screenshot({ path: `${OUT}flow-2-settled.png`, fullPage: true });
  await page.close();

  // Every screen at desktop and phone width in both themes.
  const state = await provider.storageState();
  for (const [width, height] of [[1440, 1000], [400, 860]]) for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({ storageState: state, viewport: { width, height }, colorScheme, reducedMotion: 'reduce' });
    const shot = await context.newPage();
    watch(shot);
    for (const screen of SCREENS) {
      await shot.goto(`${origin}/provider#${screen}`);
      await shot.waitForSelector('body[data-portal="loaded"]');
      if (screen === 'integration') await shot.locator('.p-event summary').first().click();
      check(await shot.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${screen} ${width} ${colorScheme}: no sideways scroll`);
      await shot.screenshot({ path: `${OUT}${screen}-${width}-${colorScheme}.png`, fullPage: true });
    }
    await shot.goto(`${origin}/docs/neocloud-api`);
    await shot.screenshot({ path: `${OUT}guide-${width}-${colorScheme}.png`, fullPage: true });
    await context.close();
  }
  await buyerPage.screenshot({ path: `${OUT}gate-buyer.png` });
  check(errors.length === 0, `no page errors: ${errors.join(' | ')}`);
  console.log(`Provider browser flow passed ${checks} checks. Screenshots in ${OUT}`);
} finally {
  await browser.close();
  await close(app);
}

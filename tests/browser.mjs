import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { createApp } from '../server.mjs';
import { fixture, listen, close } from './fixture.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const unconfigured = createApp({ store: null });
const preview = await listen(unconfigured);
const f = await fixture({ realClock: true });
const errors = [];
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; };
const context = await browser.newContext({ reducedMotion: 'reduce' });
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
try {
  await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const response = await page.goto(preview);
  check(response.status() === 200, 'landing page served');
  await page.waitForFunction(() => document.querySelector('#form-message').dataset.state === 'unavailable');
  await page.evaluate(() => document.fonts.ready);
  check((await page.locator('h1').innerText()).replace(/\s+/g, ' ') === 'Protect your compute budget.', 'budget protection headline');
  check(await page.locator('#submit-button').isDisabled(), 'unconfigured form disabled');
  check((await page.locator('#form-message').innerText()).includes('does not submit your details'), 'honest unavailable copy');
  check(await page.locator('#availability-retry').isVisible(), 'unavailable form offers a recovery action');
  check(await page.evaluate(() => document.fonts.check('700 20px "Bricolage Grotesque"')), 'local display typeface loads');
  check(await page.getByRole('button', { name: /buy contract|trade now|exercise now/i }).count() === 0, 'no trading or purchase buttons');
  check(await page.locator('meta[property="og:title"]').count() === 1, 'social metadata');
  check(await page.locator('meta[property="og:image"]').count() === 1, 'social-sharing image metadata');
  check((await page.request.get(preview + '/assets/social-card.png')).status() === 200, 'social-sharing image served');
  check(await page.locator('a[href="mailto:dodonamarkets@gmail.com"]').count() >= 1, 'owner-provided public contact');
  check((await page.locator('.decision-grid').innerText()).includes('$78 less'), 'compute comparison includes booking fee');
  check(await page.locator('.stage').count() === 3, 'three-step explanation');
  check((await page.locator('.example-card').innerText()).includes('100 GPU-hours × $3.00 = $300'), 'illustrative exercise payment');
  check((await page.locator('.example-card').innerText()).includes('$322 total: $300 compute + $20 protection + $2 booking'), 'compute cost includes protection and booking');
  check((await page.locator('.stage').last().innerText()).includes('receive usable compute access'), 'exercise leads to compute delivery');
  check((await page.locator('.downside').innerText()).includes('the $20 protection payment and $2 booking fee are not refunded'), 'expiry cost explained');
  check(await page.evaluate(() => [...document.querySelectorAll('a[href^="#"]')].every(link => document.getElementById(link.getAttribute('href').slice(1)))), 'every CTA has a valid destination');

  // Audit-only context permits axe injection. The app's production CSP stays intact.
  const auditContext = await browser.newContext({ bypassCSP: true, viewport: { width: 1440, height: 1000 } });
  const auditPage = await auditContext.newPage();
  await auditPage.goto(preview);
  await auditPage.waitForFunction(() => document.querySelector('#form-message').dataset.state === 'unavailable');
  await auditPage.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
  const desktopAccessibility = await auditPage.evaluate(() => axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
  check(desktopAccessibility.violations.length === 0, 'desktop accessibility: ' + JSON.stringify(desktopAccessibility.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))));
  const privacyAudit = await auditContext.newPage();
  await privacyAudit.goto(preview + '/privacy');
  await privacyAudit.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
  const privacyAccessibility = await privacyAudit.evaluate(() => axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
  check(privacyAccessibility.violations.length === 0, 'privacy page accessibility');
  check((await privacyAudit.locator('main').innerText()).includes('until you ask us to remove them'), 'owner retention preference published');
  await privacyAudit.close();
  const agentAudit = await auditContext.newPage();
  await agentAudit.goto(preview + '/agents');
  await agentAudit.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
  const agentAccessibility = await agentAudit.evaluate(() => axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
  check(agentAccessibility.violations.length === 0, 'agent documentation accessibility');
  for (const width of [320, 390]) {
    await agentAudit.setViewportSize({ width, height: 844 });
    check(await agentAudit.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `agent docs do not overflow at ${width}px`);
  }
  const mobileAgentAccessibility = await agentAudit.evaluate(() => axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
  check(mobileAgentAccessibility.violations.length === 0, 'mobile agent documentation accessibility');
  await agentAudit.close();

  await page.screenshot({ path: new URL('../artifacts/desktop.png', import.meta.url).pathname, fullPage: true });
  await page.screenshot({ path: new URL('../artifacts/desktop-hero.png', import.meta.url).pathname });
  for (const width of [320, 390, 768, 1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no horizontal overflow at ${width}px`);
    const clippedText = await page.evaluate(() => {
      const problems = [];
      for (const element of document.querySelectorAll('h1,h2,h3,.lede,.nav-cta,.logo')) {
        if (getComputedStyle(element).display === 'none') continue;
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          if (!walker.currentNode.textContent.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(walker.currentNode);
          for (const rect of range.getClientRects()) {
            if (rect.width && (rect.left < -1 || rect.right > innerWidth + 1)) problems.push(walker.currentNode.textContent.trim());
          }
        }
      }
      return problems;
    });
    check(clippedText.length === 0, `headings stay visible at ${width}px: ${clippedText.join(', ')}`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  check(await page.getByRole('navigation', { name: 'On this page' }).isVisible(), 'mobile section menu is visible');
  check(await page.locator('.section-nav a').evaluateAll(links => links.every(link => link.getBoundingClientRect().height >= 44)), 'section links have readable touch targets');
  await page.locator('.section-nav a[href="#flexibility"]').click();
  check(new URL(page.url()).hash === '#flexibility', 'mobile section menu reaches selling');
  await page.goto(preview);
  await page.waitForFunction(() => document.querySelector('#form-message').dataset.state === 'unavailable');
  check(await page.locator('.hero .sheet > p,.hero .tile p').evaluateAll(elements => elements.every(element => parseFloat(getComputedStyle(element).fontSize) >= 14)), 'mobile hero descriptions are readable');
  await auditPage.setViewportSize({ width: 390, height: 844 });
  const mobileAccessibility = await auditPage.evaluate(() => axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
  check(mobileAccessibility.violations.length === 0, 'mobile accessibility: ' + JSON.stringify(mobileAccessibility.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))));
  await auditContext.close();
  await page.screenshot({ path: new URL('../artifacts/mobile.png', import.meta.url).pathname, fullPage: true });
  await page.screenshot({ path: new URL('../artifacts/mobile-hero.png', import.meta.url).pathname });
  await page.locator('.nav-cta').click();
  check(new URL(page.url()).hash === '#early-access', 'mobile CTA reaches early access');
  await page.locator('#faq details').first().locator('summary').click();
  check(await page.locator('#faq details').first().getAttribute('open') !== null, 'mobile FAQ opens');

  // Test successful states against an explicitly test-only PostgREST fixture.
  // Real production preview above remains unconfigured, never fakes a signup.
  await page.setViewportSize({ width: 1440, height: 1000 });
  f.state.failure = true;
  await page.goto(f.origin);
  await page.waitForFunction(() => document.querySelector('#form-message').dataset.state === 'unavailable');
  await page.locator('#email').fill('recovery@example.com');
  f.state.failure = false;
  await page.waitForTimeout(2100);
  await page.locator('#availability-retry').click();
  await page.waitForFunction(() => document.querySelector('#form-message').dataset.state === 'ready');
  check(await page.locator('#email').inputValue() === 'recovery@example.com', 'availability recovery preserves input');
  check(await page.locator('#submit-button').isEnabled(), 'availability recovery enables submission without reload');
  check(await page.locator('#availability-retry').isHidden(), 'recovery action hides after success');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#form-message').dataset.state === 'ready');
  await page.keyboard.press('Tab');
  check(await page.locator('.skip-link').evaluate(element => element === document.activeElement), 'keyboard skip link is first');
  await page.keyboard.press('Enter');
  check(new URL(page.url()).hash === '#main', 'skip link reaches main content');
  await page.locator('.hero .text-link').click();
  check(new URL(page.url()).hash === '#how-it-works', 'secondary CTA reaches explanation');
  for (const interest of ['Business hedging', 'Individual trading', 'Partnership']) {
    await page.locator(`[data-interest="${interest}"]`).click();
    check(await page.locator('#interest').inputValue() === interest, `audience CTA selects ${interest}`);
  }
  await page.locator('#submit-button').click();
  check(await page.locator('#email').getAttribute('aria-invalid') === 'true', 'required email validation');
  check(await page.locator('#email-error').isVisible(), 'visible email error');
  await page.locator('#email').fill('invalid');
  await page.locator('#submit-button').click();
  check(f.state.writes === 0, 'invalid email sends no signup');
  await page.locator('#email').fill('browser-verification@example.com');
  await page.locator('#email').focus();
  await page.keyboard.press('Tab');
  check(await page.locator('#interest').evaluate(element => element === document.activeElement), 'email to interest keyboard order');
  check(await page.locator('#interest').evaluate(element => getComputedStyle(element).outlineWidth === '3px'), 'visible keyboard focus');
  await page.keyboard.press('Tab');
  check(await page.locator('#use-case').evaluate(element => element === document.activeElement), 'interest to use case keyboard order');
  await page.keyboard.press('Tab');
  check(await page.locator('#submit-button').evaluate(element => element === document.activeElement), 'honeypot excluded from keyboard order');
  await page.locator('#interest').selectOption('Individual trading');
  await page.locator('#use-case').fill('Testing compute budget protection.');
  await page.waitForTimeout(1600);
  f.state.delay = 350;
  await page.locator('#submit-button').click();
  await page.waitForFunction(() => document.querySelector('#form-message').dataset.state === 'loading');
  check(await page.locator('#submit-button').isDisabled(), 'loading prevents duplicate clicks');
  check((await page.locator('#submit-label').innerText()) === 'Joining…', 'loading label');
  check(f.rows.size === 0, 'no success before storage confirmation');
  await page.waitForFunction(() => document.querySelector('#form-message').dataset.state === 'success');
  check(f.rows.size === 1, 'confirmed signup reaches test storage adapter');
  check(f.rows.get('browser-verification@example.com').interest === 'Individual trading', 'interest persisted');
  check(await page.locator('#email').inputValue() === '', 'successful form clears');
  f.state.delay = 0;
  await page.locator('#email').fill('BROWSER-verification@example.com');
  await page.locator('#submit-button').click();
  await page.waitForFunction(() => document.querySelector('#form-message').dataset.state === 'success');
  check(f.rows.size === 1, 'duplicate submission retains one record');

  f.state.failure = true;
  await page.locator('#email').fill('storage-failure@example.com');
  await page.locator('#submit-button').click();
  await page.waitForFunction(() => document.querySelector('#form-message').dataset.state === 'unavailable');
  check((await page.locator('#form-message').innerText()).includes('couldn’t confirm'), 'storage failure copy');
  check(await page.locator('#email').inputValue() === 'storage-failure@example.com', 'storage failure preserves form');
  check(!f.rows.has('storage-failure@example.com'), 'failed storage never saves a fake signup');
  f.state.failure = false;
  await page.waitForTimeout(2100);
  await page.locator('#availability-retry').click();
  await page.waitForFunction(() => document.querySelector('#form-message').dataset.state === 'ready');
  check(await page.locator('#email').inputValue() === 'storage-failure@example.com', 'post-submission outage recovery preserves input');
  await page.route('**/api/waitlist', route => route.abort('failed'));
  await page.locator('#submit-button').click();
  await page.waitForFunction(() => document.querySelector('#form-message').dataset.state === 'error');
  check((await page.locator('#form-message').innerText()).includes('retrying won’t add a duplicate'), 'network failure enables safe retry');
  await page.unroute('**/api/waitlist');
  await page.locator('#submit-button').click();
  await page.waitForFunction(() => document.querySelector('#form-message').dataset.state === 'success');
  check(f.rows.has('storage-failure@example.com'), 'retry succeeds after recovery');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-interest="Partnership"]').click();
  await page.locator('#email').fill('mobile-verification@example.com');
  await page.locator('#submit-button').click();
  await page.waitForFunction(() => document.querySelector('#form-message').dataset.state === 'success');
  check(f.rows.get('mobile-verification@example.com').interest === 'Partnership', 'mobile signup completes');
  await page.locator('#faq summary').first().focus();
  await page.keyboard.press('Enter');
  check(await page.locator('#faq details').first().getAttribute('open') !== null, 'keyboard FAQ toggles');
  check(errors.length === 0, 'no uncaught JavaScript errors: ' + errors.join('; '));
  f.rows.clear();
  check(f.rows.size === 0, 'test fixture records removed');
  const automatic = await fixture();
  const autoContext = await browser.newContext();
  try {
    const autoPage = await autoContext.newPage();
    await autoPage.clock.install();
    automatic.state.failure = true;
    await autoPage.goto(automatic.origin);
    await autoPage.waitForFunction(() => document.querySelector('#form-message').dataset.state === 'unavailable');
    automatic.state.failure = false;
    automatic.advance(31000);
    await autoPage.clock.runFor(30001);
    await autoPage.waitForFunction(() => document.querySelector('#form-message').dataset.state === 'ready');
    check(await autoPage.locator('#submit-button').isEnabled(), 'automatic retry recovers without a reload or click');
  } finally { await autoContext.close(); await automatic.cleanup(); }
  console.log(JSON.stringify({ browserChecksPassed: checks, widthsChecked: [320, 390, 768, 1024, 1440, 1920], accessibility: 'No axe WCAG A/AA violations on desktop or mobile; keyboard paths also checked', storage: 'test-only PostgREST fixture; live Supabase verification remains separate', screenshots: 'artifacts/desktop.png and artifacts/mobile.png' }, null, 2));
} finally {
  await context.close();
  await browser.close();
  await close(unconfigured);
  await f.cleanup();
}

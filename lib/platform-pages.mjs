/** Buyer pages of the demo platform (sign-in, offers, checkout, orders, order detail): shared console shell and page routes. */
import { readFile } from 'node:fs/promises';
import { renderPage } from './site.mjs';

const HTML = 'text/html; charset=utf-8';
const ORDER_REF = /^\/orders\/([A-Za-z0-9-]{1,40})$/;
export const BANNER = 'Demo platform · mock card payments, a simulated neocloud and a mock outbox · nothing here is a live price, order or account';
const FOOTER = 'Index data comes from the Ornn daily index, demonstration only. Money moves through the escrow agent (simulated); Dodona never holds funds.';

export const BUYER_PAGES = new Map([
  ['/sign-in', { file: 'sign-in.html', nav: '' }],
  ['/offers', { file: 'offers.html', nav: 'offers' }],
  ['/checkout', { file: 'checkout.html', nav: 'offers' }],
  ['/orders', { file: 'orders.html', nav: 'orders' }],
]);

export const BUYER_ASSETS = [
  ['/platform.css', 'platform.css', 'text/css; charset=utf-8'],
  ['/platform-shell.js', 'platform-shell.js', 'text/javascript; charset=utf-8'],
  ['/sign-in.js', 'sign-in.js', 'text/javascript; charset=utf-8'],
  ['/offers.js', 'offers.js', 'text/javascript; charset=utf-8'],
  ['/platform-checkout.js', 'platform-checkout.js', 'text/javascript; charset=utf-8'],
  ['/orders.js', 'orders.js', 'text/javascript; charset=utf-8'],
  ['/order.js', 'order.js', 'text/javascript; charset=utf-8'],
  ['/dashboard-platform.js', 'dashboard-platform.js', 'text/javascript; charset=utf-8'],
  ['/dashboard-charts.js', 'dashboard-charts.js', 'text/javascript; charset=utf-8'],
];

// [group, [key, href, icon, label, extra]]; "extra" items sit under "More" in the phone tab bar.
const RAIL = [
  ['Portfolio', [['overview', '/dashboard#overview', 'layout-dashboard', 'Overview'], ['positions', '/dashboard#positions', 'layers', 'Positions'],
    ['orders', '/orders', 'receipt', 'Orders'], ['alerts', '/dashboard#alerts', 'bell', 'Alerts', true]]],
  ['Market', [['market', '/dashboard#market', 'chart-line', 'Index and implied curve', true], ['offers', '/offers', 'tag', 'Offers']]],
  ['Counterparties', [['provider', '/dashboard#provider', 'server', 'Provider view', true], ['lender', '/dashboard#lender', 'shield', 'Lender view', true]]],
  ['Account', [['emails', '/dashboard#emails', 'mail', 'Emails', true], ['settings', '/dashboard#settings', 'settings', 'Settings', true], ['audit', '/audit', 'file-text', 'Audit trail', true]]],
];

const icon = name => `<svg class="ic" aria-hidden="true" focusable="false"><use href="#i-${name}"/></svg>`;

export function railHtml(current) {
  const groups = RAIL.map(([group, items], g) => `<p class="c-nav-group" id="p-g-${g}">${group}</p>
      <ul aria-labelledby="p-g-${g}">${items.map(([key, href, iconName, label, extra]) => `<li${extra ? ' class="c-extra"' : ''}><a class="c-tab" href="${href}" data-nav="${key}"${key === current ? ' aria-current="page"' : ''}>${icon(iconName)}<span class="d-lbl">${label}</span></a></li>`).join('')}</ul>`).join('\n      ');
  return `<nav class="d-rail" id="d-rail" aria-label="Console">
      ${groups}
      <button type="button" class="c-tab c-more-tab" id="d-nav-more" aria-expanded="false" aria-controls="d-rail">${icon('ellipsis')}<span class="d-lbl">More</span></button>
    </nav>`;
}

// The Help menu, account chip and demo clock fill in from platform-shell.js once /api/account answers.
export const topHtml = ({ help = true } = {}) => `<header class="c-top">
    <a class="c-mark" href="/" aria-label="Dodona home">D</a>
    <span class="c-brand">Dodona <span class="c-brand-sub">Console</span></span>
    <span class="c-demo">Demo</span>
    <span class="c-spacer"></span>
    <div class="p-clock" id="p-clock" hidden></div>
    ${help ? '<div class="p-tour" id="p-tour" hidden></div>' : ''}
    <button type="button" class="c-top-btn" id="d-theme" data-choice="system" aria-label="Theme: system. Switch to light.">
      <svg class="ic c-th-light" aria-hidden="true" focusable="false"><use href="#i-sun"/></svg>
      <svg class="ic c-th-dark" aria-hidden="true" focusable="false"><use href="#i-moon"/></svg>
      <svg class="ic c-th-system" aria-hidden="true" focusable="false"><use href="#i-sun-moon"/></svg>
      <span class="c-th-lbl" id="d-theme-lbl">System</span>
    </button>
    <div class="p-acct" id="p-acct" hidden></div>
  </header>
  <div class="c-strip" role="note"><b>Demo</b><span>${BANNER}</span></div>`;

const footerHtml = () => `<footer class="d-footer"><div class="d-footer-inner"><p>${FOOTER}</p><div class="footer-links"><a href="/">Back to Dodona</a><a href="/privacy">Privacy</a><!-- CONTACT_LINK --></div></div></footer>
  <div class="d-toasts" id="d-toasts" role="status" aria-live="polite"></div>`;

let spriteCache;
// One icon sprite for the whole console, taken from the dashboard so every page draws the same icons.
export async function iconSprite() {
  if (!spriteCache) {
    const dashboard = await readFile(new URL('../dashboard.html', import.meta.url), 'utf8');
    spriteCache = dashboard.match(/<svg class="c-sprite"[\s\S]*?<\/svg>/)?.[0] || '';
  }
  return spriteCache;
}

export async function renderBuyerPage(file, { nav = '', settings, origin, path }) {
  const html = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
  const filled = html.replace('<!-- P_SPRITE -->', await iconSprite()).replace('<!-- P_TOP -->', topHtml({ help: file !== 'sign-in.html' }))
    .replace('<!-- P_RAIL -->', railHtml(nav)).replace('<!-- P_FOOTER -->', footerHtml());
  return renderPage(filled, { settings, origin, path });
}

/** Returns { status, type, body } for a buyer page path, or null when the path is not one of them. */
export async function buyerPage(pathname, { settings, origin }) {
  const page = BUYER_PAGES.get(pathname);
  if (page) return { status: 200, type: HTML, body: await renderBuyerPage(page.file, { nav: page.nav, settings, origin, path: pathname }) };
  if (ORDER_REF.test(pathname)) return { status: 200, type: HTML, body: await renderBuyerPage('order.html', { nav: 'orders', settings, origin, path: '/orders' }) };
  return null;
}

/**
 * Activity log client for the signed-in console pages: page views (on load and on hash change), clicks on buttons, links
 * and data-act or data-nav elements, and script errors, sent in small batches to /api/activity. It never reads an input
 * value, a form field or card data, never throws into the page, and stops when the platform is off or nobody is signed in.
 */
const ENDPOINT = '/api/activity';
const FLUSH_MS = 3000;
const MAX_BATCH = 50;
const MAX_QUEUE = 200;
const MAX_EVENT_BYTES = 1024;
const MAX_ERRORS = 20;
const CLICKABLE = 'a, button, summary, [data-act], [data-nav], [role="button"], [role="tab"], [role="menuitem"]';
const FIELD = 'input, textarea, select, option, [contenteditable]:not([contenteditable="false"])';
// Twelve or more digits in a row look like a card number; they never leave the page.
const DIGIT_RUN = /\d(?:[ -]?\d){11,}/g;

const queue = [];
let off = false;
let errors = 0;
let lastPage = '';

const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').replace(DIGIT_RUN, '').trim().slice(0, max);

// The page as path, query keys without values, and hash.
function pagePath() {
  const keys = [...new Set(new URLSearchParams(location.search).keys())];
  return clean(`${location.pathname}${keys.length ? `?${keys.map(encodeURIComponent).join('&')}` : ''}${location.hash}`, 200);
}

function push(kind, fields = {}) {
  if (off) return;
  const event = { kind, page: pagePath(), at: new Date().toISOString(), ...fields };
  if (JSON.stringify(event).length > MAX_EVENT_BYTES) { delete event.detail; event.target = clean(event.target, 60); }
  queue.push(event);
  while (queue.length > MAX_QUEUE) queue.shift();
}

function send(batch, beacon) {
  const body = JSON.stringify({ events: batch });
  if (beacon && navigator.sendBeacon) {
    try { if (navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'text/plain;charset=UTF-8' }))) return; } catch { /* fall back to fetch */ }
  }
  fetch(ENDPOINT, { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json' }, body })
    .then(response => {
      if (response.status === 404) off = true;
      if (!response.ok) return null;
      return response.json().then(data => { if (data?.signedIn === false) off = true; });
    })
    .catch(() => { /* the log never interrupts the page */ });
}

function flush(beacon = false) {
  try {
    if (off) { queue.length = 0; return; }
    do { if (queue.length) send(queue.splice(0, MAX_BATCH), beacon); } while (beacon && queue.length);
  } catch { /* the log never interrupts the page */ }
}

function onClick(event) {
  try {
    const node = event.target instanceof Element ? event.target : null;
    if (!node || node.closest(FIELD) || node.closest('[type="password"], [autocomplete^="cc-"]')) return;
    const el = node.closest(CLICKABLE);
    if (!el || el.matches(FIELD)) return;
    const tag = el.tagName.toLowerCase();
    const detail = { tag };
    if (el.dataset.act) detail.act = clean(el.dataset.act, 80);
    if (el.dataset.nav) detail.nav = clean(el.dataset.nav, 80);
    if (el.id) detail.id = clean(el.id, 80);
    if (tag === 'a' && el.getAttribute('href')) detail.href = clean(el.getAttribute('href'), 200);
    const text = clean(el.getAttribute('aria-label') || el.textContent, 120);
    push('click', { target: text || detail.act || detail.nav || detail.id || tag, detail });
  } catch { /* the log never interrupts the page */ }
}

function onNav() {
  try {
    const page = pagePath();
    if (page === lastPage) return;
    push('nav', lastPage ? { detail: { from: lastPage } } : {});
    lastPage = page;
  } catch { /* the log never interrupts the page */ }
}

function onError(message, source, line, col) {
  try {
    if (errors++ >= MAX_ERRORS || String(source || '').endsWith('/activity.js')) return;
    const detail = { message: clean(message || 'Script error', 300) };
    if (source) detail.source = clean(source, 200);
    if (Number.isInteger(line)) detail.line = line;
    if (Number.isInteger(col)) detail.col = col;
    push('error', { detail });
  } catch { /* the log never interrupts the page */ }
}

try {
  onNav();
  document.addEventListener('click', onClick, true);
  window.addEventListener('hashchange', onNav);
  window.addEventListener('error', event => onError(event.message, event.filename, event.lineno, event.colno));
  window.addEventListener('unhandledrejection', event => onError(event.reason?.message || String(event.reason ?? 'Unhandled rejection')));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(true); });
  window.addEventListener('pagehide', () => flush(true));
  setInterval(() => flush(false), FLUSH_MS);
} catch { /* the log never interrupts the page */ }

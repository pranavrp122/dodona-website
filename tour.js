/**
 * Guided tours: dims the page, cuts a spotlight around one element at a time and explains it in a small card with Back, Next and Skip.
 * No dependencies. Positions go through el.style.setProperty, so the strict CSP (no inline styles) holds.
 * Buttons marked data-tour-start="<key>" anywhere on a page start that tour; the console shell starts its own from the Help menu.
 */
const STORE_PREFIX = 'dodonaTour.';
const PHONE = '(max-width:720px)';
const PAD = 6;
const GAP = 12;
const EDGE = 12;
const FIND_MS = 800;
const SETTLE_MS = 700;
const RECHECK_MS = 400;

let active = null;

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** True once the tour has been finished or skipped in this browser. */
export function seenTour(key) {
  try { return localStorage.getItem(STORE_PREFIX + key) === 'seen'; } catch { return false; }
}

function markSeen(key) {
  try { localStorage.setItem(STORE_PREFIX + key, 'seen'); } catch { /* private windows can refuse storage; the dot just stays */ }
  document.querySelectorAll(`[data-tour-dot="${CSS.escape(key)}"]`).forEach(dot => dot.remove());
}

/** The small accent dot that marks a Help button until its tour has been seen, or null when it has been. */
export function tourDot(key) {
  if (seenTour(key)) return null;
  const dot = document.createElement('span');
  dot.className = 'tour-dot';
  dot.dataset.tourDot = key;
  dot.setAttribute('aria-hidden', 'true');
  return dot;
}

const isShown = node => !!node && node.isConnected && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';

/** Resolves with the first visible element matching `selector`, or null after `timeout` ms. */
export async function waitFor(selector, timeout = 4000) {
  const end = performance.now() + timeout;
  for (;;) {
    const found = [...document.querySelectorAll(selector)].find(isShown);
    if (found) return found;
    if (performance.now() > end) return null;
    await sleep(60);
  }
}

/** Sets the location hash, then waits for `ready` (a selector) to be visible so the page has finished its route. */
export async function goToHash(hash, ready, timeout = 5000) {
  if (location.hash !== hash) {
    // hashchange fires after this task; waiting for it lets the page's own handler re-render before we look for `ready`.
    const changed = new Promise(resolve => { window.addEventListener('hashchange', resolve, { once: true }); setTimeout(resolve, 500); });
    location.hash = hash;
    await changed;
    await frame();
  }
  return ready ? waitFor(ready, timeout) : null;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(className, label, action) {
  const node = el('button', `tour-btn ${className}`, label);
  node.type = 'button';
  node.dataset.tourAct = action;
  return node;
}

function buildOverlay() {
  const root = el('div', 'tour');
  const shield = el('div', 'tour-shield');
  const spot = el('div', 'tour-spot');
  spot.setAttribute('aria-hidden', 'true');
  const card = el('div', 'tour-card');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', 'tour-title');
  card.setAttribute('aria-describedby', 'tour-body');
  const live = el('div', 'tour-live');
  live.setAttribute('aria-live', 'polite');
  const count = el('p', 'tour-count');
  const title = el('h2', 'tour-title');
  title.id = 'tour-title';
  const body = el('div', 'tour-body');
  body.id = 'tour-body';
  live.append(count, title, body);
  const acts = el('div', 'tour-acts');
  const skip = button('tour-skip', 'Skip tour', 'skip');
  const back = button('tour-back', 'Back', 'back');
  const next = button('tour-next', 'Next', 'next');
  acts.append(skip, el('span', 'tour-spacer'), back, next);
  card.append(live, acts);
  root.append(shield, spot, card);
  return { root, spot, card, count, title, body, back, next };
}

function setBox(node, { top, left, width, height }) {
  node.style.setProperty('top', `${Math.round(top)}px`);
  node.style.setProperty('left', `${Math.round(left)}px`);
  if (width != null) node.style.setProperty('width', `${Math.round(width)}px`);
  if (height != null) node.style.setProperty('height', `${Math.round(height)}px`);
}

// The part of the target a reader can see: its box cut down by every scrolling or clipping ancestor (a panel that scrolls inside the page).
function visibleRect(target) {
  const r = target.getBoundingClientRect();
  let { top, left, bottom, right } = r;
  for (let node = target.parentElement; node && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
    const c = node.getBoundingClientRect();
    top = Math.max(top, c.top); left = Math.max(left, c.left); bottom = Math.min(bottom, c.bottom); right = Math.min(right, c.right);
  }
  return { top, left, bottom: Math.max(bottom, top), right: Math.max(right, left) };
}

// The spotlight: the visible part of the target plus padding, clipped to the viewport so a tall section still shows a usable frame.
function spotRect(target) {
  const r = visibleRect(target);
  const top = Math.max(r.top - PAD, 2);
  const left = Math.max(r.left - PAD, 2);
  const bottom = Math.min(r.bottom + PAD, window.innerHeight - 2);
  const right = Math.min(r.right + PAD, document.documentElement.clientWidth - 2);
  return { top, left, width: Math.max(right - left, 0), height: Math.max(bottom - top, 0), bottom, right };
}

const ORDER = {
  auto: ['bottom', 'top', 'right', 'left'], bottom: ['bottom', 'top', 'right', 'left'], top: ['top', 'bottom', 'right', 'left'],
  right: ['right', 'left', 'bottom', 'top'], left: ['left', 'right', 'bottom', 'top'],
};

// Desktop: try the preferred side, flip to the others, and float the card over the bottom of the target when nothing fits.
function placeCard(card, box, placement) {
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const cw = card.offsetWidth;
  const ch = card.offsetHeight;
  const clampX = x => Math.min(Math.max(x, EDGE), vw - cw - EDGE);
  const clampY = y => Math.min(Math.max(y, EDGE), vh - ch - EDGE);
  const fits = {
    bottom: box.bottom + GAP + ch <= vh - EDGE, top: box.top - GAP - ch >= EDGE,
    right: box.right + GAP + cw <= vw - EDGE, left: box.left - GAP - cw >= EDGE,
  };
  const at = {
    bottom: () => ({ top: box.bottom + GAP, left: clampX(box.left) }),
    top: () => ({ top: box.top - GAP - ch, left: clampX(box.left) }),
    right: () => ({ top: clampY(box.top), left: box.right + GAP }),
    left: () => ({ top: clampY(box.top), left: box.left - GAP - cw }),
  };
  const side = (ORDER[placement] || ORDER.auto).find(name => fits[name]);
  card.dataset.side = side || 'over';
  setBox(card, side ? at[side]() : { top: clampY(vh - ch - EDGE * 2), left: clampX(box.right - cw - EDGE) });
}

// Phone: the card is a bottom sheet. When a step first shows, scroll the target clear of it; when the target cannot move
// (a bar fixed to the bottom), the sheet goes to the top. Later calls leave the reader's own scrolling alone.
function placeSheet(card, target, adjust) {
  if (!adjust) return;
  const room = window.innerHeight - card.offsetHeight - GAP;
  let r = target.getBoundingClientRect();
  if (r.bottom > room && r.top > 72) {
    const shift = Math.min(r.bottom - room, r.top - 72);
    if (shift > 1) {
      window.scrollBy({ top: shift, behavior: 'instant' });
      r = target.getBoundingClientRect();
    }
  }
  card.classList.toggle('is-top', r.bottom > room && r.top > window.innerHeight / 2);
}

async function settleScroll(target) {
  let last = null;
  const end = performance.now() + SETTLE_MS;
  while (performance.now() < end) {
    await frame();
    const now = target.getBoundingClientRect().top;
    if (last !== null && Math.abs(now - last) < 0.5) return;
    last = now;
  }
}

function layout(tour, { adjust = false } = {}) {
  // A page that re-renders (a refresh, a clock move) swaps the element out; follow the step's selector to the new one.
  if (tour.target && !isShown(tour.target)) tour.target = [...document.querySelectorAll(tour.step.target)].find(isShown) || tour.target;
  const { ui, target, step } = tour;
  const phone = window.matchMedia(PHONE).matches;
  ui.card.classList.toggle('is-sheet', phone);
  if (phone) { ui.card.style.removeProperty('top'); ui.card.style.removeProperty('left'); }
  ui.root.classList.toggle('is-plain', !target);
  ui.spot.hidden = !target;
  if (!target) {
    ui.card.classList.remove('is-top');
    if (!phone) setBox(ui.card, { top: (window.innerHeight - ui.card.offsetHeight) / 2, left: (document.documentElement.clientWidth - ui.card.offsetWidth) / 2 });
    return;
  }
  if (phone) placeSheet(ui.card, target, adjust);
  const box = spotRect(target);
  setBox(ui.spot, box);
  if (!phone) placeCard(ui.card, box, step.placement || 'auto');
}

// A step is left out when it was already found missing, or when its `when` check says the page has nothing for it.
const applies = step => { try { return !step.when || !!step.when(); } catch { return false; } };

function render(tour, index) {
  const { ui, steps, skipped } = tour;
  const step = steps[index];
  const counted = steps.map((s, i) => i === index || (!skipped.has(i) && applies(s)));
  const position = counted.slice(0, index + 1).filter(Boolean).length;
  ui.count.textContent = `${position} of ${counted.filter(Boolean).length}`;
  ui.title.textContent = step.title;
  ui.body.replaceChildren(...String(step.body).split('\n').filter(Boolean).map(text => el('p', '', text)));
  ui.back.hidden = position === 1;
  const last = !counted.some((on, i) => on && i > index);
  ui.next.textContent = last ? 'Done' : 'Next';
  ui.next.dataset.tourAct = last ? 'done' : 'next';
}

async function leave(tour) {
  const step = tour.step;
  tour.step = null;
  if (step?.after) { try { await step.after(); } catch { /* a failed clean-up never blocks the tour */ } }
}

async function reveal(tour, index, target) {
  tour.index = index;
  tour.target = target;
  tour.step = tour.steps[index];
  tour.root.dataset.step = String(index);
  render(tour, index);
  if (target) {
    target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
    await settleScroll(target);
  }
  layout(tour, { adjust: true });
  tour.root.classList.add('is-on');
  tour.ui.next.focus({ preventScroll: true });
}

// Shows step `index`, walking on in `direction` past steps whose target is missing once their `before` has run.
async function show(tour, index, direction) {
  if (tour.busy) return;
  tour.busy = true;
  tour.root.setAttribute('aria-busy', 'true');
  try {
    await leave(tour);
    let i = index;
    let dir = direction;
    while (i >= 0 && i < tour.steps.length) {
      const step = tour.steps[i];
      let target = null;
      try {
        if (!applies(step)) throw new Error('not on this page');
        if (step.before) await step.before();
        if (step.target) target = await waitFor(step.target, step.wait ?? FIND_MS);
      } catch { target = null; }
      if (active !== tour) return;
      if (!step.target || target) { await reveal(tour, i, target); return; }
      tour.skipped.add(i);
      i += dir;
      if (i < 0) { dir = 1; i = index + 1; }
    }
    close(tour);
  } finally {
    tour.busy = false;
    tour.root.removeAttribute('aria-busy');
  }
}

function close(tour, { seen = true } = {}) {
  if (active !== tour) return;
  active = null;
  leave(tour);
  clearInterval(tour.timer);
  window.removeEventListener('resize', tour.onMove);
  window.removeEventListener('scroll', tour.onMove, true);
  document.removeEventListener('keydown', tour.onKey, true);
  tour.root.remove();
  document.documentElement.classList.remove('tour-open');
  if (seen) markSeen(tour.key);
  tour.onEnd?.();
  if (tour.opener?.isConnected) tour.opener.focus({ preventScroll: true });
}

function keyHandler(tour) {
  return event => {
    if (active !== tour) return;
    const { key } = event;
    if (key !== 'Escape' && key !== 'ArrowRight' && key !== 'ArrowLeft' && key !== 'Tab') return;
    event.preventDefault();
    event.stopPropagation();
    if (key === 'Escape') { close(tour); return; }
    if (key === 'ArrowLeft') { if (!tour.ui.back.hidden) show(tour, tour.index - 1, -1); return; }
    if (key === 'ArrowRight') { if (tour.ui.next.dataset.tourAct === 'done') close(tour); else show(tour, tour.index + 1, 1); return; }
    const items = [...tour.ui.card.querySelectorAll('button')].filter(b => !b.hidden);
    const at = items.indexOf(document.activeElement);
    items[(at + (event.shiftKey ? items.length - 1 : 1)) % items.length]?.focus();
  };
}

/**
 * Starts a tour. Each step is { target: selector | null, title, body, placement?, before?, after?, when?, wait? }.
 * `when` is a quick check that the page has something for the step (false skips it and leaves it out of the count).
 * `before` may navigate and wait; a step whose target is still missing afterwards is skipped without an error.
 * Finishing or skipping marks `key` as seen. Focus returns to `opener` (the Help button) when the tour closes.
 */
export function startTour(steps, { key, opener = document.activeElement, onEnd } = {}) {
  if (active) close(active, { seen: false });
  if (!Array.isArray(steps) || !steps.length) return null;
  const ui = buildOverlay();
  const tour = { steps, key: key || 'tour', opener, onEnd, ui, root: ui.root, index: -1, target: null, step: null, skipped: new Set(), busy: false };
  active = tour;
  let pending = 0;
  tour.onMove = () => {
    if (pending) return;
    pending = requestAnimationFrame(() => { pending = 0; if (active === tour && tour.step && !tour.busy) layout(tour); });
  };
  tour.onKey = keyHandler(tour);
  // The overlay is modal: clicks never reach the page underneath, and page-level handlers never see clicks inside it.
  ui.root.addEventListener('click', event => {
    event.stopPropagation();
    const act = event.target.closest('[data-tour-act]')?.dataset.tourAct;
    if (act === 'next') show(tour, tour.index + 1, 1);
    else if (act === 'back') show(tour, tour.index - 1, -1);
    else if (act === 'skip' || act === 'done') close(tour);
  });
  window.addEventListener('resize', tour.onMove);
  window.addEventListener('scroll', tour.onMove, true);
  document.addEventListener('keydown', tour.onKey, true);
  // Content can move without a scroll or resize (data arriving, a panel opening), so the spotlight also re-checks on a slow timer.
  tour.timer = setInterval(tour.onMove, RECHECK_MS);
  document.documentElement.classList.add('tour-open');
  document.body.append(ui.root);
  show(tour, 0, 1);
  return tour;
}

// Public pages: a button with data-tour-start="<key>" starts that tour, loading the step lists on first use.
async function startFromButton(node) {
  const { tourFor } = await import('./tour-steps.js');
  const tour = tourFor(node.dataset.tourStart);
  if (tour) startTour(tour.steps, { key: tour.key, opener: node });
}

function wireStartButtons() {
  document.querySelectorAll('[data-tour-start]').forEach(node => {
    if (node.dataset.tourWired) return;
    node.dataset.tourWired = '1';
    const dot = tourDot(node.dataset.tourStart);
    if (dot) node.append(dot);
    node.addEventListener('click', event => { event.preventDefault(); startFromButton(node); });
  });
}

// Tests import the step lists in Node, where there is no page to wire.
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireStartButtons);
  else wireStartButtons();
}

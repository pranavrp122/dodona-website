/** Demo platform shell shared by the console pages: same-origin JSON API calls, toasts, the Help menu and guided tour, the account menu, the phone "More" sheet and the demo clock. */
import { escapeHtml as esc, icon, shortDate, pill } from '/dashboard-view.js';
import { startTour, tourDot } from '/tour.js';
import { tourFor, tourName } from '/tour-steps.js';

export const SCENARIOS = [['market', 'Market · follows the fitted trend'], ['rise', 'Rise · +35% over 60 days'], ['fall', 'Fall · −25% over 60 days'], ['spike', 'Spike · +60% in 10 days, then back'], ['flat', 'Flat · no drift']];
const ROLE_TEXT = { buyer: 'Buys compute', lender: 'Lends or insures', provider: 'Provides compute', admin: 'Admin' };
const MAX_EVENT_TOASTS = 3;
const $ = id => document.getElementById(id);

export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

/** Calls a same-origin JSON route. Resolves with the body on success; throws ApiError with the server's code and message otherwise. */
export async function api(path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method, credentials: 'same-origin',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network', 'The server did not answer. Check your connection and try again.');
  }
  if (response.status === 204) return {};
  let data = null;
  try { data = await response.json(); } catch { /* an empty or non-JSON body falls through to the status message */ }
  if (response.ok && data?.ok !== false) return data || {};
  const error = data?.error && typeof data.error === 'object' ? data.error : { code: data?.code, message: data?.message || data?.error };
  throw new ApiError(response.status, error.code || `http_${response.status}`, error.message || `The request failed (${response.status}).`);
}

/** The signed-in account, null when signed out, or { off: true } when the demo platform is switched off. */
export async function loadAccount() {
  try {
    return (await api('/api/account')).account || null;
  } catch (error) {
    if (error.status === 401) return null;
    if (error.status === 404) return { off: true };
    throw error;
  }
}

export function toast(message) {
  const box = $('d-toasts');
  if (!box) return;
  const item = document.createElement('div');
  item.className = 'd-toast';
  item.textContent = message;
  box.append(item);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => item.remove(), 6000);
}

export const fmtDate = iso => (iso ? shortDate(iso) : '—');
export const money = v => (v == null || !Number.isFinite(Number(v)) ? '—' : `${v < 0 ? '−' : ''}$${Math.abs(Number(v)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
export const signedMoney = v => (v == null ? '—' : v > 0 ? `+${money(v)}` : money(v));
// Per-hour prices carry up to four decimals; whole cents print as cents.
export const rate = v => {
  const n = Number(v);
  if (v == null || !Number.isFinite(n)) return '—';
  return `$${n.toFixed(Math.abs(n * 100 - Math.round(n * 100)) > 1e-6 ? 4 : 2)}`;
};

// Offers use cap/floor/lock; positions use call/put/lock. Both read the same way to a buyer.
const KINDS = {
  cap: ['arrow-up-to-line', 'Price cap', 'accent'], call: ['arrow-up-to-line', 'Price cap', 'accent'],
  floor: ['arrow-down-to-line', 'Price floor', 'warning'], put: ['arrow-down-to-line', 'Price floor', 'warning'],
  lock: ['lock', 'Fixed price', 'neutral'],
};
export const kindName = kind => KINDS[kind]?.[1] || kind;
export const isFloor = kind => kind === 'floor' || kind === 'put';
export const isLock = kind => kind === 'lock';
export const kindPill = kind => { const [iconName, label, toneName] = KINDS[kind] || ['layers', kind, 'neutral']; return pill(iconName, toneName, label); };
export const quoteType = kind => (isFloor(kind) ? 'put' : isLock(kind) ? 'lock' : 'call');

/** Break-even in words: a cap pays off above strike + premium, a floor below strike − premium, a lock has none. */
export function breakEven(kind, strike, premium) {
  if (isLock(kind)) return { value: null, text: `Fixed at ${rate(strike)}` };
  const value = isFloor(kind) ? strike - premium : strike + premium;
  return { value, text: `${isFloor(kind) ? 'Below' : 'Above'} ${rate(value)}` };
}

const STATUS = {
  pending_payment: ['credit-card', 'warning', 'Awaiting payment'], paid: ['circle-check', 'info', 'Paid'],
  reserving: ['clock', 'info', 'Reserving'], reserved: ['server', 'info', 'Reserved'],
  delivering: ['circle-play', 'success', 'Delivering'], settled: ['flag', 'neutral', 'Settled'],
  cancelled: ['circle-x', 'neutral', 'Cancelled'], declined: ['ban', 'error', 'Declined by the neocloud'],
};
export const statusPill = status => { const [iconName, toneName, label] = STATUS[status] || ['info', 'neutral', status]; return pill(iconName, toneName, label); };
export const statusName = status => STATUS[status]?.[2] || status;

const EVENT_TEXT = {
  'reservation.requested': 'Reservation requested from the neocloud',
  'reservation.confirmed': 'The neocloud confirmed the reservation',
  'reservation.declined': 'The neocloud declined the reservation',
  'delivery.started': 'The delivery window started',
  'usage.reported': 'Daily usage reported',
  'window.closed': 'The delivery window closed',
  'settlement.computed': 'Settled on the window average',
  'invoice.issued': 'Compute invoice issued',
  'payout.issued': 'Payout issued through the escrow agent',
  'listing.created': 'Listing posted',
  'bid.received': 'A bid arrived on your listing',
  'resale.completed': 'Resale completed',
};
export const eventText = event => event.summary || event.message || `${EVENT_TEXT[event.type] || event.type || 'Event'}${event.orderRef ? ` · ${event.orderRef}` : ''}`;

const stamp = iso => (iso ? `${shortDate(iso)}, ${new Date(iso).toISOString().slice(11, 16)} UTC` : '—');

/** Mock outbox rows as click-to-open items: subject, recipient and date, with the plain-text body on open. */
export const emailItems = emails => emails.map(m => `<li><details class="p-mail"><summary>${icon('mail')}<span><b>${esc(m.subject)}</b><span>To ${esc(m.to)}${m.orderRef ? ` · ${esc(m.orderRef)}` : ''}</span></span><small>${esc(stamp(m.at))}</small></summary>
  <pre class="p-mail-body">${esc(m.body)}</pre></details></li>`).join('');

const DIRECTIONS = { dodona_to_neocloud: ['Dodona → neocloud', ''], neocloud_to_dodona: ['Neocloud → Dodona', ' is-in'], internal: ['Internal', ''] };
/** Webhook-style integration events; payloads are pretty-printed JSON, escaped. */
export const eventItems = events => events.map(e => {
  const [label, cls] = DIRECTIONS[e.direction] || [e.direction || 'Event', ''];
  const payload = JSON.stringify({ id: e.id, type: e.type, orderRef: e.orderRef, at: e.at, httpStatus: e.httpStatus, payload: e.payload }, null, 2);
  return `<li><details class="p-ev"><summary><span class="p-dir${cls}">${esc(label)}</span><b>${esc(e.type)}</b><small>${esc(e.httpStatus ?? '')} · ${esc(stamp(e.at))}</small></summary><pre>${esc(payload)}</pre></details></li>`;
}).join('');

const FLOWS = {
  buyer_to_neocloud: 'Compute bill to the neocloud', premium_to_neocloud: 'Premium to the neocloud (85%)', premium_to_dodona: 'Platform fee to Dodona (15%)',
  resale_to_holder: 'Resale proceeds to you', floor_to_holder: 'Floor payout to you',
};
export const payoutRows = payouts => payouts.map(p => `<tr><th scope="row">${esc(FLOWS[p.direction] || p.direction)}${p.orderRef ? `<span class="d-sub">${esc(p.orderRef)}</span>` : ''}</th>
  <td class="r d-num">${esc(money(p.amount))}</td><td>${p.status === 'paid' ? pill('circle-check', 'success', 'Paid') : pill('clock', 'warning', 'Scheduled')}</td>
  <td>${esc(fmtDate(p.dueAt))}</td><td>${esc(p.paidAt ? fmtDate(p.paidAt) : '—')}</td></tr>`).join('');

function toastFired(fired) {
  const list = Array.isArray(fired) ? fired : [];
  // Daily usage reports arrive one per day; fold them into one line so the toasts stay readable.
  const usage = list.filter(e => e.type === 'usage.reported');
  const rest = list.filter(e => e.type !== 'usage.reported');
  rest.slice(0, MAX_EVENT_TOASTS).forEach(e => toast(eventText(e)));
  if (rest.length > MAX_EVENT_TOASTS) toast(`And ${rest.length - MAX_EVENT_TOASTS} more events. See each order's timeline.`);
  if (usage.length) toast(`${usage.length} daily usage report${usage.length === 1 ? '' : 's'} from the neocloud`);
  if (!list.length) toast('Nothing was due in that time.');
}

/* ---------- account menu ---------- */
function mountAccount(account) {
  const box = $('p-acct');
  if (!box) return;
  box.hidden = false;
  const kyb = account.kyb === 'verified' ? 'KYB verified' : account.kyb === 'rejected' ? 'KYB rejected' : 'KYB pending';
  box.innerHTML = `<button type="button" class="c-acct p-acct-btn" data-pop="p-acct-pop" aria-expanded="false" aria-controls="p-acct-pop" aria-label="Account: ${esc(account.company)}">
      ${icon('user', 'p-acct-ic')}<span class="c-acct-text"><span class="c-acct-org">${esc(account.company)}</span><span class="c-acct-role">${esc(ROLE_TEXT[account.role] || account.role)}</span></span>
      <span class="d-kyb${account.kyb === 'verified' ? '' : ' is-pending'}">${esc(kyb)}</span>${icon('chevron-down', 'p-chev')}</button>
    <div class="p-pop p-pop-acct" id="p-acct-pop" hidden>
      <p class="p-pop-who">${icon('user')}<span>Signed in as<b>${esc(account.email)}</b></span></p>
      <button type="button" class="c-menu-item" data-shell="sign-out">${icon('log-out')}<span>Sign out</span></button>
    </div>`;
}

/* ---------- Help menu: the page's guided tour and a link or two ---------- */
let helpTour = null;

function mountHelp(account) {
  const box = $('p-tour');
  helpTour = box ? tourFor(tourName(location.pathname, account.role), account) : null;
  if (!helpTour) return;
  const links = helpTour.links.map(([href, iconName, label]) => `<a class="c-menu-item" href="${esc(href)}">${icon(iconName)}<span>${esc(label)}</span></a>`).join('');
  box.innerHTML = `<button type="button" class="c-top-btn p-tour-btn" id="p-tour-btn" data-pop="p-tour-pop" aria-expanded="false" aria-controls="p-tour-pop" aria-label="Help">${icon('circle-help')}<span class="p-tour-lbl">Help</span></button>
    <div class="p-pop p-pop-tour" id="p-tour-pop" hidden>
      <button type="button" class="c-menu-item" data-shell="tour">${icon('circle-play')}<span>Take the tour</span></button>${links}
    </div>`;
  const dot = tourDot(helpTour.key);
  if (dot) $('p-tour-btn').append(dot);
  box.hidden = false;
}

function runTour() {
  if (helpTour) startTour(helpTour.steps, { key: helpTour.key, opener: $('p-tour-btn') });
}

export async function signOut() {
  try { await api('/api/auth/sign-out', { method: 'POST', body: {} }); } catch { /* the cookie may already be gone; go to sign-in anyway */ }
  location.assign('/sign-in');
}

/* ---------- demo clock ---------- */
function clockHtml(account) {
  const options = SCENARIOS.map(([value, label]) => `<option value="${value}"${value === account.scenario ? ' selected' : ''}>${esc(label)}</option>`).join('');
  return `<button type="button" class="p-clock-btn" data-pop="p-clock-pop" aria-expanded="false" aria-controls="p-clock-pop" aria-label="Demo clock: ${esc(fmtDate(account.demoNow))}. Open the clock controls.">
      ${icon('clock')}<span class="p-clock-lbl">Demo date</span><b id="p-clock-date">${esc(fmtDate(account.demoNow))}</b>${icon('chevron-down', 'p-chev')}</button>
    <div class="p-pop p-pop-clock" id="p-clock-pop" hidden role="group" aria-label="Demo clock controls">
      <p class="p-pop-h">Demo clock<span>Moves this account's simulated date. Every due step runs in order and shows here as a toast.</span></p>
      <div class="p-clock-grid">
        <button type="button" class="btn btn-sm" data-clock="day">${icon('plus')}<span>+1 day</span></button>
        <button type="button" class="btn btn-sm" data-clock="week">${icon('fast-forward')}<span>+7 days</span></button>
        <button type="button" class="btn btn-sm" data-clock="next">${icon('skip-forward')}<span>To next event</span></button>
        <button type="button" class="btn btn-sm" data-clock="settle">${icon('flag')}<span>To settlement</span></button>
      </div>
      <div class="field p-clock-scn"><label for="p-scenario">Index scenario after the last real print</label><select id="p-scenario">${options}</select></div>
      <button type="button" class="btn btn-sm p-clock-reset" data-clock="reset" aria-describedby="p-reset-note">${icon('rotate-ccw')}<span>Reset this demo account</span></button>
      <p class="fine" id="p-reset-note">Reset puts the orders, prints, emails and clock back to the seeded start.</p>
    </div>`;
}

const CLOCK_CALLS = {
  day: () => api('/api/demo/advance', { method: 'POST', body: { days: 1 } }),
  week: () => api('/api/demo/advance', { method: 'POST', body: { days: 7 } }),
  next: () => api('/api/demo/advance', { method: 'POST', body: { until: 'next-event' } }),
  settle: () => api('/api/demo/advance', { method: 'POST', body: { until: 'settlement' } }),
  reset: () => api('/api/demo/reset', { method: 'POST', body: {} }),
};

function wireClock(box, account, onChange) {
  let busy = false;
  let armedReset = false;
  const setBusy = on => { busy = on; box.querySelectorAll('button[data-clock], select').forEach(el => { el.disabled = on; }); box.setAttribute('aria-busy', String(on)); };
  const finish = async (result, message) => {
    if (result?.demoNow) { account.demoNow = result.demoNow; $('p-clock-date').textContent = fmtDate(result.demoNow); }
    if (result?.account?.demoNow) { account.demoNow = result.account.demoNow; $('p-clock-date').textContent = fmtDate(account.demoNow); }
    if (message) toast(message);
    if (result?.fired) toastFired(result.fired);
    await onChange?.(account);
  };
  box.addEventListener('click', async event => {
    const button = event.target.closest('[data-clock]');
    if (!button || busy) return;
    const kind = button.dataset.clock;
    if (kind === 'reset' && !armedReset) {
      armedReset = true;
      button.classList.add('is-armed');
      button.querySelector('span').textContent = 'Confirm reset: click again';
      return;
    }
    setBusy(true);
    try {
      const result = await CLOCK_CALLS[kind]();
      if (kind === 'reset') { armedReset = false; button.classList.remove('is-armed'); button.querySelector('span').textContent = 'Reset this demo account'; }
      await finish(result, kind === 'reset' ? 'Account reset to its starting state.' : '');
    } catch (error) {
      toast(error.message);
    } finally { setBusy(false); }
  });
  box.addEventListener('change', async event => {
    if (event.target.id !== 'p-scenario' || busy) return;
    setBusy(true);
    try {
      const result = await api('/api/demo/scenario', { method: 'POST', body: { scenario: event.target.value } });
      account.scenario = event.target.value;
      await finish(result, `Scenario set to ${event.target.value}. Synthetic prints after the last real index day were regenerated.`);
    } catch (error) {
      toast(error.message);
    } finally { setBusy(false); }
  });
}

function mountClock(account, onChange) {
  const box = $('p-clock');
  if (!box || !account.demoNow) return;
  box.hidden = false;
  box.innerHTML = clockHtml(account);
  wireClock(box, account, onChange);
}

/* ---------- popovers and the phone "More" sheet ---------- */
function closePops(except) {
  document.querySelectorAll('.p-pop:not([hidden])').forEach(pop => {
    if (pop === except) return;
    pop.hidden = true;
    document.querySelector(`[data-pop="${pop.id}"]`)?.setAttribute('aria-expanded', 'false');
  });
}

let popsWired = false;
function wirePops() {
  if (popsWired) return;
  popsWired = true;
  document.addEventListener('click', event => {
    const opener = event.target.closest('[data-pop]');
    if (opener) {
      const pop = $(opener.dataset.pop);
      closePops(pop);
      pop.hidden = !pop.hidden;
      opener.setAttribute('aria-expanded', String(!pop.hidden));
      return;
    }
    if (event.target.closest('[data-shell="sign-out"]')) { signOut(); return; }
    if (event.target.closest('[data-shell="tour"]')) { closePops(); runTour(); return; }
    if (!event.target.closest('.p-pop') || event.target.closest('.p-pop a')) closePops();
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const open = document.querySelector('.p-pop:not([hidden])');
    if (!open) return;
    closePops();
    document.querySelector(`[data-pop="${open.id}"]`)?.focus();
  });
}

export function wireNavMore() {
  const more = $('d-nav-more');
  if (!more || more.dataset.wired) return;
  more.dataset.wired = '1';
  more.addEventListener('click', () => {
    const open = $('d-rail').classList.toggle('is-more');
    more.setAttribute('aria-expanded', String(open));
  });
}

/**
 * Fills the top bar for a signed-in account: the Help menu, account chip with sign-out, and the demo clock.
 * `onChange(account)` runs after every clock move so the page can reload its data.
 */
export function mountShell(account, { onChange } = {}) {
  wirePops();
  wireNavMore();
  mountHelp(account);
  mountAccount(account);
  mountClock(account, onChange);
}

/** Shows the page's "sign in first" or "platform off" panel instead of its content. */
export function showGate(account, { gate = 'p-gate', content = 'p-content' } = {}) {
  wireNavMore();
  const box = $(gate);
  if ($(content)) $(content).hidden = true;
  if (!box) return;
  box.hidden = false;
  if (account?.off) box.innerHTML = '<p class="p-off">The platform is off on this server.</p>';
}

/** Standard page start: account, then the shell, then the page's own loader; the gate when signed out. */
export async function startPage(load) {
  document.documentElement.classList.remove('no-js');
  let account;
  try { account = await loadAccount(); } catch (error) { toast(error.message); return null; }
  if (!account || account.off) { showGate(account); return null; }
  mountShell(account, { onChange: () => load(account) });
  await load(account);
  document.body.dataset.ready = '1';
  return account;
}

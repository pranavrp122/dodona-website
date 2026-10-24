/** Demo admin portal: a hash-routed console over the admin API for accounts, orders, neoclouds, activity and the Supabase mirror. */
import * as v from './admin-view.js';
import { mountShell } from '/platform-shell.js';

const $ = id => document.getElementById(id);
const esc = v.esc;
const SEARCH_DELAY_MS = 250;
const CONFIRM_MS = 6000;
const SCREENS = {
  accounts: { title: 'Accounts', desc: 'Every account, who it belongs to and how far along it is.' },
  account: { title: 'Account', desc: '' },
  orders: { title: 'Orders', desc: 'Every order across all accounts, newest first.' },
  neoclouds: { title: 'Neoclouds', desc: 'The neoclouds: capacity per GPU and region, and the contracts written on it.' },
  activity: { title: 'Activity', desc: 'Recent failures across every account, and the latest messages between Dodona and the neoclouds.' },
  sync: { title: 'Supabase sync', desc: 'Save the CRM to your Supabase project.' },
};

const state = { me: null, route: { screen: 'accounts', id: '' }, filters: {}, orderStatus: '', creating: false, detail: null, eventRef: '', searchTimer: 0, resetTimer: 0 };
// --- activity log (feature/activity): the account's log filters, the rows loaded so far and the next-page cursor ---
const freshActivity = accountId => ({ accountId, kind: '', failed: false, q: '', since: '', until: '', rows: [], next: null, seq: 0, timer: 0 });
state.act = freshActivity('');
// --- end activity log ---

class ApiError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 204) return {};
  let data = null;
  try { data = await response.json(); } catch { /* an empty or non-JSON body is reported below */ }
  if (!response.ok || data?.ok === false) throw new ApiError(response.status, data?.error?.message || data?.message || 'The server could not complete that.', data?.error?.code);
  return data;
}

function toast(message) {
  const box = $('d-toasts');
  const item = document.createElement('div');
  item.className = 'd-toast';
  item.textContent = message;
  box.append(item);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => item.remove(), 5200);
}

function setMessage(id, text, isError = true) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
  el.classList.toggle('is-loss', Boolean(text) && isError);
  el.classList.toggle('is-gain', Boolean(text) && !isError);
}

function parseHash() {
  const [screen, id = ''] = location.hash.replace(/^#/, '').split('/');
  return SCREENS[screen] ? { screen, id: decodeURIComponent(id) } : { screen: 'accounts', id: '' };
}

function frame({ title, desc, crumbs = [], acts = '' }) {
  $('a-title').textContent = title;
  $('a-desc').textContent = desc;
  $('a-desc').hidden = !desc;
  $('a-acts').innerHTML = acts;
  const trail = [['Admin', '#accounts'], ...crumbs];
  $('a-crumbs').innerHTML = trail.map(([text, href], i) => (i === trail.length - 1 ? `<span aria-current="page">${esc(text)}</span>` : `<a href="${href}">${esc(text)}</a><span aria-hidden="true">/</span>`)).join('');
  document.title = `${title} · Admin — Dodona`;
  const nav = state.route.screen === 'account' ? 'accounts' : state.route.screen;
  document.querySelectorAll('[data-nav]').forEach(link => (link.dataset.nav === nav ? link.setAttribute('aria-current', 'page') : link.removeAttribute('aria-current')));
}

const screen = html => { $('a-screen').innerHTML = html; };
const loading = text => screen(`<p class="d-empty">${esc(text)}</p>`);

// Accounts
const accountQuery = () => new URLSearchParams(Object.entries(state.filters).filter(([, value]) => value)).toString();

async function loadAccountRows() {
  const query = accountQuery();
  const { accounts } = await api(`/api/admin/accounts${query ? '?' + query : ''}`);
  $('a-acc-rows').innerHTML = accounts.length ? v.accountRows(accounts).join('') : `<tr><td colspan="${v.ACCOUNT_HEADS.length}" class="d-empty">No accounts match these filters.</td></tr>`;
  $('a-acc-count').textContent = String(accounts.length);
  $('a-export').href = `/api/admin/accounts.csv${query ? '?' + query : ''}`;
}

async function showAccounts() {
  frame({
    ...SCREENS.accounts, crumbs: [['Accounts']],
    acts: `<a class="btn" id="a-export" href="/api/admin/accounts.csv" download>${v.icon('download')}<span>Export CSV</span></a>
      <button type="button" class="btn btn-primary" data-act="create-open" aria-expanded="${state.creating}" aria-controls="a-create-slot">${v.icon('user-plus')}<span>Create account</span></button>`,
  });
  const create = state.creating
    ? v.container({ id: 'a-create-box', title: 'Create an account', iconName: 'user-plus', desc: 'Pre-make a login for a meeting. It signs in at /sign-in like any other account.', body: `<div class="c-ctr-b">${v.createForm()}</div>` })
    : '';
  screen(`<div class="c-stack">
    <div id="a-create-slot">${create}</div>
    <section class="c-ctr" aria-labelledby="a-acc-h">
      <div class="c-ctr-h"><div><h2 id="a-acc-h">Accounts <span class="c-count" id="a-acc-count"></span></h2><p>Open a row for the contact card, notes, orders and activity.</p></div></div>
      <div class="c-ctr-b a-filter-bar">${v.accountFilters(state.filters)}</div>
      ${v.table('Accounts', v.ACCOUNT_HEADS, [`<tr><td colspan="${v.ACCOUNT_HEADS.length}" class="d-empty">Loading accounts…</td></tr>`], '').replace('<tbody>', '<tbody id="a-acc-rows">')}
    </section></div>`);
  await loadAccountRows();
}

async function createAccount(form) {
  const data = Object.fromEntries(new FormData(form));
  data.email = data.email.trim();
  data.company = data.company.trim();
  if (!data.email || !data.company || data.password.length < 8) return setMessage('a-create-msg', 'Enter an email, a company and a password of at least 8 characters.');
  const button = form.querySelector('[type=submit]');
  button.disabled = true;
  try {
    const { account } = await api('/api/admin/accounts', { method: 'POST', body: data });
    state.creating = false;
    toast(`Created ${account.email}. It can sign in now.`);
    location.hash = `#account/${encodeURIComponent(account.id)}`;
  } catch (error) {
    setMessage('a-create-msg', error.message);
  } finally {
    button.disabled = false;
  }
}

// Account detail
function eventsFor(detail) {
  const events = state.eventRef ? detail.events.filter(e => e.orderRef === state.eventRef) : detail.events;
  const acts = state.eventRef ? `<button type="button" class="btn btn-sm" data-act="events-all">${v.icon('x')}<span>Show all</span></button>` : '';
  return v.container({
    id: 'a-d-events', title: state.eventRef ? `Neocloud messages for ${state.eventRef}` : 'Integration events', iconName: 'activity', count: events.length, acts,
    desc: 'The messages Dodona and the neocloud exchanged for this account.',
    body: `<div class="a-tall">${v.table('Integration events', v.EVENT_HEADS, v.eventRows(events), 'No events yet.')}</div>`,
  });
}

function accountDetailHtml(d) {
  const a = d.account;
  const provider = a.role === 'provider' && d.neocloud;
  return `<div class="c-grid">
    ${v.container({ id: 'a-d-contact', title: 'Contact', iconName: 'users', span: 'c-s5', desc: `${v.roleText(a.role)} · ${a.company || a.email}`, body: `<div class="a-pills">${v.kybPill(a.kyb)}${v.stagePill(a.stage)}</div>${v.contactCard(a)}` })}
    ${v.container({ id: 'a-d-notes', title: 'Notes', iconName: 'message-square', count: d.notes.length, span: 'c-s7', desc: 'Newest first. Only admins see these.', body: `<div class="c-ctr-b">${v.notesList(d.notes)}${v.noteForm()}</div>` })}
    ${v.container({ id: 'a-d-clock', title: 'Demo clock', iconName: 'calendar-clock', span: provider ? 'c-s5' : 'c-s12', desc: 'Where this account\'s demo time and index scenario stand.', body: `<div id="a-clock-body">${v.clockCard(a, false)}</div>` })}
    ${provider ? v.container({ id: 'a-d-neocloud', title: 'Neocloud', iconName: 'server', span: 'c-s7', desc: 'The neocloud this provider login runs.', body: v.neocloudCard(d.neocloud) }) : ''}
    <div class="c-s12" id="a-d-activity-slot">${v.activityPanel(state.act)}</div>
    ${v.container({ id: 'a-d-orders', title: 'Orders', iconName: 'layers', count: d.orders.length, span: 'c-s12', body: v.table('Orders', v.orderHeads(false), v.orderRows(d.orders), 'No orders yet.') })}
    ${v.container({ id: 'a-d-payments', title: 'Payments', iconName: 'credit-card', count: d.payments.length, span: 'c-s12', desc: 'Card payments. Only the brand and last four digits are kept.', body: v.table('Payments', v.PAYMENT_HEADS, v.paymentRows(d.payments), 'No payments yet.') })}
    ${v.container({ id: 'a-d-payouts', title: 'Payouts', iconName: 'receipt', count: d.payouts.length, span: 'c-s12', desc: 'Through the escrow agent.', body: v.table('Payouts', v.PAYOUT_HEADS, v.payoutRows(d.payouts), 'No payouts yet.') })}
    ${v.container({ id: 'a-d-emails', title: 'Emails sent', iconName: 'mail', count: d.emails.length, span: 'c-s12', desc: 'Every email sent to this account.', body: `<div class="a-tall">${v.table('Emails', v.EMAIL_HEADS, v.emailRows(d.emails), 'No emails yet.')}</div>` })}
    <div class="c-s12" id="a-d-events-slot">${eventsFor(d)}</div>
  </div>`;
}

async function showAccount(id, { keepScroll = false } = {}) {
  if (!keepScroll) {
    frame({ ...SCREENS.account, crumbs: [['Accounts', '#accounts'], ['Account']] });
    loading('Loading the account…');
  }
  const detail = await api(`/api/admin/accounts/${encodeURIComponent(id)}`);
  state.detail = { notes: [], orders: [], payments: [], payouts: [], emails: [], events: [], neocloud: null, ...detail };
  if (state.act.accountId !== id) state.act = freshActivity(id);
  const a = state.detail.account;
  frame({ title: a.company || a.email, desc: `${a.email} · ${v.roleText(a.role)} · created ${v.day(a.createdAt)}`, crumbs: [['Accounts', '#accounts'], [a.company || a.email]] });
  const y = window.scrollY;
  screen(accountDetailHtml(state.detail));
  if (keepScroll) window.scrollTo(0, y);
  await loadActivity();
}

// --- activity log (feature/activity) ---
function activityQuery(before) {
  const f = state.act;
  const params = new URLSearchParams();
  if (f.kind) params.set('kind', f.kind);
  if (f.failed) params.set('failed', '1');
  if (f.q.trim()) params.set('q', f.q.trim());
  if (f.since) params.set('since', f.since);
  if (f.until) params.set('until', f.until);
  if (before) params.set('before', before);
  return params.toString();
}

// Loads the first page for the current filters, or the next page with { more: true }; a newer load wins over a slower older one.
async function loadActivity({ more = false } = {}) {
  const f = state.act;
  if (!$('a-act-rows')) return;
  const seq = ++f.seq;
  const base = `/api/admin/accounts/${encodeURIComponent(f.accountId)}/activity`;
  const query = activityQuery(more ? f.next : null);
  let data;
  try {
    data = await api(`${base}${query ? '?' + query : ''}`);
  } catch (error) {
    if (seq === f.seq && $('a-act-count')) $('a-act-count').textContent = error.message;
    return;
  }
  if (seq !== f.seq || !$('a-act-rows')) return;
  f.rows = more ? [...f.rows, ...data.rows] : data.rows;
  f.next = data.nextBefore;
  $('a-act-rows').innerHTML = f.rows.length ? v.activityRows(f.rows).join('') : `<tr><td colspan="${v.ACTIVITY_HEADS.length}" class="d-empty">Nothing matches these filters yet.</td></tr>`;
  $('a-act-more').hidden = !f.next;
  $('a-act-count').textContent = `${f.rows.length} ${f.rows.length === 1 ? 'row' : 'rows'} shown${f.next ? '. Older rows below.' : '.'}`;
  const csv = activityQuery(null);
  $('a-act-csv').href = `${base}.csv${csv ? '?' + csv : ''}`;
}

function setActivityFilter(changes, delay = 0) {
  Object.assign(state.act, changes);
  document.querySelectorAll('[data-act="act-kind"]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.kind === state.act.kind)));
  document.querySelector('[data-act="act-failed"]')?.setAttribute('aria-pressed', String(state.act.failed));
  clearTimeout(state.act.timer);
  state.act.timer = setTimeout(() => loadActivity().catch(fail), delay);
}
// --- end activity log ---

async function saveContact(form) {
  const body = Object.fromEntries(new FormData(form));
  body.company = body.company.trim();
  body.phone = body.phone.trim();
  if (!body.company) return setMessage('a-contact-msg', 'Company cannot be empty.');
  try {
    await api(`/api/admin/accounts/${encodeURIComponent(state.route.id)}`, { method: 'POST', body });
    toast('Contact details saved.');
    await showAccount(state.route.id, { keepScroll: true });
  } catch (error) {
    setMessage('a-contact-msg', error.message);
  }
}

async function addNote(form) {
  const text = form.text.value.trim();
  if (!text) return setMessage('a-note-msg', 'Write the note first.');
  try {
    await api(`/api/admin/accounts/${encodeURIComponent(state.route.id)}/notes`, { method: 'POST', body: { text } });
    toast('Note added.');
    await showAccount(state.route.id, { keepScroll: true });
    $('a-note-text')?.focus({ preventScroll: true });
  } catch (error) {
    setMessage('a-note-msg', error.message);
  }
}

function askReset(confirming) {
  clearTimeout(state.resetTimer);
  if (!state.detail || !$('a-clock-body')) return;
  $('a-clock-body').innerHTML = v.clockCard(state.detail.account, confirming);
  if (!confirming) return;
  document.querySelector('[data-act="reset-confirm"]')?.focus();
  state.resetTimer = setTimeout(() => askReset(false), CONFIRM_MS);
}

async function resetAccount() {
  clearTimeout(state.resetTimer);
  try {
    await api(`/api/admin/accounts/${encodeURIComponent(state.route.id)}/reset`, { method: 'POST', body: {} });
    toast('Account reset to its starting state.');
  } catch (error) {
    toast(error.message);
  }
  await showAccount(state.route.id, { keepScroll: true });
}

// Orders, neoclouds, activity
async function showOrders() {
  frame({ ...SCREENS.orders, crumbs: [['Orders']] });
  const statuses = ['', ...v.ORDER_STATUSES];
  const seg = `<div class="d-seg a-seg" role="group" aria-label="Filter by status">${statuses.map(s => `<button type="button" data-act="order-status" data-status="${s}" aria-pressed="${s === state.orderStatus}">${esc(s ? v.label(s) : 'All')}</button>`).join('')}</div>`;
  const { orders } = await api(`/api/admin/orders${state.orderStatus ? '?status=' + encodeURIComponent(state.orderStatus) : ''}`);
  screen(`<div class="c-stack">${v.container({ id: 'a-orders', title: 'All orders', iconName: 'layers', count: orders.length, body: `<div class="c-ctr-b">${seg}</div>${v.table('All orders', v.orderHeads(true), v.orderRows(orders, { withAccount: true }), 'No orders with this status.')}` })}<div id="a-order-events"></div></div>`);
}

async function showOrderEvents(ref) {
  if (state.route.screen === 'account') {
    state.eventRef = ref;
    $('a-d-events-slot').innerHTML = eventsFor(state.detail);
    $('a-d-events-slot').scrollIntoView({ block: 'start' });
    return;
  }
  const { events } = await api(`/api/integration/events?orderRef=${encodeURIComponent(ref)}`);
  $('a-order-events').innerHTML = v.container({ id: 'a-oe', title: `Neocloud messages for ${ref}`, iconName: 'activity', count: events.length, body: v.table('Order events', v.EVENT_HEADS, v.eventRows(events), 'No events for this order yet.') });
  $('a-order-events').scrollIntoView({ block: 'start' });
}

async function showNeoclouds() {
  frame({ ...SCREENS.neoclouds, crumbs: [['Neoclouds']] });
  loading('Loading neoclouds…');
  const [{ neoclouds }, { orders }] = await Promise.all([api('/api/admin/neoclouds'), api('/api/admin/orders')]);
  const onCloud = id => orders.filter(o => o.neocloud?.id === id);
  screen(`<div class="c-stack">${neoclouds.length ? neoclouds.map(n => v.neocloudBlock(n, onCloud(n.id))).join('') : '<p class="d-empty">No neoclouds seeded.</p>'}</div>`);
}

async function showActivity() {
  frame({ ...SCREENS.activity, crumbs: [['Activity']] });
  loading('Loading activity…');
  const [{ events }, { rows: failures }] = await Promise.all([api('/api/admin/events?limit=200'), api('/api/admin/activity/failures?limit=50')]);
  // --- activity log (feature/activity): the latest failed calls, script errors and sign-ins across accounts ---
  const failed = v.container({
    id: 'a-failures', title: 'Recent failures', iconName: 'triangle-alert', count: failures.length,
    desc: 'Failed API calls, script errors and failed sign-ins from every account, newest first. Open the account for its full log.',
    body: `<div class="a-tall a-act-list">${v.table('Recent failures', v.FAILURE_HEADS, v.failureRows(failures), 'No failures yet.')}</div>`,
  });
  // --- end activity log ---
  screen(`<div class="c-stack">${failed}${v.container({ id: 'a-activity', title: 'Latest events', iconName: 'activity', count: events.length, body: v.table('Latest events', v.EVENT_HEADS, v.eventRows(events), 'Nothing has happened yet. Place an order from a buyer account to see messages here.') })}</div>`);
}

// Supabase sync
async function showSync() {
  frame({ ...SCREENS.sync, crumbs: [['Supabase sync']] });
  loading('Checking the mirror…');
  screen(v.syncPanel(await api('/api/admin/sync')));
}

async function syncNow(button) {
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  let result;
  try {
    result = await api('/api/admin/sync', { method: 'POST', body: {} });
  } catch (error) {
    result = { ok: false, message: error.message };
  }
  const status = await api('/api/admin/sync').catch(() => null);
  if (status) screen(v.syncPanel(status));
  else { button.disabled = false; button.removeAttribute('aria-busy'); }
  setMessage('a-sync-msg', result.message || (result.ok ? 'Synced.' : 'The sync did not run.'), !result.ok);
}

// Routing and events
async function route() {
  state.route = parseHash();
  if (state.route.screen !== 'account') { state.detail = null; state.eventRef = ''; }
  clearTimeout(state.resetTimer);
  const { screen: name, id } = state.route;
  try {
    if (name === 'account' && id) await showAccount(id);
    else if (name === 'orders') await showOrders();
    else if (name === 'neoclouds') await showNeoclouds();
    else if (name === 'activity') await showActivity();
    else if (name === 'sync') await showSync();
    else await showAccounts();
  } catch (error) {
    if (error.status === 401 || error.status === 403) return showGate(error.status === 401 ? null : state.me);
    screen(`<p class="d-empty">${esc(error.status === 404 ? 'That record no longer exists.' : error.message)}</p>`);
  }
  $('main').focus({ preventScroll: true });
}

const fail = error => toast(error.message);
const ACTIONS = {
  'create-open': () => { state.creating = !state.creating; showAccounts().then(() => $('a-c-email')?.focus()).catch(fail); },
  'create-close': () => { state.creating = false; showAccounts().catch(fail); },
  'order-status': button => { state.orderStatus = button.dataset.status; showOrders().catch(fail); },
  'order-events': button => showOrderEvents(button.dataset.ref).catch(fail),
  'events-all': () => { state.eventRef = ''; $('a-d-events-slot').innerHTML = eventsFor(state.detail); },
  reset: () => askReset(true),
  'reset-cancel': () => askReset(false),
  'reset-confirm': () => resetAccount(),
  'sync-now': button => syncNow(button),
  'act-kind': button => setActivityFilter({ kind: button.dataset.kind }),
  'act-failed': () => setActivityFilter({ failed: !state.act.failed }),
  'act-more': () => loadActivity({ more: true }).catch(fail),
};

function onClick(event) {
  const button = event.target.closest('[data-act]');
  if (button && ACTIONS[button.dataset.act]) return ACTIONS[button.dataset.act](button);
  const row = event.target.closest('tr[data-href]');
  if (row && !event.target.closest('a, button, summary, details')) location.hash = row.dataset.href;
}

function onSubmit(event) {
  const handler = { 'a-create': createAccount, 'a-contact': saveContact, 'a-note-form': addNote, 'a-filters': () => {}, 'a-act-filters': () => {} }[event.target.id];
  if (!handler) return;
  event.preventDefault();
  handler(event.target);
}

function onFilter(event) {
  const log = event.target.closest('#a-act-filters');
  if (log) {
    const data = new FormData(log);
    return setActivityFilter({ q: String(data.get('q') || ''), since: String(data.get('since') || ''), until: String(data.get('until') || '') }, event.type === 'input' ? SEARCH_DELAY_MS : 0);
  }
  const form = event.target.closest('#a-filters');
  if (!form) return;
  state.filters = Object.fromEntries(new FormData(form));
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => loadAccountRows().catch(fail), event.type === 'input' ? SEARCH_DELAY_MS : 0);
}

function showGate(account) {
  $('a-loading').hidden = true;
  $('a-content').hidden = true;
  $('d-rail').hidden = true;
  $('a-app').classList.add('is-gated');
  $('a-gate').hidden = false;
  if (!account) return;
  $('a-gate-say').textContent = `You are signed in as ${account.email}, a ${v.roleText(account.role).toLowerCase()} account. The admin portal needs an admin login: sign out, then sign in as an admin.`;
  mountShell(account);
}

async function start() {
  document.documentElement.classList.remove('no-js');
  let account = null;
  try {
    ({ account } = await api('/api/account'));
  } catch (error) {
    if (error.status !== 401) { $('a-loading').textContent = 'The admin portal could not load. Refresh to try again.'; return; }
  }
  if (!account || account.role !== 'admin') return showGate(account);
  state.me = account;
  // The account menu with sign-out is the shared console shell; the admin has no demo clock of its own.
  mountShell(account);
  $('a-loading').hidden = true;
  $('a-content').hidden = false;
  $('d-rail').hidden = false;
  $('main').tabIndex = -1;
  document.addEventListener('click', onClick);
  document.addEventListener('submit', onSubmit);
  document.addEventListener('input', onFilter);
  document.addEventListener('change', onFilter);
  window.addEventListener('hashchange', route);
  await route();
  document.body.dataset.admin = 'ready';
}

start();

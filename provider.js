/** Provider portal: account gate, hash routes, demo clock, reservation decisions, contracts what-if, statements and the integration log. All data comes from the same-origin platform API. */
import * as v from '/provider-view.js';
import { mountShell, fmtDate } from '/platform-shell.js';

const $ = id => document.getElementById(id);
const esc = v.escapeHtml;
const ARM_MS = 4000;
const URL_MAX = 300;
const EVENTS_SHOWN = 30;

const state = {
  account: null, screen: 'overview', overview: null, orders: { incoming: [], active: [], settled: [] },
  contracts: [], settlements: [], payouts: [], events: [], settings: {}, armed: null,
};

class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

async function api(path, { method = 'GET', body } = {}) {
  const init = { method, headers: { Accept: 'application/json' }, credentials: 'same-origin' };
  if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const response = await fetch(path, init);
  if (response.status === 204) return {};
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok || data?.ok === false) {
    const error = data?.error ?? {};
    throw new ApiError(response.status, error.code ?? 'error', error.message ?? data?.message ?? `Request failed (${response.status}).`);
  }
  return data ?? {};
}

function toast(message) {
  const box = $('d-toasts');
  const item = document.createElement('div');
  item.className = 'd-toast';
  item.textContent = message;
  box.append(item);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => item.remove(), 6000);
}

// Bar widths arrive as data attributes and become custom properties (the CSP allows no style attributes).
const applyBars = root => root.querySelectorAll('[data-w]').forEach(el => el.style.setProperty('--w', `${el.dataset.w}%`));
function fill(id, html) {
  const el = $(id);
  if (!el) return;
  el.innerHTML = html;
  applyBars(el);
}
const count = (id, n) => { $(id).textContent = n ? String(n) : ''; };

/* ---------- gate ---------- */
function showGate(account, platformOff) {
  $('p-gate').hidden = false;
  $('d-content').hidden = true;
  $('d-rail').hidden = true;
  if (platformOff) {
    $('p-gate-text').textContent = 'The demo platform is off on this server, so the provider portal is not available.';
    return;
  }
  if (account) {
    $('p-gate-text').textContent = `You are signed in as ${account.company || account.email}, a ${account.role} account. This portal is for neoclouds that supply the compute; sign in with a provider account to use it.`;
    const home = $('p-gate-home');
    if (typeof account.home === 'string' && account.home.startsWith('/') && !account.home.startsWith('//')) home.href = account.home;
    home.hidden = false;
    $('p-gate-signout').hidden = false;
  }
}

/* ---------- loading ---------- */
const settled = async promise => { try { return await promise; } catch (error) { if (error.status === 401) location.assign('/sign-in'); return null; } };

async function loadAll() {
  const [overview, orders, contracts, settlementsData, payouts, events, settings] = await Promise.all([
    settled(api('/api/provider/overview')), settled(api('/api/provider/orders')), settled(api('/api/provider/contracts')),
    settled(api('/api/provider/settlements')), settled(api('/api/provider/payouts')), settled(api('/api/provider/events')),
    settled(api('/api/provider/settings')),
  ]);
  if (overview) state.overview = v.normalizeOverview(overview);
  if (orders) state.orders = v.bucketOrders(orders);
  if (contracts) state.contracts = v.normalizeContracts(contracts);
  if (settlementsData) state.settlements = settlementsData.settlements ?? [];
  if (payouts) state.payouts = payouts.payouts ?? [];
  if (events) state.events = events.events ?? [];
  if (settings) state.settings = v.normalizeSettings(settings);
  if (!overview && !orders) toast('Portal data could not be loaded. Try Refresh in a moment.');
  renderAll();
}

async function loadAccount() {
  const data = await api('/api/account');
  state.account = data.account ?? data;
  return state.account;
}

/* ---------- rendering ---------- */
function renderTop() {
  const a = state.account;
  // The demo clock and account chip are the shared console shell, mounted once; later loads only refresh the date.
  if (!state.shell) { state.shell = true; mountShell(a, { onChange: () => refreshAll() }); }
  else if ($('p-clock-date')) $('p-clock-date').textContent = fmtDate(a.demoNow);
  const pending = state.orders.incoming.length;
  $('p-badge').textContent = String(pending);
  $('p-badge').hidden = !pending;
}

const kv = rows => rows.map(([k, val]) => `<div><dt>${esc(k)}</dt><dd>${esc(val ?? '—')}</dd></div>`).join('');
const autoConfirm = () => (state.settings.autoConfirm ?? state.account?.autoConfirm ?? true) !== false;

function renderOverview() {
  const o = state.overview;
  if (!o) return;
  fill('p-capacity', v.capacityRows(o.capacity));
  fill('p-income', v.incomeList(o.income));
  fill('p-next', v.deliveryList(o.nextDeliveries.length ? o.nextDeliveries : state.orders.active.filter(x => x.status === 'reserved')));
  $('p-pending').textContent = String(state.orders.incoming.length || o.pending);
  const auto = autoConfirm();
  $('p-pending-note').textContent = auto
    ? 'Auto-confirm is on: requests confirm when the demo clock next moves by an hour or more.'
    : 'Auto-confirm is off: each request waits for your Confirm or Decline.';
  const cloud = o.neocloud || state.account.neocloud || {};
  const regions = [...new Set(o.capacity.map(c => c.region).filter(Boolean))].join(', ') || '—';
  const total = o.capacity.reduce((sum, c) => sum + c.total, 0);
  fill('p-cloud', kv([['Name', cloud.name || state.account.company], ['Regions', regions], ['GPUs listed', v.int(total)], ['Auto-confirm', auto ? 'On' : 'Off'], ['Webhook', state.settings.webhookUrl || 'Not set']]));
}

function renderOrders() {
  const { incoming, active, settled: done } = state.orders;
  fill('p-incoming', v.incomingRows(incoming)); count('p-in-count', incoming.length);
  fill('p-active', v.activeRows(active)); count('p-act-count', active.length);
  fill('p-settled', v.settledRows(done)); count('p-set-count', done.length);
}

function renderContracts() {
  fill('p-contracts', v.contractRows(state.contracts));
  count('p-con-count', state.contracts.length);
  const strikes = state.contracts.map(c => c.strike).filter(s => s > 0);
  const input = $('p-wi-in');
  if (strikes.length && !input.dataset.ready) {
    const lo = Math.min(...strikes), hi = Math.max(...strikes);
    input.min = Math.max(0.05, lo * 0.4).toFixed(2);
    input.max = (hi * 1.8).toFixed(2);
    const expected = state.contracts.map(c => c.expectedAvg).filter(Number.isFinite);
    input.value = (expected.length ? expected.reduce((a, b) => a + b, 0) / expected.length : (lo + hi) / 2).toFixed(2);
    input.dataset.ready = '1';
  }
  renderWhatIf();
}

function renderWhatIf() {
  const avg = Number($('p-wi-in').value);
  $('p-wi-out').textContent = v.rate(avg);
  $('p-wi-in').setAttribute('aria-valuetext', `${v.rate(avg)} window average`);
  fill('p-wi-sum', v.whatIfSummary(state.contracts, avg));
}

function renderMoney() {
  fill('p-settlements', v.settlementRows(state.settlements)); count('p-stl-count', state.settlements.length);
  fill('p-payouts', v.payoutRows(state.payouts)); count('p-pay-count', state.payouts.length);
}

function renderIntegration() {
  const shown = state.showAllEvents ? state.events : state.events.slice(0, EVENTS_SHOWN);
  const more = state.events.length - shown.length;
  fill('p-events', v.eventRows(shown) + (more > 0 ? `<li class="p-more"><button type="button" class="btn btn-sm" data-act="all-events">Show all ${state.events.length} messages</button></li>` : ''));
  count('p-ev-count', state.events.length);
  const url = $('p-hook-url');
  if (document.activeElement !== url) url.value = state.settings.webhookUrl || '';
  const preview = state.settings.apiKeyLast4;
  $('p-key-state').textContent = preview
    ? `A key ending ${String(preview).slice(-4)} is active. It is shown once, when it is created; regenerate to get a new one.`
    : 'No key has been created yet in this demo. Regenerate to create one; it is shown once.';
}

function renderSettings() {
  $('p-auto').checked = autoConfirm();
  const a = state.account;
  fill('p-company', kv([['Company', a.company], ['Contact email', a.email], ['Role', 'Provider'], ['Neocloud', a.neocloud?.name || a.company], ['KYB', a.kyb || 'pending'], ['Stage', a.stage || 'demo']]));
}

function renderAll() {
  renderTop(); renderOverview(); renderOrders(); renderContracts(); renderMoney(); renderIntegration(); renderSettings();
}

/* ---------- routing ---------- */
function route() {
  const name = location.hash.replace(/^#/, '');
  state.screen = v.SCREENS.includes(name) ? name : 'overview';
  $('main').dataset.screen = state.screen;
  document.querySelectorAll('[data-screens]').forEach(el => { el.hidden = !el.dataset.screens.split(' ').includes(state.screen); });
  document.querySelectorAll('.d-rail [data-nav]').forEach(link => {
    if (link.dataset.nav === state.screen) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
  const [title, desc] = v.PAGES[state.screen];
  $('p-crumb').textContent = title;
  $('p-title').textContent = title;
  $('p-desc').textContent = desc;
  document.title = `${title} · Provider portal — Dodona`;
  $('d-rail').classList.remove('is-more');
  $('d-nav-more').setAttribute('aria-expanded', 'false');
}

/* ---------- actions ---------- */
// Destructive buttons need a second click within a few seconds; the viewer has no confirm dialogs.
function armed(button, label) {
  const key = `${button.dataset.act || button.dataset.clock}:${button.dataset.ref || ''}`;
  if (state.armed?.key === key && Date.now() - state.armed.at < ARM_MS) { state.armed = null; return true; }
  state.armed = { key, at: Date.now() };
  const text = button.querySelector('span:last-child') || button;
  const before = text.textContent;
  text.textContent = label;
  setTimeout(() => { text.textContent = before; }, ARM_MS);
  return false;
}

async function busy(button, work) {
  if (button.getAttribute('aria-busy') === 'true') return;
  button.setAttribute('aria-busy', 'true');
  try { await work(); }
  catch (error) { toast(error instanceof ApiError ? error.message : 'Something went wrong. Please try again.'); }
  finally { button.removeAttribute('aria-busy'); }
}

async function refreshAll() {
  await loadAccount();
  await loadAll();
}

async function onDecision(button) {
  const { act, ref } = button.dataset;
  if (act === 'decline' && !armed(button, 'Click again to decline')) return;
  await busy(button, async () => {
    await api(`/api/provider/orders/${encodeURIComponent(ref)}/${act}`, { method: 'POST', body: {} });
    toast(act === 'confirm' ? `${ref} confirmed: the capacity is held and Dodona was told.` : `${ref} declined: the capacity is released and the buyer is refunded through escrow (simulated).`);
    await loadAll();
  });
}

async function onApiKey(button) {
  if (!armed(button, 'Click again to replace')) return;
  await busy(button, async () => {
    const data = await api('/api/provider/api-key', { method: 'POST', body: {} });
    const box = $('p-key-once');
    box.innerHTML = `<div class="p-apikey"><span class="eyebrow">New mock key, shown once</span><code>${esc(data.apiKey ?? data.key ?? '')}</code><span class="fine">Copy it now. The old key stopped working. This key is for the demo only and opens nothing.</span></div>`;
    box.hidden = false;
    toast('New mock API key created. It is shown once.');
    const settings = await settled(api('/api/provider/settings'));
    if (settings) { state.settings = v.normalizeSettings(settings); renderIntegration(); }
  });
}

function downloadCsv() {
  const blob = new Blob([v.statementCsv(state.settlements, state.payouts)], { type: 'text/csv' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `dodona-provider-statement-${(state.account.demoNow || '').slice(0, 10) || 'demo'}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  toast('Statement CSV downloaded. Demo data.');
}

async function signOut() {
  await api('/api/auth/sign-out', { method: 'POST', body: {} });
  location.assign('/sign-in');
}

async function onClick(event) {
  const target = event.target.closest('button');
  if (!target) return;
  const act = target.dataset.act;
  if (act === 'confirm' || act === 'decline') return onDecision(target);
  if (act === 'api-key') return onApiKey(target);
  if (act === 'csv') return downloadCsv();
  if (act === 'all-events') { state.showAllEvents = true; return renderIntegration(); }
  if (act === 'refresh') return busy(target, loadAll);
  if (target.id === 'p-gate-signout') return busy(target, signOut);
}

async function saveSettings(patch, message) {
  const data = await api('/api/provider/settings', { method: 'POST', body: patch });
  state.settings = data.neocloud ? v.normalizeSettings(data) : { ...state.settings, ...patch };
  renderOverview(); renderIntegration(); renderSettings();
  toast(message);
}

function validWebhook(value) {
  if (!value) return true;
  if (value.length > URL_MAX) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && Boolean(url.hostname); } catch { return false; }
}

async function onSubmit(event) {
  if (event.target.id !== 'p-hook-form') return;
  event.preventDefault();
  const input = $('p-hook-url');
  const value = input.value.trim();
  if (!validWebhook(value)) {
    $('p-hook-err').textContent = 'Enter a full https:// address, or leave it empty.';
    input.setAttribute('aria-invalid', 'true');
    return;
  }
  $('p-hook-err').textContent = '';
  input.removeAttribute('aria-invalid');
  try { await saveSettings({ webhookUrl: value }, value ? 'Webhook URL saved. Display only: the demo calls nothing.' : 'Webhook URL cleared.'); }
  catch (error) { $('p-hook-err').textContent = error.message; }
}

async function onChange(event) {
  if (event.target.id !== 'p-auto') return;
  const on = event.target.checked;
  try { await saveSettings({ autoConfirm: on }, on ? 'Auto-confirm on.' : 'Auto-confirm off: new requests wait in Orders.'); }
  catch (error) { event.target.checked = !on; toast(error.message); }
}

/* ---------- start ---------- */
function wire() {
  document.addEventListener('submit', onSubmit);
  document.addEventListener('change', onChange);
  $('p-wi-in').addEventListener('input', renderWhatIf);
  window.addEventListener('hashchange', route);
  // Coming back from the buyer's tab shows what their clock did meanwhile.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshAll().catch(() => {}); });
  $('d-nav-more').addEventListener('click', () => {
    const open = $('d-rail').classList.toggle('is-more');
    $('d-nav-more').setAttribute('aria-expanded', String(open));
  });
}

async function start() {
  document.documentElement.classList.remove('no-js');
  document.addEventListener('click', onClick);
  let account = null;
  try { account = await loadAccount(); }
  catch (error) { showGate(null, error.status === 404); document.body.dataset.portal = 'gate'; return; }
  if (v.gateFor(account) !== 'portal') { showGate(account); document.body.dataset.portal = 'gate'; return; }
  $('d-content').hidden = false;
  wire();
  route();
  await loadAll();
  document.body.dataset.portal = 'loaded';
}

start();

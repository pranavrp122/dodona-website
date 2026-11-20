/** Orders list: every order for the signed-in account, newest first, with a status filter. */
import { escapeHtml as esc, icon, windowLabel } from '/dashboard-view.js';
import { api, startPage, toast, money, rate, kindPill, statusPill } from '/platform-shell.js';

const $ = id => document.getElementById(id);
const FILTERS = {
  all: () => true,
  open: o => ['paid', 'reserving', 'reserved', 'delivering'].includes(o.status),
  settled: o => o.status === 'settled',
  pending: o => o.status === 'pending_payment',
};
let orders = [];
let filter = 'all';

function row(o) {
  const href = `/orders/${encodeURIComponent(o.ref)}`;
  const b = o.breakdown || o;
  const paid = o.status === 'pending_payment' || o.status === 'cancelled' ? '<span class="d-muted">not paid</span>' : (b.payNow > 0 ? esc(money(b.payNow)) : '<span class="d-muted">nothing to pay</span>');
  return `<tr data-href="${esc(href)}">
    <td><a class="p-mono" href="${esc(href)}">${esc(o.ref)}</a><span class="d-sub">${esc(o.neocloud?.name || '')}</span></td>
    <td><span class="d-pos-l">${esc(Number(o.count).toLocaleString('en-US'))} × ${esc(o.gpu)}</span><span class="d-sub">${esc(o.region || '')}</span></td>
    <td>${kindPill(o.kind)}</td>
    <td>${esc(windowLabel(o.start, o.end))}</td>
    <td class="r d-num">${esc(rate(o.strike))}</td>
    <td class="r d-num">${paid}</td>
    <td>${statusPill(o.status)}${o.deliveryChoice === 'resell' ? `<span class="d-sub">${o.resoldTo ? 'Resold' : 'Reselling the hours'}</span>` : ''}</td>
    <td><a class="btn btn-sm btn-icon" href="${esc(href)}" aria-label="Open ${esc(o.ref)}">${icon('arrow-right')}</a></td></tr>`;
}

function render() {
  const shown = orders.filter(FILTERS[filter]);
  $('or-count').textContent = String(orders.length);
  $('or-rows').innerHTML = shown.map(row).join('')
    || `<tr><td colspan="8" class="d-muted">${orders.length ? 'No orders with this status.' : 'No orders yet. Take one from the offers board.'}</td></tr>`;
  document.querySelectorAll('#or-tabs [data-filter]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.filter === filter)));
}

async function load() {
  try {
    orders = (await api('/api/orders')).orders || [];
    render();
  } catch (error) {
    $('or-rows').innerHTML = `<tr><td colspan="8" class="d-muted">${esc(error.message)}</td></tr>`;
  }
}

$('or-tabs').addEventListener('click', event => {
  const button = event.target.closest('[data-filter]');
  if (!button) return;
  filter = button.dataset.filter;
  render();
});
// The whole row opens the order; links inside it keep their own behaviour.
$('or-rows').addEventListener('click', event => {
  const tr = event.target.closest('tr[data-href]');
  if (tr && !event.target.closest('a')) location.assign(tr.dataset.href);
});

startPage(load).catch(error => toast(error.message));

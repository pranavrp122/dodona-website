/** Order detail: status timeline, term sheet, delivery choice, resale listing with bids, settlement statement, payouts, emails and the neocloud's view. */
import { escapeHtml as esc, icon, windowLabel, utcStamp } from '/dashboard-view.js';
import {
  api, startPage, toast, money, signedMoney, rate, fmtDate, kindPill, kindName, statusPill, statusName,
  isFloor, isLock, breakEven, emailItems, eventItems, payoutRows,
} from '/platform-shell.js';

const STEPS = [['paid', 'credit-card', 'Paid'], ['reserving', 'clock', 'Reserving'], ['reserved', 'server', 'Reserved'], ['delivering', 'circle-play', 'Delivering'], ['settled', 'flag', 'Settled']];
const BEFORE_WINDOW = ['paid', 'reserving', 'reserved'];
const $ = id => document.getElementById(id);
const ref = decodeURIComponent(location.pathname.split('/').pop() || '');
let detail = null;
let busy = false;

const lineRows = rows => rows.map(([term, value, note, cls, ddCls]) => `<div${cls ? ` class="${cls}"` : ''}><dt>${esc(term)}${note ? `<small>${esc(note)}</small>` : ''}</dt><dd${ddCls ? ` class="${ddCls}"` : ''}>${esc(value)}</dd></div>`).join('');
const tone = v => (v > 0.005 ? 'is-gain' : v < -0.005 ? 'is-loss' : '');

function timeline(order) {
  const at = STEPS.findIndex(([status]) => status === order.status);
  $('od-timeline').innerHTML = STEPS.map(([status, iconName, label], i) => {
    const cls = at < 0 ? '' : i < at || order.status === 'settled' ? 'is-done' : i === at ? 'is-now' : '';
    return `<li class="p-step ${cls}"${i === at ? ' aria-current="step"' : ''}><span class="p-dot">${icon(cls === 'is-done' ? 'check' : iconName)}</span><b>${esc(label)}</b></li>`;
  }).join('');
  $('od-status').innerHTML = statusPill(order.status);
  const exits = {
    pending_payment: `<p class="p-err p-exit">Awaiting payment. The order is held until it is paid.&nbsp;<a href="/checkout?order=${encodeURIComponent(order.ref)}">Pay now</a></p>`,
    cancelled: '<p class="p-err p-exit">Cancelled. Nothing was charged and the capacity hold was released.</p>',
    declined: '<p class="p-err p-exit">The neocloud declined the reservation. The payment is returned through the escrow agent (simulated).</p>',
  };
  $('od-exit').innerHTML = exits[order.status] || '';
  $('od-tl-note').textContent = order.status === 'reserving' ? 'Waiting for the neocloud to confirm the capacity hold.' : `Now: ${statusName(order.status)}.`;
}

function terms(order) {
  const b = order.breakdown || order;
  const lock = isLock(order.kind);
  const be = breakEven(order.kind, order.strike, b.premiumPerGpuHour ?? 0);
  $('od-kind').innerHTML = kindPill(order.kind);
  $('od-terms-note').textContent = order.paidAt || order.createdAt ? `Placed ${fmtDate(order.paidAt || order.createdAt)}` : '';
  $('od-terms').innerHTML = lineRows([
    ['Neocloud', order.neocloud?.name || 'Partner neocloud (simulated)', order.region],
    ['Compute', `${Number(order.count).toLocaleString('en-US')} × ${order.gpu}${order.config ? ` · ${order.config}` : ''}`],
    ['Window', windowLabel(order.start, order.end), `${utcStamp(order.start)} to ${utcStamp(order.end)}`],
    [lock ? 'Fixed price' : isFloor(order.kind) ? 'Floor' : 'Cap', `${rate(order.strike)} per GPU-hour`, lock ? 'Paid on every hour, whatever the index does' : 'Settles on the average daily index over the window'],
    ['GPU-hours', Math.round(b.gpuHours ?? 0).toLocaleString('en-US')],
    ...(lock ? [] : [['Premium', `${rate(b.premiumPerGpuHour)}/GPU-h · ${money(b.premiumTotal)}`], ['of which Dodona platform fee (15%)', money(b.platformFee), '', 'is-sub']]),
    ['Booking fee', money(b.bookingFee)],
    ['Break-even', be.text],
    ...(order.payment ? [['Paid with', `${order.payment.brand} ending ${order.payment.last4}`]] : []),
    ['Paid', ['pending_payment', 'cancelled'].includes(order.status) ? 'Not yet' : money(lock ? b.bookingFee : b.payNow), '', 'is-total'],
  ]);
}

function choice(order) {
  const open = BEFORE_WINDOW.includes(order.status);
  const current = order.deliveryChoice || 'deliver';
  const resold = Boolean(order.resoldTo);
  const options = [
    ['deliver', 'server', 'Use the hours', isFloor(order.kind) ? 'Keep the floor to the end of the window; it pays if the average ends below it.' : 'The neocloud provisions the cluster for the window. You are billed at settlement.'],
    ['resell', 'tag', 'Resell the hours', 'List them on the board before the window starts. The resale buyer takes the compute bill.'],
  ];
  $('od-choice').innerHTML = options.map(([value, iconName, label, note]) => `<button type="button" data-act="choice" data-value="${value}" aria-pressed="${current === value}"${open && !resold ? '' : ' disabled'}><b>${icon(iconName)}${esc(label)}</b><span>${esc(note)}</span></button>`).join('');
  $('od-choice-note').textContent = resold ? 'The hours were resold.' : open ? 'Use the hours yourself, or resell them before the window starts.' : order.status === 'pending_payment' ? 'Available once the order is paid.' : 'Fixed now that the window has started.';
}

function bidRow(bid, order, listingOpen) {
  const live = listingOpen && bid.status !== 'accepted' && bid.status !== 'rejected';
  const acts = live ? `<div class="p-inline"><label class="visually-hidden" for="ct-${esc(bid.id)}">Counter ask for ${esc(bid.bidder)}</label>
      <input id="ct-${esc(bid.id)}" type="number" inputmode="decimal" min="0.01" max="100" step="0.01" value="${esc(Number(order.listing.askPerHour).toFixed(2))}">
      <button type="button" class="btn btn-sm" data-act="counter" data-bid="${esc(bid.id)}">${icon('message-square')}<span>Counter</span></button>
      <button type="button" class="btn btn-sm btn-primary" data-act="accept" data-bid="${esc(bid.id)}">${icon('check')}<span>Accept</span></button></div>` : '';
  return `<tr><th scope="row">${esc(bid.bidder)}<span class="d-sub">${esc(fmtDate(bid.createdAt))}</span></th><td class="r d-num">${esc(rate(bid.pricePerHour))}/GPU-h</td><td>${esc(bid.status || 'open')}</td><td>${acts}</td></tr>`;
}

function listing(order, bids) {
  const box = $('od-list-box');
  box.hidden = order.deliveryChoice !== 'resell' && !order.listing;
  if (box.hidden) return;
  const l = order.listing;
  const canList = BEFORE_WINDOW.includes(order.status) && (!l || l.status === 'withdrawn');
  const form = canList ? `<form class="p-form" id="od-list-form" novalidate><div class="p-row"><div class="field"><label for="od-ask">Asking, $ per GPU-hour</label>
      <input id="od-ask" type="number" inputmode="decimal" min="0.01" max="100" step="0.01" required value="${esc((Number(order.strike) + 0.25).toFixed(2))}"></div></div>
      <div class="c-acts"><button type="submit" class="btn btn-primary">${icon('tag')}<span>List the hours</span></button></div>
      <p class="fine">The mock market bids one simulated day after you list, at the forward for the window minus $0.10, and raises by $0.05 on each counter up to the forward.</p></form>` : '';
  const head = l ? `<div class="c-ctr-b"><p>${l.status === 'open' ? 'Listed' : l.status === 'accepted' ? 'Sold' : 'Withdrawn'} at <b>${esc(rate(l.askPerHour))}/GPU-h</b> · ${esc(fmtDate(l.createdAt))}${order.resoldTo ? ` · resold to ${esc(order.resoldTo.bidder || order.resoldTo)}` : ''}</p>
      ${l.status === 'open' ? `<p class="c-acts c-note"><button type="button" class="btn btn-sm" data-act="withdraw">${icon('x')}<span>Withdraw the listing</span></button></p>` : ''}</div>` : '';
  const rows = (bids || []).map(b => bidRow(b, order, l?.status === 'open')).join('');
  const table = l ? `<div class="d-scroll"><table class="d-table p-bids"><caption class="visually-hidden">Bids on this listing</caption><thead><tr><th scope="col">Bidder</th><th scope="col" class="r">Bid</th><th scope="col">Status</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" class="d-muted">No bids yet. Move the demo clock on a day.</td></tr>'}</tbody></table></div>` : '';
  $('od-listing').innerHTML = head + form + table;
}

function settlement(s, order) {
  $('od-settle-box').hidden = !s;
  if (!s) return;
  const kind = s.kind || order.kind;
  const floor = isFloor(kind);
  const lock = isLock(kind);
  const resold = s.resaleProceeds != null && s.resaleProceeds !== 0;
  const payout = s.payout ?? s.saving;
  $('od-settlement').innerHTML = lineRows([
    ['Window average', `${rate(s.windowAvg)}/GPU-h`, 'Mean of the daily index over the window'],
    [lock ? 'Fixed price' : floor ? 'Floor' : 'Cap', `${rate(s.strike)}/GPU-h · ${kindName(kind)}`],
    ['GPU-hours', Math.round(s.hours).toLocaleString('en-US')],
    ...(floor ? [] : [['Compute bill', resold ? 'Paid by the resale buyer' : money(s.computeBill), lock ? 'Fixed price × hours' : 'Lower of the window average and the cap × hours']]),
    [floor ? 'Floor payout' : lock ? 'Saving against the window average' : 'Saving from the cap', signedMoney(payout), floor ? 'From the matched buyer pool (simulated)' : lock ? 'Negative when the average ends below the fixed price' : 'Never below zero'],
    ...(resold ? [['Resale proceeds', signedMoney(s.resaleProceeds), 'Bid minus the price you would have paid, × hours']] : []),
    ['Fee paid', money(-(s.premiumPaid ?? 0)), lock ? 'No premium on a fixed price' : 'Premium paid at checkout'],
    ['Net result', signedMoney(s.netResult), s.netResult < 0 ? 'Below zero: the protection cost more than it returned this time' : '', 'is-total', tone(s.netResult)],
  ]);
}

function render(data) {
  const { order } = data;
  detail = data;
  document.title = `${order.ref} · Orders · Console — Dodona`;
  $('od-crumb').textContent = order.ref;
  $('od-title').textContent = `${kindName(order.kind)} · ${Number(order.count).toLocaleString('en-US')} ${order.gpu} · ${windowLabel(order.start, order.end)}`;
  $('od-sub').textContent = `${order.ref} · ${order.neocloud?.name || 'Partner neocloud (simulated)'} · ${order.region || ''}`;
  $('od-acts').innerHTML = order.status === 'pending_payment' ? `<a class="btn btn-primary" href="/checkout?order=${encodeURIComponent(order.ref)}">${icon('credit-card')}<span>Pay now</span></a>` : '';
  timeline(order);
  terms(order);
  choice(order);
  listing({ ...order, listing: data.listing ?? order.listing }, data.bids ?? order.bids);
  settlement(data.settlement ?? order.settlement, order);
  const payouts = data.payouts || [];
  $('od-pay-count').textContent = String(payouts.length);
  $('od-payouts').innerHTML = payoutRows(payouts) || '<tr><td colspan="5" class="d-muted">No payouts yet. Premiums split at payment; compute bills are paid a day after settlement.</td></tr>';
  const emails = data.emails || [];
  $('od-mail-count').textContent = String(emails.length);
  $('od-emails').innerHTML = emailItems(emails) || '<li class="d-empty">No emails about this order yet.</li>';
  const events = data.events || [];
  $('od-ev-count').textContent = String(events.length);
  $('od-events').innerHTML = eventItems(events) || '<li class="d-muted">No messages yet.</li>';
  $('od-body').hidden = false;
}

async function load() {
  try {
    render(await api(`/api/orders/${encodeURIComponent(ref)}`));
    $('od-err').textContent = '';
  } catch (error) {
    $('od-err').textContent = error.status === 404 ? `Order ${ref} was not found on this account.` : error.message;
  }
}

async function act(path, body, message) {
  if (busy) return;
  busy = true;
  try {
    await api(`/api/orders/${encodeURIComponent(ref)}/${path}`, { method: 'POST', body });
    toast(message);
    await load();
  } catch (error) {
    toast(error.message);
  } finally { busy = false; }
}

function counterAsk(bidId) {
  const value = Number($(`ct-${bidId}`)?.value);
  return value > 0 && value <= 100 ? value : null;
}

function onClick(event) {
  const button = event.target.closest('button[data-act]');
  if (!button || !detail) return;
  const { act: kind, value, bid } = button.dataset;
  if (kind === 'choice' && value !== (detail.order.deliveryChoice || 'deliver')) act('choice', { choice: value }, value === 'resell' ? 'You will resell the hours. List them below.' : 'You will use the hours.');
  if (kind === 'withdraw') act('withdraw', {}, 'Listing withdrawn.');
  if (kind === 'accept') act('accept-bid', { bidId: bid }, 'Bid accepted. The resale buyer takes the hours and the compute bill.');
  if (kind === 'counter') {
    const ask = counterAsk(bid);
    if (ask == null) { toast('Enter a counter between $0.01 and $100 per GPU-hour.'); return; }
    act('counter', { bidId: bid, askPerHour: ask }, `Counter sent at ${rate(ask)}/GPU-h. The buyer answers when the clock moves on.`);
  }
}

function onSubmit(event) {
  if (event.target.id !== 'od-list-form') return;
  event.preventDefault();
  const ask = Number($('od-ask').value);
  if (!(ask > 0 && ask <= 100)) { toast('Enter an asking price between $0.01 and $100 per GPU-hour.'); return; }
  act('list', { askPerHour: ask }, `Listed at ${rate(ask)}/GPU-h. A bid arrives one simulated day later.`);
}

let wired = false;
startPage(async () => {
  if (!wired) {
    wired = true;
    document.addEventListener('click', onClick);
    document.addEventListener('submit', onSubmit);
  }
  await load();
}).catch(error => toast(error.message));

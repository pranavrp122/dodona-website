/** Dashboard and demo platform: signed-in session, order details for listings and bids, position actions through the API, emails and statements. */
import * as v from '/dashboard-view.js';
import { api, emailItems, money, toast } from '/platform-shell.js';

const esc = v.escapeHtml;
const CHOICE_OPEN = ['paid', 'reserving', 'reserved'];

export const sessionOf = account => ({
  email: account.email, company: account.company, role: account.role, kyb: account.kyb, demoNow: account.demoNow,
});

export async function loadPortfolio() {
  return api('/api/portfolio');
}

/** Choice and listing actions are open from payment until the delivery window starts. */
export const choiceOpen = p => Boolean(p.orderRef) && CHOICE_OPEN.includes(p.orderStatus) && p.phase === 'upcoming';

// Order details (listing and bids) for positions being resold; the rest do not need the extra request.
export async function orderDetails(positions) {
  const wanted = positions.filter(p => p.orderRef && (p.deliveryChoice === 'resell' || p.listing));
  const pairs = await Promise.all(wanted.map(async p => {
    try { return [p.orderRef, await api(`/api/orders/${encodeURIComponent(p.orderRef)}`)]; } catch { return null; }
  }));
  return new Map(pairs.filter(Boolean));
}

/** A position with its open listing and bids folded in, so the ledger and the split panel show them. */
export function withListing(p, detail) {
  const listing = detail?.listing ?? detail?.order?.listing ?? p.listing;
  const bids = (detail?.bids ?? detail?.order?.bids ?? []).filter(b => !b.status || b.status === 'open');
  if (listing?.status !== 'open') return { ...p, bids: [] };
  return { ...p, status: 'listed', askingPerGpuHour: listing.askPerHour, bids, bestBid: bids.at(-1) || null };
}

const post = (ref, path, body) => api(`/api/orders/${encodeURIComponent(ref)}/${path}`, { method: 'POST', body });
export const chooseDelivery = (ref, choice) => post(ref, 'choice', { choice });
export const acceptBid = (ref, bidId) => post(ref, 'accept-bid', { bidId });
export const counterBid = (ref, bidId, askPerHour) => post(ref, 'counter', { bidId, askPerHour });

/** Listing needs the resell choice first; both run in order. */
export async function listHours(p, askPerHour) {
  if (p.deliveryChoice !== 'resell') await chooseDelivery(p.orderRef, 'resell');
  return post(p.orderRef, 'list', { askPerHour });
}

/* ---------- CSV download built in the browser ---------- */
export function saveCsv(lines, name, message) {
  const cell = value => `"${String(value).replace(/"/g, '""')}"`;
  const blob = new Blob([lines.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n'], { type: 'text/csv' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  toast(message);
}

/* ---------- emails ---------- */
export async function renderEmails(list, count) {
  list.innerHTML = '<li class="d-muted p-pad">Loading emails…</li>';
  try {
    const { emails = [] } = await api('/api/emails');
    count.textContent = String(emails.length);
    list.innerHTML = emailItems(emails) || '<li class="d-empty">No emails yet. Your first receipt arrives when you place an order.</li>';
  } catch (error) {
    list.innerHTML = `<li class="d-muted p-pad">${esc(error.message)}</li>`;
  }
}

/* ---------- statements ---------- */
const cell = value => `<td class="r d-num">${esc(money(value))}</td>`;

export async function renderStatements(box) {
  box.innerHTML = '<p class="d-muted p-pad">Loading statements…</p>';
  try {
    const { months = [] } = await api('/api/statements');
    const rows = months.map(m => `<tr><th scope="row">${esc(v.monthLabel(m.month))}</th>${cell(m.premiums)}${cell(m.computeBills)}${cell(m.payoutsIn)}<td class="r d-num"><b class="${v.tone(m.net)}">${esc(money(m.net))}</b></td></tr>`).join('');
    box.innerHTML = `<div class="d-scroll"><table class="d-table"><caption class="visually-hidden">Monthly statement</caption>
      <thead><tr><th scope="col">Month</th><th scope="col" class="r">Premiums</th><th scope="col" class="r">Compute bills</th><th scope="col" class="r">Payouts in</th><th scope="col" class="r">Net</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="d-muted">No activity yet.</td></tr>'}</tbody></table></div>
      <p class="c-note">Net is payouts in less premiums and compute bills. A fixed price has no premium, so it shows up only when its compute bill settles. Every amount moves through the escrow agent.</p>`;
  } catch (error) {
    box.innerHTML = `<p class="d-muted p-pad">${esc(error.message)}</p>`;
  }
}

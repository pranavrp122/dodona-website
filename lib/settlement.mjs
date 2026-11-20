/** Settlement on the window average of the daily index, payouts through the escrow agent (simulated), and account statements. */
import { all, get, insert, update, newId, parseJson } from './db.mjs';
import { ensurePrints, composedSeries } from './prints.mjs';
import { recordEvent } from './neocloud.mjs';
import { sendEmail, sendProviderEmail } from './outbox.mjs';
import { recordServerEvent } from './audit.mjs';
import { roundCents, round4 } from './validate.mjs';

const DAY_MS = 24 * 3600 * 1000;

/** Average of the owner's daily prints over [start day, end day); a window inside one day uses that day's print. */
export function windowAverage(db, order, history) {
  const owner = get(db, 'SELECT * FROM accounts WHERE id = ?', order.account_id);
  const [startDay, endDay] = [order.start.slice(0, 10), order.end.slice(0, 10)];
  ensurePrints(db, owner, history, endDay);
  const series = composedSeries(db, owner, history, order.gpu, endDay);
  let points = series.filter(([d]) => d >= startDay && d < endDay);
  if (!points.length) points = series.filter(([d]) => d <= endDay).slice(-1);
  return points.reduce((total, [, price]) => total + price, 0) / points.length;
}

/**
 * The settlement statement. A cap holder pays the lower of the window average and the cap; a floor holder receives the
 * shortfall below the floor; a lock pays its fixed price whatever happens. Net results can be negative.
 */
export function computeSettlement({ kind, strike, gpu_hours: hours, premium_total: premiumPaid, resold_to_json: resoldJson }, rawAverage, at) {
  // Settle on the average as printed (4 decimals) so every statement reconciles from its own numbers.
  const windowAvg = round4(rawAverage);
  const resold = parseJson(resoldJson);
  const base = { windowAvg, strike, hours, kind, premiumPaid, computedAt: at, computeBill: null, saving: null, payout: null, resaleProceeds: null, billedTo: null };
  if (kind === 'floor') {
    const payout = roundCents(Math.max(strike - windowAvg, 0) * hours);
    return { ...base, payout, netResult: roundCents(payout - premiumPaid) };
  }
  const billRate = kind === 'cap' ? Math.min(windowAvg, strike) : strike;
  const saving = roundCents((kind === 'cap' ? Math.max(windowAvg - strike, 0) : windowAvg - strike) * hours);
  const computeBill = roundCents(billRate * hours);
  if (resold) {
    const resaleProceeds = roundCents((resold.pricePerHour - billRate) * hours);
    return { ...base, computeBill, saving, resaleProceeds, billedTo: 'resale buyer', netResult: roundCents(resaleProceeds - premiumPaid) };
  }
  return { ...base, computeBill, saving, billedTo: 'holder', netResult: roundCents(saving - premiumPaid) };
}

const dayAfter = iso => new Date(Date.parse(iso) + DAY_MS).toISOString();

function schedulePayout(db, order, direction, amount, dueAt, at) {
  if (!(amount > 0)) return;
  insert(db, 'payouts', { id: newId('po'), order_ref: order.ref, account_id: order.account_id, neocloud_id: order.neocloud_id, direction, amount, status: 'scheduled', due_at: dueAt, paid_at: null }, at);
}

/** Window end: close the window, compute the statement, invoice the compute bill and schedule payouts one simulated day later. */
export function settleOrder(db, order, at, history) {
  const settlement = computeSettlement(order, windowAverage(db, order, history), at);
  update(db, 'orders', { ref: order.ref }, { status: 'settled', settlement_json: JSON.stringify(settlement) }, at);
  recordEvent(db, order, 'window.closed', { end: order.end, gpuHours: order.gpu_hours }, at);
  recordEvent(db, order, 'settlement.computed', { settlement }, at);
  const due = dayAfter(at);
  if (settlement.computeBill) {
    recordEvent(db, order, 'invoice.issued', { amount: settlement.computeBill, billedTo: settlement.billedTo, dueAt: due, through: 'the escrow agent' }, at);
    schedulePayout(db, order, 'buyer_to_neocloud', settlement.computeBill, due, at);
  }
  schedulePayout(db, order, 'floor_to_holder', settlement.payout, due, at);
  schedulePayout(db, order, 'resale_to_holder', settlement.resaleProceeds, due, at);
  const settled = { ...order, status: 'settled' };
  sendEmail(db, { accountId: order.account_id, template: 'window_settled', at, orderRef: order.ref, order: settled, settlement });
  sendProviderEmail(db, order.neocloud_id, { template: 'provider_settlement', at, orderRef: order.ref, order: settled, settlement });
  recordServerEvent('settlement', `Settlement · ${order.ref} · ${order.kind} · window average $${settlement.windowAvg.toFixed(2)} · net $${settlement.netResult.toFixed(2)}`, { netResult: settlement.netResult, windowAvg: settlement.windowAvg }, { ref: order.ref });
  return settlement;
}

export const nextPayoutDue = (db, ref) => get(db, "SELECT * FROM payouts WHERE order_ref = ? AND status = 'scheduled' ORDER BY due_at, created_at LIMIT 1", ref);

/** Pays one scheduled payout at its due time and tells both sides. */
export function payPayout(db, order, payout) {
  const at = payout.due_at;
  update(db, 'payouts', { id: payout.id }, { status: 'paid', paid_at: at }, at);
  const paid = { ...payout, status: 'paid', paid_at: at };
  recordEvent(db, order, 'payout.issued', { payoutId: payout.id, direction: payout.direction, amount: payout.amount, through: 'the escrow agent' }, at);
  if (payout.direction === 'buyer_to_neocloud') sendProviderEmail(db, order.neocloud_id, { template: 'provider_payout', at, orderRef: order.ref, order, payout: paid });
  else sendEmail(db, { accountId: order.account_id, template: 'payout_issued', at, orderRef: order.ref, order, payout: paid });
}

function statementRows(db, accountId, untilIso) {
  const rows = [];
  for (const p of all(db, "SELECT p.*, o.kind, o.gpu, o.count, o.premium_total FROM payments p JOIN orders o ON o.ref = p.order_ref WHERE p.account_id = ? AND p.status IN ('succeeded', 'refunded') AND p.at <= ?", accountId, untilIso)) {
    const what = `${p.count} ${p.gpu} ${p.kind}`;
    if (p.premium_total > 0) rows.push({ date: p.at, orderRef: p.order_ref, type: 'premium', description: `Premium · ${what}`, amount: -p.premium_total });
    if (p.status === 'refunded' && p.amount > 0) rows.push({ date: p.updated_at, orderRef: p.order_ref, type: 'refund', description: `Refund through the escrow agent · ${what}`, amount: p.amount });
  }
  const payouts = all(db, "SELECT p.*, o.resold_to_json FROM payouts p JOIN orders o ON o.ref = p.order_ref WHERE o.account_id = ? AND p.status = 'paid' AND p.paid_at <= ? AND p.direction IN ('buyer_to_neocloud', 'floor_to_holder', 'resale_to_holder')", accountId, untilIso);
  for (const p of payouts) {
    if (p.direction === 'buyer_to_neocloud' && p.resold_to_json) continue;
    const [type, description, sign] = { buyer_to_neocloud: ['compute_bill', 'Compute bill', -1], floor_to_holder: ['floor_payout', 'Floor payout', 1], resale_to_holder: ['resale_proceeds', 'Resale proceeds', 1] }[p.direction];
    rows.push({ date: p.paid_at, orderRef: p.order_ref, type, description, amount: sign * p.amount });
  }
  return rows.map(r => ({ ...r, amount: roundCents(r.amount) })).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** GET /api/statements: what moved through the escrow agent (simulated) for this account, by month, up to its demo clock. */
export function statements(db, account) {
  const rows = statementRows(db, account.id, account.demo_now);
  const months = new Map();
  for (const row of rows) {
    const month = row.date.slice(0, 7);
    const m = months.get(month) || { month, premiums: 0, computeBills: 0, payoutsIn: 0, refunds: 0, net: 0 };
    const key = { premium: 'premiums', compute_bill: 'computeBills', floor_payout: 'payoutsIn', resale_proceeds: 'payoutsIn', refund: 'refunds' }[row.type];
    m[key] = roundCents(m[key] + Math.abs(row.amount));
    m.net = roundCents(m.net + row.amount);
    months.set(month, m);
  }
  return { months: [...months.values()], rows };
}

const csvCell = value => {
  const text = String(value ?? '');
  // Spreadsheet formula guard for text cells; plain signed numbers pass through.
  const safe = typeof value === 'string' && /^[=+\-@\t\r]/.test(text) && !/^-?\d+(?:\.\d+)?$/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

export const toCsv = (header, rows) => [header, ...rows].map(row => row.map(csvCell).join(',')).join('\n') + '\n';

export const statementsCsv = data => toCsv(['date', 'orderRef', 'type', 'description', 'amount'], data.rows.map(r => [r.date, r.orderRef, r.type, r.description, r.amount.toFixed(2)]));

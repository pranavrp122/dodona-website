/** The demo clock: advancing runs every due transition for an account's orders (or a provider's neocloud) in time order. */
import { all, get, update, transaction, parseJson, nextSeq } from './db.mjs';
import { autoConfirmAt, confirmReservation, declineReservation, recordEvent } from './neocloud.mjs';
import { sendEmail } from './outbox.mjs';
import { settleOrder, nextPayoutDue, payPayout } from './settlement.mjs';
import { marketBid, withdrawListing } from './listing.mjs';
import { SCENARIOS } from './prints.mjs';
import { conflict, invalid, isoTime, number, oneOf, onlyKeys } from './validate.mjs';

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_AHEAD_MS = 400 * DAY_MS;
const PENDING_TTL_MS = 3 * DAY_MS;
const STEP_LIMIT = 20000;
const FIRED_LIMIT = 200;
const OPEN_STATUSES = Object.freeze(['pending_payment', 'paid', 'reserving', 'reserved', 'delivering', 'settled']);
const iso = ms => new Date(ms).toISOString();

function reservedSteps(order) {
  const steps = [];
  const notified = parseJson(order.notified_json, []);
  const tomorrow = Date.parse(order.start) - DAY_MS;
  if (!notified.includes('tomorrow') && tomorrow > Date.parse(order.paid_at || order.ordered_at)) steps.push({ at: iso(tomorrow), kind: 'tomorrow' });
  if (order.next_bid_at && parseJson(order.listing_json)?.status === 'open') steps.push({ at: order.next_bid_at, kind: 'bid' });
  steps.push({ at: order.start, kind: 'start' });
  return steps;
}

/** The order's next due transition, or null. Earlier steps in each list win ties. */
export function nextStep(db, order) {
  let steps = [];
  if (order.status === 'pending_payment') steps = [{ at: iso(Math.min(Date.parse(order.ordered_at) + PENDING_TTL_MS, Date.parse(order.start))), kind: 'lapse' }];
  if (order.status === 'reserving') steps = [autoConfirmAt(db, order) && { at: autoConfirmAt(db, order), kind: 'confirm' }, { at: order.start, kind: 'unconfirmed' }].filter(Boolean);
  if (order.status === 'paid' || order.status === 'reserved') steps = reservedSteps(order);
  if (order.status === 'delivering') {
    const from = order.usage_until || order.start;
    steps = from < order.end ? [{ at: iso(Math.min(Date.parse(from) + DAY_MS, Date.parse(order.end))), kind: 'usage' }] : [{ at: order.end, kind: 'settle' }];
  }
  if (order.status === 'settled') {
    const payout = nextPayoutDue(db, order.ref);
    if (payout) steps = [{ at: payout.due_at, kind: 'payout', payout }];
  }
  return steps.reduce((best, step) => (!best || step.at < best.at ? step : best), null);
}

function startWindow(db, order, at) {
  if (parseJson(order.listing_json)?.status === 'open') withdrawListing(db, order, at, 'expired');
  update(db, 'orders', { ref: order.ref }, { status: 'delivering', usage_until: order.start }, at);
  const resold = parseJson(order.resold_to_json);
  recordEvent(db, order, 'delivery.started', { gpu: order.gpu, count: order.count, region: order.region, start: order.start, end: order.end, deliverTo: resold ? 'resale buyer' : 'holder' }, at);
  sendEmail(db, { accountId: order.account_id, template: 'window_started', at, orderRef: order.ref, order });
}

function reportUsage(db, order, at) {
  const from = order.usage_until || order.start;
  const gpuHours = order.count * (Date.parse(at) - Date.parse(from)) / HOUR_MS;
  const delivered = order.count * (Date.parse(at) - Date.parse(order.start)) / HOUR_MS;
  update(db, 'orders', { ref: order.ref }, { usage_until: at }, at);
  recordEvent(db, order, 'usage.reported', { periodStart: from, periodEnd: at, gpuHours, deliveredGpuHours: delivered, windowGpuHours: order.gpu_hours }, at);
}

function runStep(db, order, step, history) {
  const { at, kind } = step;
  if (kind === 'lapse') update(db, 'orders', { ref: order.ref }, { status: 'cancelled', status_reason: 'Not paid before the deadline.' }, at);
  if (kind === 'confirm') confirmReservation(db, order, at);
  if (kind === 'unconfirmed') declineReservation(db, order, at, 'The neocloud did not confirm before the window started.');
  if (kind === 'tomorrow') {
    sendEmail(db, { accountId: order.account_id, template: 'window_tomorrow', at, orderRef: order.ref, order });
    update(db, 'orders', { ref: order.ref }, { notified_json: JSON.stringify([...parseJson(order.notified_json, []), 'tomorrow']) }, at);
  }
  if (kind === 'bid') marketBid(db, order, history);
  if (kind === 'start') startWindow(db, order, at);
  if (kind === 'usage') reportUsage(db, order, at);
  if (kind === 'settle') settleOrder(db, order, at, history);
  if (kind === 'payout') payPayout(db, order, step.payout);
}

const scopeOf = account => (account.role === 'provider' && account.neocloud_id ? ['neocloud_id', account.neocloud_id] : ['account_id', account.id]);

function scopeOrders(db, account) {
  const [column, value] = scopeOf(account);
  return all(db, `SELECT * FROM orders WHERE ${column} = ? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')})`, value, ...OPEN_STATUSES);
}

/** Runs every transition due up to `toIso` across the account's scope, earliest first. Returns how many ran. */
export function runUntil(db, account, toIso, history) {
  // Orders move independently, so only the order that just stepped needs its next step recomputed.
  const pending = new Map(scopeOrders(db, account).map(order => [order.ref, nextStep(db, order)]));
  let count = 0;
  for (; count < STEP_LIMIT; count++) {
    let due = null;
    for (const [ref, step] of pending) if (step && step.at <= toIso && (!due || step.at < due.step.at)) due = { ref, step };
    if (!due) break;
    runStep(db, get(db, 'SELECT * FROM orders WHERE ref = ?', due.ref), due.step, history);
    const fresh = get(db, 'SELECT * FROM orders WHERE ref = ?', due.ref);
    pending.set(due.ref, OPEN_STATUSES.includes(fresh.status) ? nextStep(db, fresh) : null);
  }
  // Throwing inside the caller's transaction rolls the whole advance back, demo clock included.
  if (count >= STEP_LIMIT) throw conflict('That is too far to advance in one go. Advance in smaller steps.', 'too_many_steps');
  return count;
}

/** Used by the seed: advance an account's orders to `toIso` without moving its clock backwards. */
export function settleAccount(db, account, toIso, history) {
  transaction(db, () => runUntil(db, account, toIso, history));
}

function targetTime(db, account, body) {
  onlyKeys(body, ['days', 'to', 'until']);
  const given = ['days', 'to', 'until'].filter(key => body[key] !== undefined);
  if (given.length !== 1) throw invalid('Send exactly one of days, to or until.');
  const from = Date.parse(account.demo_now);
  if (body.days !== undefined) return iso(from + number(body.days, 'Days', { min: 0, max: 400 }) * DAY_MS);
  if (body.to !== undefined) return isoTime(body.to, 'To');
  const until = oneOf(body.until, ['next-event', 'settlement'], 'Until');
  const orders = scopeOrders(db, account);
  const times = until === 'next-event'
    ? orders.map(o => nextStep(db, o)?.at).filter(Boolean)
    : orders.filter(o => ['paid', 'reserving', 'reserved', 'delivering'].includes(o.status) && o.end > account.demo_now).map(o => o.end);
  const next = times.sort()[0];
  return next && next > account.demo_now ? next : account.demo_now;
}

const EVENT_TEXT = Object.freeze({
  'reservation.requested': 'Reservation requested from the neocloud', 'reservation.confirmed': 'The neocloud confirmed the reservation',
  'reservation.declined': 'The reservation was declined', 'delivery.started': 'The window started', 'usage.reported': 'Usage reported',
  'window.closed': 'The window closed', 'settlement.computed': 'Settled on the window average', 'invoice.issued': 'Compute bill invoiced',
  'payout.issued': 'Payout paid through the escrow agent (simulated)', 'listing.created': 'Hours listed for resale', 'bid.received': 'New bid from Buyer B (simulated)',
  'resale.completed': 'Hours resold',
});

function firedSince(db, account, eventSeq, emailSeq) {
  const [column, value] = scopeOf(account);
  const events = all(db, `SELECT at, type, order_ref, seq FROM events WHERE seq >= ? AND ${column} = ? ORDER BY seq`, eventSeq, value)
    .map(e => ({ at: e.at, type: e.type, orderRef: e.order_ref, message: `${EVENT_TEXT[e.type] || e.type} · ${e.order_ref}` }));
  const emails = all(db, 'SELECT at, subject, order_ref FROM emails WHERE seq >= ? AND account_id = ? ORDER BY seq', emailSeq, account.id)
    .map(e => ({ at: e.at, type: 'email', orderRef: e.order_ref, message: `Email: ${e.subject}` }));
  return [...events, ...emails].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** POST /api/demo/advance. Returns { demoNow, fired, firedCount } where fired lists the latest 200 events and emails. */
export function advance(db, account, body, { history, nowMs }) {
  const target = targetTime(db, account, body);
  if (target < account.demo_now) throw invalid('The demo clock only moves forward. Use reset to start again.');
  if (Date.parse(target) > nowMs + MAX_AHEAD_MS) throw invalid('The demo clock can run at most 400 days ahead of today.');
  const [eventSeq, emailSeq] = [nextSeq(db, 'events'), nextSeq(db, 'emails')];
  transaction(db, () => {
    runUntil(db, account, target, history);
    update(db, 'accounts', { id: account.id }, { demo_now: target }, iso(nowMs));
  });
  const fired = firedSince(db, account, eventSeq, emailSeq);
  return { demoNow: target, fired: fired.slice(-FIRED_LIMIT), firedCount: fired.length };
}

/** POST /api/demo/scenario: new synthetic prints after the real as-of date (they regenerate on next use). */
export function setScenario(db, account, body, nowMs) {
  onlyKeys(body, ['scenario']);
  const scenario = oneOf(body.scenario, SCENARIOS, 'Scenario');
  transaction(db, () => {
    update(db, 'accounts', { id: account.id }, { scenario }, iso(nowMs));
    db.prepare('DELETE FROM prints WHERE account_id = ?').run(account.id);
  });
  return get(db, 'SELECT * FROM accounts WHERE id = ?', account.id);
}

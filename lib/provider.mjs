/** Provider portal API: the mock neocloud's capacity, incoming reservations, contracts, settlements, payouts and integration settings. */
import { all, get, update, transaction, parseJson } from './db.mjs';
import { capacityOf, confirmReservation, declineReservation, eventView, neocloudView, rotateApiKey } from './neocloud.mjs';
import { orderView, loadOrder, PAID_STATUSES } from './orders.mjs';
import { accountPrices } from './prints.mjs';
import { valueCall, valuePut } from './portfolio.mjs';
import { route, PROVIDER } from './route.mjs';
import { conflict, invalid, onlyKeys, text, roundCents } from './validate.mjs';

const MAX_EVENTS = 500;
const inList = list => list.map(() => '?').join(',');
const sumOf = (rows, pick = r => r.amount) => roundCents(rows.reduce((total, row) => total + pick(row), 0));

const ownNeocloud = (db, account) => get(db, 'SELECT * FROM neoclouds WHERE id = ?', account.neocloud_id);
const neocloudOrders = (db, account, statuses) => all(db, `SELECT * FROM orders WHERE neocloud_id = ? AND status IN (${inList(statuses)}) ORDER BY start`, account.neocloud_id, ...statuses);
const buyerOf = (db, row) => get(db, 'SELECT company FROM accounts WHERE id = ?', row.account_id)?.company ?? null;

function usageSoFar(db, row) {
  return sumOf(all(db, "SELECT payload_json FROM events WHERE order_ref = ? AND type = 'usage.reported'", row.ref), e => parseJson(e.payload_json, {}).gpuHours || 0);
}

function runningAverage(db, row, history) {
  const owner = get(db, 'SELECT * FROM accounts WHERE id = ?', row.account_id);
  const upTo = [owner.demo_now, row.end].sort()[0];
  const points = (accountPrices(db, owner, history, upTo).data[row.gpu] || []).filter(([d]) => d >= row.start.slice(0, 10) && d < row.end.slice(0, 10));
  return points.length ? Math.round(points.reduce((t, [, p]) => t + p, 0) / points.length * 10000) / 10000 : null;
}

function providerOrder(db, row, extra = {}) {
  const { accountId, ...view } = orderView(db, row);
  return { ...view, buyer: buyerOf(db, row), holds: { gpu: row.gpu, region: row.region, count: row.count, start: row.start, end: row.end }, ...extra };
}

function income(db, account, monthPrefix) {
  const payouts = all(db, "SELECT * FROM payouts WHERE status = 'paid' AND (neocloud_id = ? OR account_id = ?) AND paid_at LIKE ?", account.neocloud_id, account.id, `${monthPrefix}%`);
  return {
    premiumsReceived: sumOf(payouts.filter(p => p.direction === 'premium_to_neocloud' && p.neocloud_id === account.neocloud_id)),
    computeBills: sumOf(payouts.filter(p => p.direction === 'buyer_to_neocloud' && p.neocloud_id === account.neocloud_id)),
    floorPayouts: sumOf(payouts.filter(p => p.direction === 'floor_to_holder' && p.account_id === account.id)),
  };
}

export function overview(db, account) {
  const next = all(db, "SELECT * FROM orders WHERE neocloud_id = ? AND status = 'reserved' AND start > ? ORDER BY start LIMIT 5", account.neocloud_id, account.demo_now);
  return {
    demoNow: account.demo_now, neocloud: neocloudView(ownNeocloud(db, account)), capacity: capacityOf(db, account.neocloud_id, account.demo_now),
    income: { thisMonth: income(db, account, account.demo_now.slice(0, 7)), toDate: income(db, account, '') },
    nextDeliveries: next.map(row => providerOrder(db, row)),
    pendingConfirmations: get(db, "SELECT COUNT(*) AS n FROM orders WHERE neocloud_id = ? AND status = 'reserving'", account.neocloud_id).n,
  };
}

export function providerOrders(db, account, history) {
  return {
    incoming: neocloudOrders(db, account, ['reserving']).map(row => providerOrder(db, row)),
    active: neocloudOrders(db, account, ['reserved', 'delivering']).map(row => providerOrder(db, row, row.status === 'delivering' ? { usageGpuHours: usageSoFar(db, row), runningWindowAverage: runningAverage(db, row, history) } : {})),
    settled: neocloudOrders(db, account, ['settled']).map(row => providerOrder(db, row)).reverse(),
    declined: neocloudOrders(db, account, ['declined']).map(row => providerOrder(db, row)).reverse(),
  };
}

// The provider's side: a sold cap loses what the holder gains; a bought floor gains what it pays.
function contractRow(db, row, prices, demoNow, sign) {
  const kind = row.kind === 'floor' ? 'put' : 'call';
  const position = { kind, gpu: row.gpu, count: row.count, start: row.start, end: row.end, region: row.region, config: row.config, pricePerGpuHour: row.strike, premiumPerGpuHour: row.premium_per_gpu_hour };
  const settled = row.status === 'settled';
  const valuation = settled ? null : (kind === 'put' ? valuePut : valueCall)(position, prices.data[row.gpu], { today: demoNow.slice(0, 10), quoteCap: null });
  return {
    ref: row.ref, kind: row.kind, gpu: row.gpu, count: row.count, region: row.region, start: row.start, end: row.end, strike: row.strike,
    premiumPerGpuHour: row.premium_per_gpu_hour, premiumTotal: row.premium_total, status: row.status, buyer: buyerOf(db, row),
    expectedWindowAverage: settled ? parseJson(row.settlement_json)?.windowAvg ?? null : Math.round(valuation.windowAverage.expected * 10000) / 10000,
    value: settled ? null : roundCents(sign * valuation.value), settlement: parseJson(row.settlement_json),
  };
}

export function contracts(db, account, history) {
  const prices = accountPrices(db, account, history);
  const caps = all(db, `SELECT * FROM orders WHERE neocloud_id = ? AND kind = 'cap' AND status IN (${inList(PAID_STATUSES)}) ORDER BY start`, account.neocloud_id, ...PAID_STATUSES);
  const floors = all(db, `SELECT * FROM orders WHERE account_id = ? AND kind = 'floor' AND status IN (${inList(PAID_STATUSES)}) ORDER BY start`, account.id, ...PAID_STATUSES);
  return { demoNow: account.demo_now, capsSold: caps.map(row => contractRow(db, row, prices, account.demo_now, -1)), floorsBought: floors.map(row => contractRow(db, row, prices, account.demo_now, 1)) };
}

export function settlements(db, account) {
  const rows = all(db, "SELECT * FROM orders WHERE status = 'settled' AND (neocloud_id = ? OR (account_id = ? AND kind = 'floor')) ORDER BY end DESC", account.neocloud_id, account.id);
  return rows.map(row => ({ ref: row.ref, kind: row.kind, gpu: row.gpu, count: row.count, start: row.start, end: row.end, buyer: buyerOf(db, row), side: row.account_id === account.id ? 'holder' : 'neocloud', settlement: parseJson(row.settlement_json) }));
}

export const payouts = (db, account) => all(db, 'SELECT * FROM payouts WHERE neocloud_id = ? OR account_id = ? ORDER BY due_at DESC, created_at DESC', account.neocloud_id, account.id)
  .map(row => ({ id: row.id, orderRef: row.order_ref, direction: row.direction, amount: row.amount, status: row.status, dueAt: row.due_at, paidAt: row.paid_at }));

function loadIncoming(db, account, ref) {
  const row = loadOrder(db, account, ref);
  if (row.neocloud_id !== account.neocloud_id) throw conflict('That order is not on your neocloud.', 'not_your_order');
  return row;
}

const actionTime = (account, row) => [account.demo_now, row.reserve_requested_at || row.ordered_at].sort().at(-1);

export function updateSettings(db, account, body, at) {
  onlyKeys(body, ['autoConfirm', 'webhookUrl', 'company']);
  const fields = {};
  if (body.autoConfirm !== undefined) {
    if (typeof body.autoConfirm !== 'boolean') throw invalid('autoConfirm must be true or false.');
    fields.auto_confirm = body.autoConfirm ? 1 : 0;
  }
  if (body.webhookUrl !== undefined) {
    const url = text(body.webhookUrl, 'Webhook URL', { min: 0, max: 300 });
    if (url && !/^https:\/\/[^\s/$.?#][^\s]*$/i.test(url)) throw invalid('Webhook URL must start with https:// (display only; nothing is sent).');
    fields.webhook_url = url;
  }
  transaction(db, () => {
    if (Object.keys(fields).length) update(db, 'neoclouds', { id: account.neocloud_id }, fields, at);
    if (body.company !== undefined) {
      const company = text(body.company, 'Company', { max: 80 });
      update(db, 'accounts', { id: account.id }, { company }, at);
      update(db, 'neoclouds', { id: account.neocloud_id }, { name: company }, at);
    }
  });
}

const settingsView = (db, account) => ({ company: get(db, 'SELECT company FROM accounts WHERE id = ?', account.id).company, neocloud: neocloudView(ownNeocloud(db, account)), capacity: capacityOf(db, account.neocloud_id, account.demo_now) });

export function providerRoutes({ now, prices }) {
  const opts = { roles: PROVIDER };
  return [
    route('GET', '/api/provider/overview', ({ db, account }) => ({ body: overview(db, account) }), opts),
    route('GET', '/api/provider/orders', async ({ db, account }) => ({ body: providerOrders(db, account, await prices()) }), opts),
    route('POST', '/api/provider/orders/:ref/confirm', ({ db, account, params }) => {
      const row = loadIncoming(db, account, params.ref);
      const event = transaction(db, () => confirmReservation(db, row, actionTime(account, row)));
      return { body: { order: orderView(db, get(db, 'SELECT * FROM orders WHERE ref = ?', row.ref)), event } };
    }, opts),
    route('POST', '/api/provider/orders/:ref/decline', ({ db, account, params }) => {
      const row = loadIncoming(db, account, params.ref);
      const event = transaction(db, () => declineReservation(db, row, actionTime(account, row)));
      return { body: { order: orderView(db, get(db, 'SELECT * FROM orders WHERE ref = ?', row.ref)), event } };
    }, opts),
    route('GET', '/api/provider/contracts', async ({ db, account }) => ({ body: contracts(db, account, await prices()) }), opts),
    route('GET', '/api/provider/settlements', ({ db, account }) => ({ body: { settlements: settlements(db, account) } }), opts),
    route('GET', '/api/provider/payouts', ({ db, account }) => ({ body: { payouts: payouts(db, account) } }), opts),
    route('GET', '/api/provider/events', ({ db, account }) => ({ body: { events: all(db, 'SELECT * FROM events WHERE neocloud_id = ? ORDER BY seq DESC LIMIT ?', account.neocloud_id, MAX_EVENTS).map(eventView) } }), opts),
    route('GET', '/api/provider/settings', ({ db, account }) => ({ body: settingsView(db, account) }), opts),
    route('POST', '/api/provider/settings', ({ db, account, body }) => {
      updateSettings(db, account, body, new Date(now()).toISOString());
      return { body: settingsView(db, account) };
    }, { ...opts, body: true }),
    route('POST', '/api/provider/api-key', ({ db, account }) => {
      const apiKey = rotateApiKey(db, account.neocloud_id, new Date(now()).toISOString());
      return { body: { apiKey, last4: apiKey.slice(-4), note: 'Shown once. This mock key is not used by anything.' } };
    }, opts),
  ];
}

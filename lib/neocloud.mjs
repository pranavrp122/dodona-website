/** Mock neocloud: capacity per GPU and region, reservation holds, and a webhook-shaped event log between Dodona and the neocloud. */
import { createHash, randomBytes } from 'node:crypto';
import { insert, update, all, get, newId, nextSeq, parseJson } from './db.mjs';
import { sendEmail, sendProviderEmail } from './outbox.mjs';
import { conflict } from './validate.mjs';

export const HOLDING = Object.freeze(['reserving', 'reserved', 'delivering']);
export const DEFAULT_CAPACITY = Object.freeze([['H100', 'US East', 512], ['H200', 'US East', 128], ['B200', 'US East', 64], ['A100', 'US East', 256]]);
export const EVENT_TYPES = Object.freeze([
  'reservation.requested', 'reservation.confirmed', 'reservation.declined', 'delivery.started', 'usage.reported', 'window.closed',
  'settlement.computed', 'invoice.issued', 'payout.issued', 'listing.created', 'bid.received', 'resale.completed',
]);
const DIRECTION = Object.freeze({
  'reservation.requested': 'dodona_to_neocloud', 'reservation.confirmed': 'neocloud_to_dodona', 'reservation.declined': 'neocloud_to_dodona',
  'delivery.started': 'neocloud_to_dodona', 'usage.reported': 'neocloud_to_dodona', 'window.closed': 'internal',
  'settlement.computed': 'dodona_to_neocloud', 'invoice.issued': 'dodona_to_neocloud', 'payout.issued': 'dodona_to_neocloud',
  'listing.created': 'internal', 'bid.received': 'internal', 'resale.completed': 'dodona_to_neocloud',
});
const HOUR_MS = 3600 * 1000;

/** Creates a neocloud with capacity rows [[gpu, region, total], ...]. */
export function createNeocloud(db, { id = newId('nc'), name, capacity = DEFAULT_CAPACITY, ownerAccountId = null, at }) {
  const regions = [...new Set(capacity.map(([, region]) => region))];
  insert(db, 'neoclouds', { id, name, regions_json: JSON.stringify(regions), auto_confirm: 1, webhook_url: '', owner_account_id: ownerAccountId }, at);
  for (const [gpu, region, total] of capacity) insert(db, 'capacity', { neocloud_id: id, gpu, region, total }, at);
  return id;
}

/** Writes one webhook-shaped event. `at` is the demo time the message would have been sent. */
export function recordEvent(db, order, type, payload, at) {
  const row = {
    id: newId('evt'), order_ref: order?.ref ?? null, account_id: order?.account_id ?? null, neocloud_id: order?.neocloud_id ?? null,
    direction: DIRECTION[type] || 'internal', type, payload_json: JSON.stringify({ orderRef: order?.ref ?? null, ...payload }), http_status: 200, at, seq: nextSeq(db, 'events'),
  };
  insert(db, 'events', row, at);
  return eventView(row);
}

export const eventView = row => ({
  id: row.id, orderRef: row.order_ref, direction: row.direction, type: row.type,
  payload: typeof row.payload_json === 'string' ? parseJson(row.payload_json, {}) : row.payload_json, httpStatus: row.http_status, at: row.at,
});

/**
 * Capacity per (gpu, region). Reserved counts GPUs held by orders whose window overlaps [from, to);
 * with only `from`, every hold that has not ended yet.
 */
export function capacityOf(db, neocloudId, from, to = '9999-12-31T00:00:00.000Z') {
  const rows = all(db, 'SELECT gpu, region, total FROM capacity WHERE neocloud_id = ? ORDER BY gpu, region', neocloudId);
  const held = all(db, `SELECT gpu, region, SUM(count) AS n FROM orders WHERE neocloud_id = ? AND status IN (${HOLDING.map(() => '?').join(',')}) AND end > ? AND start < ? GROUP BY gpu, region`, neocloudId, ...HOLDING, from, to);
  return rows.map(row => {
    const reserved = held.find(h => h.gpu === row.gpu && h.region === row.region)?.n || 0;
    return { gpu: row.gpu, region: row.region, total: row.total, reserved, free: Math.max(row.total - reserved, 0) };
  });
}

/** Finds the neocloud for a custom order: the first with free capacity for that GPU and region. */
export function pickNeocloud(db, { gpu, region, count, start, end }) {
  const candidates = all(db, 'SELECT DISTINCT neocloud_id AS id FROM capacity WHERE gpu = ? AND region = ? ORDER BY neocloud_id', gpu, region);
  const found = candidates.find(c => freeFor(db, c.id, { gpu, region, start, end }) >= count);
  if (!found) throw conflict(`No neocloud has ${count} free ${gpu} in ${region} for that window.`, 'no_capacity');
  return found.id;
}

/** Free GPUs of one type and region across a whole window. */
export const freeFor = (db, neocloudId, { gpu, region, start, end }) =>
  capacityOf(db, neocloudId, start, end).find(r => r.gpu === gpu && r.region === region)?.free ?? 0;

const holdPayload = order => ({ gpu: order.gpu, config: order.config, region: order.region, count: order.count, start: order.start, end: order.end, kind: order.kind, strike: order.strike });

/** Payment cleared: hold capacity and ask the neocloud to confirm. */
export function requestReservation(db, order, at) {
  update(db, 'orders', { ref: order.ref }, { status: 'reserving', reserve_requested_at: at }, at);
  const event = recordEvent(db, order, 'reservation.requested', holdPayload(order), at);
  sendProviderEmail(db, order.neocloud_id, { template: 'provider_reservation_request', at, orderRef: order.ref, order });
  return event;
}

export function confirmReservation(db, order, at) {
  if (order.status !== 'reserving') throw conflict(`Order ${order.ref} is ${order.status}, not waiting for confirmation.`, 'bad_status');
  update(db, 'orders', { ref: order.ref }, { status: 'reserved' }, at);
  const event = recordEvent(db, order, 'reservation.confirmed', { ...holdPayload(order), holdId: `hold_${order.ref}` }, at);
  sendEmail(db, { accountId: order.account_id, template: 'reservation_confirmed', at, orderRef: order.ref, order });
  return event;
}

export function declineReservation(db, order, at, reason = 'The neocloud declined the reservation.') {
  if (order.status !== 'reserving') throw conflict(`Order ${order.ref} is ${order.status}, not waiting for confirmation.`, 'bad_status');
  update(db, 'orders', { ref: order.ref }, { status: 'declined', status_reason: reason }, at);
  db.prepare("UPDATE payments SET status = 'refunded', updated_at = ? WHERE order_ref = ? AND status = 'succeeded'").run(at, order.ref);
  const event = recordEvent(db, order, 'reservation.declined', { reason }, at);
  sendEmail(db, { accountId: order.account_id, template: 'reservation_declined', at, orderRef: order.ref, order });
  return event;
}

/** Auto-confirm fires once the clock has moved at least an hour past the request. */
export function autoConfirmAt(db, order) {
  if (order.status !== 'reserving' || !order.reserve_requested_at) return null;
  const on = get(db, 'SELECT auto_confirm FROM neoclouds WHERE id = ?', order.neocloud_id)?.auto_confirm;
  return on ? new Date(Date.parse(order.reserve_requested_at) + HOUR_MS).toISOString() : null;
}

/** A mock API key, shown once; only its hash and last four characters are kept. */
export function rotateApiKey(db, neocloudId, at) {
  const key = `dk_demo_${randomBytes(24).toString('hex')}`;
  update(db, 'neoclouds', { id: neocloudId }, { api_key_hash: createHash('sha256').update(key).digest('hex'), api_key_last4: key.slice(-4) }, at);
  return key;
}

export function neocloudView(row) {
  return row ? { id: row.id, name: row.name, regions: parseJson(row.regions_json, []), autoConfirm: Boolean(row.auto_confirm), webhookUrl: row.webhook_url, apiKeyLast4: row.api_key_last4 || null } : null;
}

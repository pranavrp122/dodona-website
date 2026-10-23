/** Demo orders: offers on the board, order creation from an offer or a custom quote, and the views the consoles read. */
import { all, get, insert, newRef, parseJson } from './db.mjs';
import { quoteFromHistory, PLATFORM_FEE_SHARE, BOOKING_FEE } from './pricing.mjs';
import { freeFor, pickNeocloud } from './neocloud.mjs';
import { accountPrices } from './prints.mjs';
import * as v from './validate.mjs';
import { windowLabel } from '../dashboard-view.js';

export const KINDS = Object.freeze(['cap', 'floor', 'lock']);
export const QUOTE_TYPE = Object.freeze({ cap: 'call', floor: 'put', lock: 'lock' });
export const STATUSES = Object.freeze(['pending_payment', 'paid', 'reserving', 'reserved', 'delivering', 'settled', 'cancelled', 'declined']);
export const PAID_STATUSES = Object.freeze(['paid', 'reserving', 'reserved', 'delivering', 'settled']);
const HOUR_MS = 3600 * 1000;
const MIN_LEAD_MS = 48 * HOUR_MS;
const MAX_PENDING = 50;
const MAX_PAID = 200;
const REGIONS = ['US East', 'US West', 'Europe'];
const CONFIGS = ['SXM-IB', 'PCIe'];

const neocloudName = (db, id) => get(db, 'SELECT name FROM neoclouds WHERE id = ?', id)?.name ?? null;
const soldOn = (db, offerId) => get(db, `SELECT COALESCE(SUM(count), 0) AS n FROM orders WHERE offer_id = ? AND status IN (${PAID_STATUSES.map(() => '?').join(',')})`, offerId, ...PAID_STATUSES).n;

/** GPUs still available on an offer: its own limit less what is sold, capped by the neocloud's free capacity over the window. */
export const availableOn = (db, row) => Math.max(0, Math.min(row.max_gpus - soldOn(db, row.id), freeFor(db, row.neocloud_id, row)));

export function offerView(db, row) {
  return {
    id: row.id, neocloud: { id: row.neocloud_id, name: neocloudName(db, row.neocloud_id) }, gpu: row.gpu, config: row.config, region: row.region,
    kind: row.kind, start: row.start, end: row.end, strike: row.strike, premiumPerGpuHour: row.premium_per_gpu_hour,
    breakEven: row.kind === 'cap' ? v.roundCents(row.strike + row.premium_per_gpu_hour) : row.kind === 'floor' ? v.roundCents(row.strike - row.premium_per_gpu_hour) : null,
    minGpus: row.min_gpus, maxGpus: row.max_gpus, availableGpus: availableOn(db, row), note: row.note,
  };
}

/** Offers still open at the viewer's clock (start at least 48 hours ahead), filtered by gpu, region and kind. */
export function listOffers(db, { gpu, region, kind } = {}, viewerNowIso) {
  const earliest = new Date(Date.parse(viewerNowIso) + MIN_LEAD_MS).toISOString();
  return all(db, 'SELECT * FROM offers WHERE start >= ? ORDER BY start, gpu, id', earliest)
    .filter(row => (!gpu || row.gpu === gpu) && (!region || row.region === region) && (!kind || row.kind === kind))
    .map(row => offerView(db, row));
}

export function breakdown({ kind, premiumPerGpuHour, strike, gpuHours }) {
  const premiumTotal = v.roundCents(premiumPerGpuHour * gpuHours);
  return {
    premiumPerGpuHour, premiumTotal, platformFee: v.roundCents(premiumTotal * PLATFORM_FEE_SHARE), bookingFee: BOOKING_FEE,
    payNow: v.roundCents(premiumTotal + BOOKING_FEE), computeCostIfUsed: v.roundCents(strike * gpuHours),
    breakEven: kind === 'cap' ? v.roundCents(strike + premiumPerGpuHour) : kind === 'floor' ? v.roundCents(strike - premiumPerGpuHour) : null, gpuHours,
  };
}

function fromOffer(db, account, { offerId, count }) {
  const offer = typeof offerId === 'string' ? get(db, 'SELECT * FROM offers WHERE id = ?', offerId) : null;
  if (!offer) throw v.notFound('That offer does not exist.');
  if (Date.parse(offer.start) < Date.parse(account.demo_now) + MIN_LEAD_MS) throw v.conflict('That offer has closed: its window starts within 48 hours.', 'offer_closed');
  v.number(count, 'GPU count', { min: offer.min_gpus, max: offer.max_gpus, integer: true });
  if (count > availableOn(db, offer)) throw v.conflict(`Only ${availableOn(db, offer)} GPUs are left on this offer.`, 'no_capacity');
  const gpuHours = count * (Date.parse(offer.end) - Date.parse(offer.start)) / HOUR_MS;
  return { offer_id: offer.id, neocloud_id: offer.neocloud_id, gpu: offer.gpu, config: offer.config, region: offer.region, kind: offer.kind, count,
    start: offer.start, end: offer.end, strike: offer.strike, ...breakdown({ kind: offer.kind, premiumPerGpuHour: offer.premium_per_gpu_hour, strike: offer.strike, gpuHours }) };
}

function fromCustom(db, account, custom, history) {
  if (!custom || typeof custom !== 'object' || Array.isArray(custom)) throw v.invalid('custom must be an object.');
  v.onlyKeys(custom, ['gpu', 'count', 'start', 'end', 'kind', 'strike', 'region', 'config']);
  const kind = v.oneOf(custom.kind, KINDS, 'Kind');
  const region = custom.region == null ? 'US East' : v.oneOf(custom.region, REGIONS, 'Region');
  const config = custom.config == null ? 'SXM-IB' : v.oneOf(custom.config, CONFIGS, 'Config');
  let quote;
  try {
    quote = quoteFromHistory({ gpu: custom.gpu, count: custom.count, start: custom.start, end: custom.end, type: QUOTE_TYPE[kind], strike: kind === 'lock' ? undefined : custom.strike, region, config },
      accountPrices(db, account, history), { now: account.demo_now });
  } catch (error) {
    if (error instanceof RangeError) throw v.invalid(error.message);
    throw error;
  }
  const { gpu, count, start, end } = quote.inputs;
  const neocloudId = pickNeocloud(db, { gpu, region, count, start, end });
  return { offer_id: null, neocloud_id: neocloudId, gpu, config, region, kind, count, start, end, strike: quote.strike,
    ...breakdown({ kind, premiumPerGpuHour: quote.premiumPerGpuHour, strike: quote.strike, gpuHours: quote.gpuHours }) };
}

/** POST /api/orders: a pending_payment order priced from an offer or a custom quote at the account's demo clock. */
export function createOrder(db, account, body, history) {
  v.onlyKeys(body, ['offerId', 'count', 'custom']);
  const pending = get(db, "SELECT COUNT(*) AS n FROM orders WHERE account_id = ? AND status = 'pending_payment'", account.id).n;
  if (pending >= MAX_PENDING) throw v.conflict('Too many unpaid orders. Pay or let some lapse first.', 'too_many_pending');
  const paid = get(db, `SELECT COUNT(*) AS n FROM orders WHERE account_id = ? AND status IN (${PAID_STATUSES.map(() => '?').join(',')})`, account.id, ...PAID_STATUSES).n;
  if (paid >= MAX_PAID) throw v.conflict(`A demo account holds at most ${MAX_PAID} orders. Reset the demo to start again.`, 'too_many_orders');
  const terms = body.custom !== undefined ? fromCustom(db, account, body.custom, history) : fromOffer(db, account, body);
  const at = account.demo_now;
  const ref = newRef();
  insert(db, 'orders', {
    ref, account_id: account.id, offer_id: terms.offer_id, neocloud_id: terms.neocloud_id, gpu: terms.gpu, config: terms.config, region: terms.region,
    kind: terms.kind, count: terms.count, start: terms.start, end: terms.end, strike: terms.strike, premium_per_gpu_hour: terms.premiumPerGpuHour,
    premium_total: terms.premiumTotal, platform_fee: terms.platformFee, booking_fee: terms.bookingFee, pay_now: terms.payNow, gpu_hours: terms.gpuHours,
    compute_cost_if_used: terms.computeCostIfUsed, break_even: terms.breakEven, status: 'pending_payment', ordered_at: at,
  }, at);
  return get(db, 'SELECT * FROM orders WHERE ref = ?', ref);
}

/** The order as the consoles see it. The breakdown sits both nested and flat for convenience. */
export function orderView(db, row) {
  const payment = get(db, "SELECT brand, last4 FROM payments WHERE order_ref = ? AND status IN ('succeeded', 'refunded') ORDER BY at DESC LIMIT 1", row.ref);
  const terms = {
    premiumPerGpuHour: row.premium_per_gpu_hour, premiumTotal: row.premium_total, platformFee: row.platform_fee, bookingFee: row.booking_fee,
    payNow: row.pay_now, computeCostIfUsed: row.compute_cost_if_used, breakEven: row.break_even, gpuHours: row.gpu_hours,
  };
  return {
    ref: row.ref, accountId: row.account_id, offerId: row.offer_id, neocloud: { id: row.neocloud_id, name: neocloudName(db, row.neocloud_id) },
    gpu: row.gpu, config: row.config, region: row.region, kind: row.kind, count: row.count, start: row.start, end: row.end, strike: row.strike,
    status: row.status, statusReason: row.status_reason, deliveryChoice: row.delivery_choice,
    listing: parseJson(row.listing_json), resoldTo: parseJson(row.resold_to_json), settlement: parseJson(row.settlement_json),
    ...terms, breakdown: terms, payment: payment ? { brand: payment.brand, last4: payment.last4 } : null,
    paidAt: row.paid_at, orderedAt: row.ordered_at, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export const listOrders = (db, accountId) => all(db, 'SELECT * FROM orders WHERE account_id = ? ORDER BY ordered_at DESC, created_at DESC', accountId).map(row => orderView(db, row));

/** Loads an order the account may see: its own, or any order on a provider's neocloud, or anything for an admin. */
export function loadOrder(db, account, ref) {
  const row = typeof ref === 'string' && /^[A-Z0-9-]{3,40}$/.test(ref) ? get(db, 'SELECT * FROM orders WHERE ref = ?', ref) : null;
  const visible = row && (row.account_id === account.id || account.role === 'admin' || (account.role === 'provider' && row.neocloud_id === account.neocloud_id));
  if (!visible) throw v.notFound('No order with that reference on this account.');
  return row;
}

export function loadOwnOrder(db, account, ref) {
  const row = loadOrder(db, account, ref);
  if (row.account_id !== account.id) throw v.forbidden('Only the account that placed this order can change it.');
  return row;
}

const POSITION_KIND = Object.freeze({ cap: 'call', floor: 'put', lock: 'lock' });
const KIND_WORD = Object.freeze({ call: 'price cap', put: 'price floor', lock: 'fixed price', offtake: 'offtake' });
const TERM_TYPE = Object.freeze({ call: 'call', put: 'put', lock: 'take-or-pay', offtake: 'take-or-pay' });

/** A paid order as a dashboard position (kind call, put or lock; the seeded offtakes keep their own kind). */
export function orderPosition(db, row) {
  const meta = parseJson(row.meta_json, {});
  const kind = meta.positionKind || POSITION_KIND[row.kind];
  const listing = parseJson(row.listing_json);
  return {
    id: meta.positionId || row.ref, orderRef: row.ref, kind, source: 'order',
    label: meta.label || `${row.count} ${row.gpu} · ${KIND_WORD[kind]} · ${windowLabel(row.start, row.end)}`,
    gpu: row.gpu, count: row.count, pricePerGpuHour: row.strike, start: row.start, end: row.end, region: row.region, config: row.config,
    provider: meta.provider || { label: `${neocloudName(db, row.neocloud_id)} · reserved capacity (simulated)`, creditTier: 'Delivery-backed', bondPriceCents: 100 },
    termType: meta.termType || TERM_TYPE[kind], status: listing?.status === 'open' ? 'listed' : meta.status || 'held',
    ...(meta.askingCents != null ? { askingCents: meta.askingCents, bestOfferCents: meta.bestOfferCents } : {}),
    premiumPerGpuHour: row.premium_per_gpu_hour, boughtOn: (row.paid_at || row.ordered_at).slice(0, 10),
    indexAtPurchase: meta.indexAtPurchase ?? null, utilisation: meta.utilisation ?? (kind === 'call' ? 1 : null),
    note: meta.note || 'Demo order on the Dodona demo platform.',
    orderStatus: row.status, deliveryChoice: row.delivery_choice, listing, settlement: parseJson(row.settlement_json),
  };
}

export const orderPositions = (db, accountId) =>
  all(db, `SELECT * FROM orders WHERE account_id = ? AND status IN (${PAID_STATUSES.map(() => '?').join(',')}) ORDER BY rowid`, accountId, ...PAID_STATUSES)
    .map(row => orderPosition(db, row));

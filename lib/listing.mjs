/** Delivery choice and resale: list unused hours before the window, the mock market's bids, counters and acceptance. */
import { all, get, insert, update, newId, parseJson } from './db.mjs';
import { marketStats, forwardPrice } from './valuation.mjs';
import { accountPrices } from './prints.mjs';
import { recordEvent } from './neocloud.mjs';
import { sendEmail } from './outbox.mjs';
import { conflict, invalid, number, oneOf, roundCents } from './validate.mjs';

export const BIDDER = 'Buyer B (simulated)';
const DAY_MS = 24 * 3600 * 1000;
const YEAR_MS = 365 * DAY_MS;
const BID_SPREAD = 0.1;
const COUNTER_STEP = 0.05;
const BEFORE_WINDOW = Object.freeze(['paid', 'reserving', 'reserved']);

/** The market's forward for the order's window as the owner's prints stand at `at`. */
export function windowForward(db, order, history, at) {
  const owner = get(db, 'SELECT * FROM accounts WHERE id = ?', order.account_id);
  const stats = marketStats(accountPrices(db, owner, history, at).data[order.gpu]);
  const tMid = Math.max((Date.parse(order.start) + Date.parse(order.end)) / 2 - Date.parse(at), 0) / YEAR_MS;
  return forwardPrice(stats.spot, stats.drift, tMid);
}

function beforeWindow(order, at, action) {
  if (order.kind === 'floor') throw conflict('A floor has no hours to use or resell; it settles on the window average.', 'not_resellable');
  if (!BEFORE_WINDOW.includes(order.status) || Date.parse(order.start) <= Date.parse(at)) throw conflict(`You can ${action} only before the window starts.`, 'window_started');
  if (parseJson(order.listing_json)?.status === 'accepted') throw conflict('These hours are already resold.', 'already_resold');
}

const openBids = (db, ref) => all(db, "SELECT * FROM bids WHERE order_ref = ? AND status = 'open'", ref);
const closeBids = (db, ref, status, at) => db.prepare("UPDATE bids SET status = ?, updated_at = ? WHERE order_ref = ? AND status = 'open'").run(status, at, ref);

export function withdrawListing(db, order, at, reason = 'withdrawn') {
  const listing = parseJson(order.listing_json);
  if (listing?.status !== 'open') throw conflict('There is no open listing on this order.', 'no_listing');
  closeBids(db, order.ref, reason === 'withdrawn' ? 'withdrawn' : 'expired', at);
  update(db, 'orders', { ref: order.ref }, { listing_json: JSON.stringify({ ...listing, status: 'withdrawn' }), next_bid_at: null, delivery_choice: 'deliver' }, at);
}

/** POST /api/orders/:ref/choice { choice: 'deliver' | 'resell' }. Choosing deliver withdraws an open listing. */
export function setChoice(db, order, body, at) {
  const choice = oneOf(body.choice, ['deliver', 'resell'], 'Choice');
  beforeWindow(order, at, 'change how the hours are used');
  if (choice === 'deliver' && parseJson(order.listing_json)?.status === 'open') withdrawListing(db, order, at);
  update(db, 'orders', { ref: order.ref }, { delivery_choice: choice }, at);
}

/** POST /api/orders/:ref/list { askPerHour }: the mock market bids one simulated day later. */
export function createListing(db, order, body, at) {
  const askPerHour = roundCents(number(body.askPerHour, 'Ask per GPU-hour', { min: 0.01, max: 1000 }));
  beforeWindow(order, at, 'list hours');
  if (parseJson(order.listing_json)?.status === 'open') throw conflict('These hours are already listed. Withdraw first to change the ask.', 'already_listed');
  const listing = { askPerHour, status: 'open', createdAt: at };
  update(db, 'orders', { ref: order.ref }, { listing_json: JSON.stringify(listing), delivery_choice: 'resell', next_bid_at: new Date(Date.parse(at) + DAY_MS).toISOString() }, at);
  recordEvent(db, order, 'listing.created', { askPerHour, gpuHours: order.gpu_hours }, at);
  return listing;
}

function postBid(db, order, pricePerHour, at) {
  const bid = { id: newId('bid'), order_ref: order.ref, bidder: BIDDER, price_per_hour: roundCents(Math.max(pricePerHour, 0.01)), status: 'open', at };
  insert(db, 'bids', bid, at);
  recordEvent(db, order, 'bid.received', { bidId: bid.id, bidder: BIDDER, pricePerHour: bid.price_per_hour }, at);
  sendEmail(db, { accountId: order.account_id, template: 'bid_received', at, orderRef: order.ref, order, bid });
  return bid;
}

/** The scheduled first bid: the forward for the window minus $0.10. */
export function marketBid(db, order, history) {
  const at = order.next_bid_at;
  update(db, 'orders', { ref: order.ref }, { next_bid_at: null }, at);
  return postBid(db, order, windowForward(db, order, history, at) - BID_SPREAD, at);
}

function loadOpenBid(db, order, bidId) {
  if (parseJson(order.listing_json)?.status !== 'open') throw conflict('There is no open listing on this order.', 'no_listing');
  const bid = typeof bidId === 'string' ? get(db, 'SELECT * FROM bids WHERE id = ? AND order_ref = ?', bidId, order.ref) : null;
  if (!bid) throw invalid('No bid with that id on this order.', 'no_bid');
  if (bid.status !== 'open') throw conflict(`That bid is ${bid.status}.`, 'bid_closed');
  return bid;
}

/** POST /api/orders/:ref/counter { bidId, askPerHour }: the market raises its bid by $0.05, never above the forward. */
export function counterBid(db, order, body, at, history) {
  const askPerHour = roundCents(number(body.askPerHour, 'Ask per GPU-hour', { min: 0.01, max: 1000 }));
  beforeWindow(order, at, 'counter');
  const bid = loadOpenBid(db, order, body.bidId);
  update(db, 'bids', { id: bid.id }, { status: 'countered' }, at);
  const listing = { ...parseJson(order.listing_json), askPerHour };
  update(db, 'orders', { ref: order.ref }, { listing_json: JSON.stringify(listing) }, at);
  const raised = Math.min(bid.price_per_hour + COUNTER_STEP, windowForward(db, order, history, at), askPerHour);
  return postBid(db, order, Math.max(raised, bid.price_per_hour), at);
}

/** POST /api/orders/:ref/accept-bid { bidId }: the hours go to Buyer B (simulated) and the neocloud is told. */
export function acceptBid(db, order, body, at) {
  beforeWindow(order, at, 'accept a bid');
  const bid = loadOpenBid(db, order, body.bidId);
  update(db, 'bids', { id: bid.id }, { status: 'accepted' }, at);
  closeBids(db, order.ref, 'declined', at);
  const resoldTo = { bidder: bid.bidder, pricePerHour: bid.price_per_hour, at };
  update(db, 'orders', { ref: order.ref }, {
    listing_json: JSON.stringify({ ...parseJson(order.listing_json), status: 'accepted' }), resold_to_json: JSON.stringify(resoldTo), delivery_choice: 'resell', next_bid_at: null,
  }, at);
  recordEvent(db, order, 'resale.completed', { bidder: bid.bidder, pricePerHour: bid.price_per_hour, gpuHours: order.gpu_hours, deliverTo: 'resale buyer' }, at);
  return resoldTo;
}

export const hasOpenBid = (db, ref) => openBids(db, ref).length > 0;

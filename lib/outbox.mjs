/** Mock email outbox: plain-text messages stored per account at the demo time they would have been sent. Nothing is ever delivered. */
import { insert, get, newId, nextSeq } from './db.mjs';

const usd = value => `${value < 0 ? '-' : ''}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = iso => iso.slice(0, 10);
const describe = order => `${order.count} ${order.gpu} ${{ cap: 'price cap', floor: 'price floor', lock: 'fixed price' }[order.kind]} at $${order.strike.toFixed(2)}/GPU-h, ${day(order.start)} to ${day(order.end)} (${order.region})`;
const SIGN_OFF = '\n\nPayments and payouts run through the escrow agent. Dodona never holds funds.';

function settlementLines(s) {
  const lines = [`Window average of the daily index: $${s.windowAvg.toFixed(4)}/GPU-h`, `Strike: $${s.strike.toFixed(2)}/GPU-h over ${s.hours.toLocaleString('en-US')} GPU-hours`];
  if (s.computeBill != null) lines.push(`Compute bill: ${usd(s.computeBill)}`);
  if (s.saving != null) lines.push(`Saving against the index: ${usd(s.saving)}`);
  if (s.payout != null) lines.push(`Floor payout: ${usd(s.payout)}`);
  if (s.resaleProceeds != null) lines.push(`Resale proceeds: ${usd(s.resaleProceeds)}`);
  lines.push(`Premium paid: ${usd(s.premiumPaid)}`, `Net result: ${usd(s.netResult)}`);
  return lines.join('\n');
}

// Each template returns [subject, body] from the order (and extra context where needed).
export const TEMPLATES = Object.freeze({
  welcome: ({ account }) => ['Welcome to Dodona', `Hello ${account.company},\n\nYour ${account.role} account is ready. Sign in any time with this email.`],
  receipt: ({ order }) => [`Receipt for ${order.ref}`, order.pay_now > 0
    ? `We received your payment of ${usd(order.pay_now)} for ${describe(order)}.\nPremium ${usd(order.premium_total)} (platform share ${usd(order.platform_fee)} inside it).\nWe have asked the neocloud to reserve the capacity.`
    : `We confirmed your order for ${describe(order)}.\nNothing was charged now. A fixed price has no premium, and the compute bill comes at settlement.\nWe have asked the neocloud to reserve the capacity.`],
  reservation_confirmed: ({ order }) => [`Capacity reserved for ${order.ref}`, `The neocloud confirmed the reservation for ${describe(order)}.`],
  reservation_declined: ({ order }) => [`Reservation declined for ${order.ref}`, `The neocloud could not reserve ${describe(order)}. ${order.pay_now > 0 ? `The payment of ${usd(order.pay_now)} is returned through the escrow agent.` : 'Nothing was charged, so there is nothing to return.'}`],
  window_tomorrow: ({ order }) => [`Your window for ${order.ref} starts tomorrow`, `${describe(order)} starts ${order.start.slice(0, 16).replace('T', ' ')} UTC.`],
  window_started: ({ order }) => [`Your window for ${order.ref} has started`, `${describe(order)} is now delivering. Usage is reported daily.`],
  window_settled: ({ order, settlement }) => [`Statement for ${order.ref}`, `The window for ${describe(order)} has closed and settled on the window average.\n\n${settlementLines(settlement)}`],
  payout_issued: ({ order, payout }) => [`Payout issued on ${order.ref}`, `${usd(payout.amount)} (${payout.direction.replaceAll('_', ' ')}) was paid through the escrow agent.`],
  bid_received: ({ order, bid }) => [`New bid on ${order.ref}`, `${bid.bidder} bid $${bid.price_per_hour.toFixed(2)}/GPU-h for your listed hours on ${describe(order)}.`],
  provider_reservation_request: ({ order }) => [`New reservation request ${order.ref}`, `Dodona asks you to hold ${describe(order)}.`],
  provider_settlement: ({ order, settlement }) => [`Settlement for ${order.ref}`, `The window for ${describe(order)} settled.\n\n${settlementLines(settlement)}`],
  provider_payout: ({ order, payout }) => [`Payout on ${order.ref}`, `${usd(payout.amount)} (${payout.direction.replaceAll('_', ' ')}) was paid through the escrow agent.`],
});

/** Stores one email for an account. Returns the row. */
export function sendEmail(db, { accountId, template, at, orderRef = null, ...context }) {
  const account = get(db, 'SELECT id, email, company, role FROM accounts WHERE id = ?', accountId);
  if (!account) return null;
  const [subject, body] = TEMPLATES[template]({ account, ...context });
  return insert(db, 'emails', { id: newId('em'), account_id: account.id, to_addr: account.email, subject, body: body + SIGN_OFF, order_ref: orderRef, at, seq: nextSeq(db, 'emails') }, at);
}

/** Emails the neocloud's portal owner, when the neocloud has one (Helix Cloud has no login). */
export function sendProviderEmail(db, neocloudId, { template, at, orderRef, ...context }) {
  const owner = get(db, 'SELECT owner_account_id AS id FROM neoclouds WHERE id = ?', neocloudId)?.id;
  return owner ? sendEmail(db, { accountId: owner, template, at, orderRef, ...context }) : null;
}

export const emailView = row => ({ id: row.id, accountId: row.account_id, to: row.to_addr, subject: row.subject, body: row.body, orderRef: row.order_ref, at: row.at });

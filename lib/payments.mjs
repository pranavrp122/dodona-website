/** Mock card processor and the paid-order bookkeeping. Only the brand and last four digits are ever kept; never the number or CVC. */
import { insert, update, get, newId, transaction } from './db.mjs';
import { requestReservation } from './neocloud.mjs';
import { sendEmail } from './outbox.mjs';
import { PLATFORM_FEE_SHARE } from './pricing.mjs';
import { recordServerEvent } from './audit.mjs';
import { PlatformError, conflict, invalid, roundCents } from './validate.mjs';

export const TEST_CARDS = Object.freeze({ success: '4242424242424242', declined: '4000000000000002', insufficientFunds: '4000000000009995' });
const OUTCOMES = Object.freeze({
  [TEST_CARDS.declined]: ['card_declined', 'The card was declined. Try another card.'],
  [TEST_CARDS.insufficientFunds]: ['insufficient_funds', 'The card has insufficient funds.'],
});

const cardError = (code, message) => new PlatformError(402, code, message);

export function luhn(digits) {
  let total = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    total += d;
  }
  return total % 10 === 0;
}

export function brandOf(digits) {
  if (/^3[47]/.test(digits)) return 'Amex';
  if (/^4/.test(digits)) return 'Visa';
  const two = Number(digits.slice(0, 2)), four = Number(digits.slice(0, 4));
  if ((two >= 51 && two <= 55) || (four >= 2221 && four <= 2720)) return 'Mastercard';
  return 'Card';
}

/** Checks the card and returns { brand, last4, declined }; the full number goes no further than this function. */
export function checkCard(card, nowMs) {
  if (!card || typeof card !== 'object' || Array.isArray(card)) throw invalid('Enter the card details.', 'invalid_card');
  const digits = typeof card.number === 'string' ? card.number.replace(/[\s-]/g, '') : '';
  if (!/^\d{12,19}$/.test(digits) || !luhn(digits)) throw cardError('invalid_card', 'The card number is not valid.');
  const month = card.expMonth, rawYear = card.expYear;
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(rawYear) || rawYear < 0 || rawYear > 2100) throw cardError('invalid_card', 'Enter a valid expiry month and year.');
  const year = rawYear < 100 ? 2000 + rawYear : rawYear;
  if (Date.UTC(year, month, 1) <= nowMs) throw cardError('invalid_card', 'The card has expired.');
  if (typeof card.cvc !== 'string' || !/^\d{3,4}$/.test(card.cvc)) throw cardError('invalid_card', 'Enter the 3 or 4 digit security code.');
  if (typeof card.name !== 'string' || !card.name.trim() || card.name.length > 80) throw cardError('invalid_card', 'Enter the name on the card.');
  const [code, message] = OUTCOMES[digits] || [];
  return { brand: brandOf(digits), last4: digits.slice(-4), declined: code ? { code, message } : null };
}

/**
 * Books a successful payment: the payment row, the premium split through the escrow agent (simulated), then the reservation request.
 * An order with nothing to pay now (a fixed-price lock) records a zero payment with no card, so every order moves through the same states.
 */
export function recordPaid(db, order, { brand = null, last4 = null, at }) {
  update(db, 'orders', { ref: order.ref }, { status: 'paid', paid_at: at }, at);
  insert(db, 'payments', { id: newId('pay'), order_ref: order.ref, account_id: order.account_id, amount: order.pay_now, brand, last4, status: 'succeeded', code: null, at }, at);
  if (order.premium_total > 0) {
    const toNeocloud = roundCents(order.premium_total * (1 - PLATFORM_FEE_SHARE));
    for (const [direction, amount] of [['premium_to_neocloud', toNeocloud], ['premium_to_dodona', roundCents(order.premium_total - toNeocloud)]]) {
      insert(db, 'payouts', { id: newId('po'), order_ref: order.ref, account_id: order.account_id, neocloud_id: order.neocloud_id, direction, amount, status: 'paid', due_at: at, paid_at: at }, at);
    }
  }
  const paid = { ...order, status: 'paid', paid_at: at };
  sendEmail(db, { accountId: order.account_id, template: 'receipt', at, orderRef: order.ref, order: paid });
  return requestReservation(db, paid, at);
}

/** POST /api/orders/:ref/pay. Declines leave the order pending_payment and answer 402. An order with nothing to pay confirms without a card. */
export function payOrder(db, account, order, body, nowMs) {
  if (order.status !== 'pending_payment') throw conflict(`Order ${order.ref} is ${order.status}; only an unpaid order can be paid.`, 'bad_status');
  const free = order.pay_now === 0;
  const { brand, last4, declined } = free ? { brand: null, last4: null, declined: null } : checkCard(body.card, nowMs);
  const at = account.demo_now;
  if (declined) {
    insert(db, 'payments', { id: newId('pay'), order_ref: order.ref, account_id: account.id, amount: order.pay_now, brand, last4, status: 'declined', code: declined.code, at }, at);
    throw cardError(declined.code, declined.message);
  }
  if (Date.parse(order.start) <= Date.parse(at)) throw conflict('This order’s window has already started. Create a new order.', 'window_started');
  const event = transaction(db, () => recordPaid(db, order, { brand, last4, at }));
  recordServerEvent('payment', `${free ? 'Confirmed, nothing to pay' : 'Payment'} · ${order.ref} · ${order.gpu} × ${order.count} · ${order.kind} · $${order.pay_now.toFixed(2)}`, { amount: order.pay_now, brand }, { ref: order.ref });
  return { order: get(db, 'SELECT * FROM orders WHERE ref = ?', order.ref), event };
}

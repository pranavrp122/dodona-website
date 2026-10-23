/** Platform checkout: quantity, the full breakdown and a mock card form. The card goes only into the pay request body: never a URL, a log or storage. */
import { escapeHtml as esc, windowLabel, utcStamp } from '/dashboard-view.js';
import { api, startPage, toast, money, rate, kindPill, kindName, isFloor, isLock, breakEven } from '/platform-shell.js';

const HOUR_MS = 3600000;
const BOOKING_FEE = 2;
const PLATFORM_SHARE = 0.15;
const DECLINES = {
  card_declined: 'The card was declined. Try 4242 4242 4242 4242 to see a successful payment.',
  insufficient_funds: 'The card was declined for insufficient funds. Try another test card.',
  invalid_card: 'That card number, expiry or CVC is not valid.',
};
const $ = id => document.getElementById(id);
const page = { offer: null, order: null };

const cents = v => Math.round(v * 100) / 100;

// Before the order exists the breakdown is computed here from the offer; afterwards it is the server's.
function estimate(offer, count) {
  const gpuHours = count * (Date.parse(offer.end) - Date.parse(offer.start)) / HOUR_MS;
  const lock = isLock(offer.kind);
  const premiumTotal = lock ? 0 : cents(offer.premiumPerGpuHour * gpuHours);
  return {
    premiumPerGpuHour: lock ? 0 : offer.premiumPerGpuHour, premiumTotal, platformFee: cents(premiumTotal * PLATFORM_SHARE),
    bookingFee: BOOKING_FEE, payNow: cents(premiumTotal + BOOKING_FEE), computeCostIfUsed: cents(offer.strike * gpuHours),
    breakEven: breakEven(offer.kind, offer.strike, offer.premiumPerGpuHour).value, gpuHours,
  };
}

const termsOf = () => page.order || page.offer;
const breakdownOf = () => (page.order ? page.order.breakdown || page.order : estimate(page.offer, Number($('co-count').value) || page.offer.minGpus));

function lines() {
  const t = termsOf();
  const b = breakdownOf();
  const lock = isLock(t.kind);
  const be = breakEven(t.kind, t.strike, b.premiumPerGpuHour ?? t.premiumPerGpuHour);
  const used = lock ? 'Compute bill at the fixed price' : isFloor(t.kind) ? 'Floor revenue if the window average is below it' : 'Compute bill if you use every hour at the cap';
  return [
    ['Neocloud', t.neocloud?.name || 'Partner neocloud (simulated)', t.region],
    ['Compute', `${Number(page.order?.count ?? $('co-count').value).toLocaleString('en-US')} × ${t.gpu}${t.config ? ` · ${t.config}` : ''}`],
    ['Window', windowLabel(t.start, t.end), `${utcStamp(t.start)} to ${utcStamp(t.end)}`],
    [lock ? 'Fixed price' : isFloor(t.kind) ? 'Floor' : 'Cap', `${rate(t.strike)} per GPU-hour`, lock ? '' : 'Settles on the average daily index over the window'],
    ['GPU-hours', Math.round(b.gpuHours).toLocaleString('en-US')],
    ...(lock ? [] : [['Premium', `${rate(b.premiumPerGpuHour)} × GPU-hours = ${money(b.premiumTotal)}`], ['of which Dodona platform fee (15%)', money(b.platformFee), '', 'is-sub']]),
    ['Booking fee', money(b.bookingFee)],
    [used, money(b.computeCostIfUsed), 'Not charged now'],
    ['Break-even', be.text],
    ['Pay now', money(lock ? b.bookingFee : b.payNow), '', 'is-total'],
  ];
}

function renderSummary() {
  const t = termsOf();
  const rows = lines();
  $('co-kind').innerHTML = kindPill(t.kind);
  $('co-sum-sub').textContent = page.order ? `Order ${page.order.ref} · awaiting payment` : 'Estimate from the offer; confirmed when the order is placed.';
  $('co-lines').innerHTML = rows.map(([term, value, note, cls]) => `<div${cls ? ` class="${cls}"` : ''}><dt>${esc(term)}${note ? `<small>${esc(note)}</small>` : ''}</dt><dd>${esc(value)}</dd></div>`).join('');
  $('co-sum-foot').textContent = isFloor(t.kind)
    ? 'A price floor pays you the difference when the window average ends below the floor, from the matched buyer pool (simulated). Usually bought by providers.'
    : isLock(t.kind) ? 'A fixed price bills every hour at the set price, whatever the index does.' : 'A price cap bills the lower of the window average and the cap for each GPU-hour you use.';
  $('co-pay-lbl').textContent = `Pay ${rows.at(-1)[1]}`;
}

function renderQuantity() {
  const input = $('co-count');
  if (page.order) {
    input.value = page.order.count;
    input.disabled = true;
    $('co-qty-note').textContent = 'Fixed once the order is placed. To change it, start again from the offer.';
    $('co-count-hint').textContent = '';
    return;
  }
  const o = page.offer;
  const max = Math.min(o.maxGpus, o.availableGpus);
  input.min = o.minGpus;
  input.max = max;
  if (!input.value) input.value = o.minGpus;
  $('co-count-hint').textContent = `Between ${o.minGpus} and ${max} GPUs (${o.availableGpus} available).`;
}

/* ---------- card ---------- */
function readCard() {
  const number = $('co-number').value.replace(/[\s-]/g, '');
  const exp = $('co-exp').value.trim().match(/^(\d{1,2})\s*\/\s*(\d{2}|\d{4})$/);
  const cvc = $('co-cvc').value.trim();
  const name = $('co-name').value.trim();
  if (!name) return { error: ['co-name', 'Enter the name on the card.'] };
  if (!/^\d{12,19}$/.test(number)) return { error: ['co-number', 'Enter the card number, 12 to 19 digits.'] };
  if (!exp || Number(exp[1]) < 1 || Number(exp[1]) > 12) return { error: ['co-exp', 'Enter the expiry as MM/YY.'] };
  if (!/^\d{3,4}$/.test(cvc)) return { error: ['co-cvc', 'Enter the 3 or 4 digit CVC.'] };
  const year = exp[2].length === 2 ? 2000 + Number(exp[2]) : Number(exp[2]);
  return { card: { number, expMonth: Number(exp[1]), expYear: year, cvc, name } };
}

function showError(message, field) {
  $('co-err').textContent = message || '';
  $('co-form').querySelectorAll('[aria-invalid]').forEach(el => el.removeAttribute('aria-invalid'));
  if (field) { $(field).setAttribute('aria-invalid', 'true'); $(field).focus(); }
}

function validCount() {
  if (page.order) return true;
  const count = Number($('co-count').value);
  const max = Math.min(page.offer.maxGpus, page.offer.availableGpus);
  if (Number.isInteger(count) && count >= page.offer.minGpus && count <= max) return true;
  showError(`Choose between ${page.offer.minGpus} and ${max} GPUs.`);
  $('co-count').setAttribute('aria-invalid', 'true');
  $('co-count').focus();
  return false;
}

async function ensureOrder() {
  if (page.order) return page.order;
  const { order } = await api('/api/orders', { method: 'POST', body: { offerId: page.offer.id, count: Number($('co-count').value) } });
  page.order = order;
  // The order reference (never the card) goes in the address so a reload continues this order.
  history.replaceState(null, '', `/checkout?order=${encodeURIComponent(order.ref)}`);
  renderQuantity();
  renderSummary();
  return order;
}

async function pay(event) {
  event.preventDefault();
  $('co-count').removeAttribute('aria-invalid');
  if (!validCount()) return;
  const read = readCard();
  if (read.error) { showError(read.error[1], read.error[0]); return; }
  showError('');
  const button = $('co-pay');
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    const order = await ensureOrder();
    await api(`/api/orders/${encodeURIComponent(order.ref)}/pay`, { method: 'POST', body: { card: read.card } });
    $('co-number').value = '';
    $('co-cvc').value = '';
    location.assign(`/orders/${encodeURIComponent(order.ref)}`);
  } catch (error) {
    $('co-cvc').value = '';
    showError(DECLINES[error.code] || error.message, error.code === 'invalid_card' ? 'co-number' : null);
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

async function load() {
  const params = new URLSearchParams(location.search);
  const ref = params.get('order');
  const offerId = params.get('offer');
  try {
    if (ref) {
      const { order } = await api(`/api/orders/${encodeURIComponent(ref)}`);
      if (order.status !== 'pending_payment') { location.replace(`/orders/${encodeURIComponent(order.ref)}`); return; }
      page.order = order;
    } else if (offerId) {
      page.offer = (await api(`/api/offers/${encodeURIComponent(offerId)}`)).offer;
    } else {
      $('co-load-err').textContent = 'Pick an offer first.';
      return;
    }
  } catch (error) {
    $('co-load-err').textContent = error.status === 404 ? 'That offer or order was not found. Pick one from the offers board.' : error.message;
    return;
  }
  const t = termsOf();
  $('co-title').textContent = `${kindName(t.kind)} · ${t.gpu} · ${windowLabel(t.start, t.end)}`;
  $('co-sub').textContent = `${t.neocloud?.name || 'Partner neocloud (simulated)'} · ${t.region}. Review the terms, pick the quantity and pay with a test card.`;
  $('co-body').hidden = false;
  renderQuantity();
  renderSummary();
}

let started = false;
startPage(async () => {
  if (started) return;
  started = true;
  $('co-count').addEventListener('input', () => { if (!page.order) renderSummary(); });
  $('co-form').addEventListener('submit', pay);
  await load();
}).catch(error => toast(error.message));

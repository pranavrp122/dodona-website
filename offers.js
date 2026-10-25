/** Offers board: filters, offers from the demo neoclouds, and a "price your own" form that quotes and then opens checkout. */
import { escapeHtml as esc, icon, windowLabel } from '/dashboard-view.js';
import { api, startPage, toast, money, rate, kindPill, isFloor, isLock, quoteType, breakEven } from '/platform-shell.js';

const DAY_MS = 86400000;
const $ = id => document.getElementById(id);
let demoNow = null;
let quoted = null;

const weeks = (start, end) => Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / (7 * DAY_MS)));

function offerRow(o) {
  const be = breakEven(o.kind, o.strike, o.premiumPerGpuHour);
  const floorNote = isFloor(o.kind) ? '<small>usually bought by providers</small>' : '';
  const range = o.minGpus === o.maxGpus ? `${o.minGpus}` : `${o.minGpus}–${o.maxGpus}`;
  const w = weeks(o.start, o.end);
  return `<tr>
    <td><span class="p-nc">${esc(o.neocloud?.name || 'Neocloud')}<small>${esc(o.region)}</small></span></td>
    <td><span class="d-pos-l">${esc(o.gpu)}${o.config ? ` · ${esc(o.config)}` : ''}</span><span class="d-sub">${esc(range)} GPUs per order</span></td>
    <td><span class="p-kind">${kindPill(o.kind)}${floorNote}</span></td>
    <td><span class="d-pos-l">${esc(windowLabel(o.start, o.end))}</span><span class="d-sub">${w} week${w === 1 ? '' : 's'}</span></td>
    <td class="r d-num">${esc(rate(o.strike))}<span class="d-sub">per GPU-hour</span></td>
    <td class="r d-num">${isLock(o.kind) ? '<span class="d-muted">none</span><span class="d-sub">nothing to pay now</span>' : `${esc(rate(o.premiumPerGpuHour))}<span class="d-sub">per GPU-hour</span>`}</td>
    <td class="r d-num">${esc(be.text)}</td>
    <td class="r d-num">${esc(Number(o.availableGpus).toLocaleString('en-US'))}<span class="d-sub">GPUs</span></td>
    <td class="p-act"><a class="btn btn-sm${isFloor(o.kind) ? '' : ' btn-primary'}" href="/checkout?offer=${encodeURIComponent(o.id)}">${icon('arrow-right')}<span>Take this offer</span></a></td>
  </tr>`;
}

async function loadOffers() {
  const params = new URLSearchParams();
  for (const [key, id] of [['gpu', 'of-gpu'], ['region', 'of-region'], ['kind', 'of-kind']]) if ($(id).value) params.set(key, $(id).value);
  $('of-rows').innerHTML = '<tr><td colspan="9" class="d-muted">Loading offers…</td></tr>';
  try {
    const { offers = [] } = await api(`/api/offers${params.size ? `?${params}` : ''}`);
    $('of-count').textContent = String(offers.length);
    $('of-rows').innerHTML = offers.map(offerRow).join('') || '<tr><td colspan="9" class="d-muted">No offers match these filters.</td></tr>';
  } catch (error) {
    $('of-rows').innerHTML = `<tr><td colspan="9" class="d-muted">${esc(error.message)}</td></tr>`;
  }
}

/* ---------- price your own ---------- */
const dayIso = ms => new Date(ms).toISOString().slice(0, 10);

function defaultWindow() {
  const base = Date.parse(demoNow || new Date().toISOString());
  const start = Math.ceil((base + 7 * DAY_MS) / DAY_MS) * DAY_MS;
  if (!$('cu-start').value) $('cu-start').value = dayIso(start);
  if (!$('cu-end').value) $('cu-end').value = dayIso(start + 14 * DAY_MS);
}

function customInput() {
  const kind = $('cu-kind').value;
  const start = $('cu-start').value;
  const end = $('cu-end').value;
  if (!start || !end) return { error: 'Choose the start and end dates of the window.' };
  if (end <= start) return { error: 'The window must end after it starts.' };
  const strikeRaw = $('cu-strike').value.trim();
  const strike = strikeRaw === '' ? null : Number(strikeRaw);
  if (strike != null && !(strike > 0 && strike <= 100)) return { error: 'Enter a strike between $0.01 and $100 per GPU-hour, or leave it blank.' };
  return { kind, gpu: $('cu-gpu').value, count: Number($('cu-count').value), start: `${start}T00:00:00Z`, end: `${end}T00:00:00Z`, strike: isLock(kind) ? null : strike };
}

function quoteHtml(input, q) {
  const be = breakEven(input.kind, q.strike, q.premiumPerGpuHour);
  const lock = isLock(input.kind);
  const rows = [
    [lock ? 'Fixed price' : isFloor(input.kind) ? 'Floor' : 'Cap', `${rate(q.strike)} per GPU-hour`],
    ['GPU-hours', Math.round(q.gpuHours).toLocaleString('en-US')],
    ...(lock ? [] : [['Premium', `${rate(q.premiumPerGpuHour)} × GPU-hours = ${money(q.premiumTotal)}`], ['of which Dodona platform fee (15%)', money(q.platformFee), 'is-sub']]),
    [lock ? 'Compute bill at the fixed price' : isFloor(input.kind) ? 'Floor revenue if the average ends below it' : 'Compute bill if you use the hours at the cap', money(q.costIfUsed)],
    ['Break-even', be.text],
    ['Pay now', lock ? 'Nothing' : money(q.payNow), 'is-total'],
  ];
  return `<dl class="p-lines">${rows.map(([t, d, cls]) => `<div${cls ? ` class="${cls}"` : ''}><dt>${esc(t)}</dt><dd>${esc(d)}</dd></div>`).join('')}</dl>
    <div class="p-form"><p class="fine">Index as of ${esc(q.asOf || '—')} · method ${esc(q.method || 'black76-asian-v0')}. Premiums go 85% to the neocloud and 15% to Dodona, through the escrow agent.</p>
      <div class="c-acts"><button type="button" class="btn btn-primary" id="cu-go">${icon('credit-card')}<span>${lock ? 'Continue to confirm' : 'Continue to payment'}</span></button></div>
      <p class="p-err" id="cu-go-err" role="alert"></p></div>`;
}

async function getQuote(event) {
  event.preventDefault();
  const input = customInput();
  $('cu-err').textContent = input.error || '';
  if (input.error) return;
  const params = new URLSearchParams({ gpu: input.gpu, count: String(input.count), start: input.start, end: input.end, type: quoteType(input.kind) });
  if (input.strike != null) params.set('strike', input.strike.toFixed(2));
  $('cu-quote').disabled = true;
  try {
    const q = await api(`/api/quote?${params}`);
    quoted = { input: { ...input, strike: q.strike }, quote: q };
    $('cu-out').hidden = false;
    $('cu-out').innerHTML = quoteHtml(input, q);
    $('cu-go').focus();
  } catch (error) {
    $('cu-err').textContent = error.message;
  } finally { $('cu-quote').disabled = false; }
}

async function placeCustom() {
  if (!quoted) return;
  const { kind, gpu, count, start, end, strike } = quoted.input;
  $('cu-go').disabled = true;
  try {
    const { order } = await api('/api/orders', { method: 'POST', body: { custom: { gpu, count, start, end, kind, strike } } });
    location.assign(`/checkout?order=${encodeURIComponent(order.ref)}`);
  } catch (error) {
    $('cu-go-err').textContent = error.message;
    $('cu-go').disabled = false;
  }
}

function wire() {
  $('of-filters').addEventListener('change', loadOffers);
  $('of-filters').addEventListener('submit', event => { event.preventDefault(); loadOffers(); });
  $('cu-form').addEventListener('submit', getQuote);
  $('cu-form').addEventListener('change', () => { quoted = null; $('cu-out').hidden = true; $('cu-strike-field').hidden = isLock($('cu-kind').value); });
  $('cu-out').addEventListener('click', event => { if (event.target.closest('#cu-go')) placeCustom(); });
  $('of-own').addEventListener('click', () => setTimeout(() => $('cu-kind').focus(), 0));
}

let wired = false;
startPage(async account => {
  demoNow = account.demoNow;
  if (!wired) { wire(); wired = true; }
  defaultWindow();
  await loadOffers();
}).catch(error => toast(error.message));

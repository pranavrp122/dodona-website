/** Pure renderers for the provider portal: response normalisers, capacity, orders, contracts, settlements, payouts and the event log. Imported by the browser script and by tests. */
import { escapeHtml, icon, pill, shortDate } from './dashboard-view.js';

export { escapeHtml };

const MINUS = '−';
export const SCREENS = ['overview', 'orders', 'contracts', 'settlements', 'integration', 'settings'];
export const PAGES = {
  overview: ['Overview', 'Capacity, income and what needs your attention.'],
  orders: ['Orders', 'Confirm or decline the reservations Dodona sends you, follow active windows and review settled ones.'],
  contracts: ['Contracts', 'Caps you sold and floors you bought, valued at the expected window average.'],
  settlements: ['Settlements and payouts', 'The statement for every settled order and each payout through the escrow agent.'],
  integration: ['Integration', 'Every message between Dodona and your neocloud, shaped like the webhooks a real integration would use.'],
  settings: ['Settings', 'Reservation handling and company details.'],
};
export const SCENARIOS = ['market', 'rise', 'fall', 'spike', 'flat'];

/* ---------- formatting ---------- */
export function money(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const n = Number(value);
  const text = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? MINUS : ''}$${text}`;
}
export const signedMoney = value => (value == null || !Number.isFinite(Number(value)) ? '—' : Number(value) > 0 ? `+${money(value)}` : money(value));
export const rate = value => (value == null || !Number.isFinite(Number(value)) ? '—' : `$${Number(value).toFixed(2)}/GPU-h`);
export const toneOf = value => (value == null || !Number.isFinite(Number(value)) || Math.abs(Number(value)) < 0.005 ? 'is-flat' : Number(value) > 0 ? 'is-gain' : 'is-loss');
export const int = value => (value != null && Number.isFinite(Number(value)) ? Math.round(Number(value)).toLocaleString('en-US') : '—');
export const dateText = iso => (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}/.test(iso) ? shortDate(iso) : '—');
export const stamp = iso => (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso) ? `${shortDate(iso)}, ${iso.slice(11, 16)} UTC` : dateText(iso));
export const windowText = (start, end) => `${dateText(start)} to ${dateText(end)}`;
const gpuChip = gpu => `<span class="d-gpu d-gpu-${escapeHtml(String(gpu || '').replace(/[^A-Za-z0-9]/g, ''))}">${escapeHtml(gpu || '—')}</span>`;
const empty = (text, cols) => (cols ? `<tr><td colspan="${cols}" class="d-empty">${escapeHtml(text)}</td></tr>` : `<p class="d-empty">${escapeHtml(text)}</p>`);

/* ---------- normalisers: tolerate small shape differences in the platform API ---------- */
const list = (data, ...keys) => {
  if (Array.isArray(data)) return data;
  for (const key of keys) if (Array.isArray(data?.[key])) return data[key];
  return [];
};
const num = (...values) => { for (const v of values) if (v != null && v !== '' && Number.isFinite(Number(v))) return Number(v); return null; };

export const KIND_TEXT = { cap: 'Cap', call: 'Cap', floor: 'Floor', put: 'Floor', lock: 'Fixed price' };
export const kindKey = kind => ({ call: 'cap', put: 'floor' }[kind] || kind || 'cap');

export function normalizeOrder(o = {}) {
  const days = Math.max(0, (Date.parse(o.end) - Date.parse(o.start)) / 86400000);
  return {
    ref: String(o.ref ?? o.orderRef ?? ''),
    status: String(o.status ?? 'reserving'),
    gpu: o.gpu ?? o.offer?.gpu ?? '',
    count: num(o.count, o.gpus) ?? 0,
    region: o.region ?? '',
    kind: kindKey(o.kind),
    strike: num(o.strike),
    start: o.start ?? '', end: o.end ?? '',
    hours: num(o.gpuHours, o.hours, o.breakdown?.gpuHours, Number(o.count) * 24 * days),
    premiumTotal: num(o.premiumTotal, o.breakdown?.premiumTotal, o.premium),
    buyer: (typeof o.buyer === 'string' ? o.buyer : o.buyer?.company) || 'A Dodona buyer',
    usageHours: num(o.usageGpuHours, o.usage?.hoursReported) ?? 0,
    runningAvg: num(o.runningWindowAverage, o.usage?.windowAvgSoFar),
    settlement: o.settlement ?? null,
    deliveryChoice: o.deliveryChoice ?? 'deliver',
  };
}

const ACTIVE = new Set(['reserved', 'delivering']);
const INCOMING = new Set(['reserving', 'paid']);
export function bucketOrders(data) {
  if (data && !Array.isArray(data) && (data.incoming || data.active || data.settled)) {
    return { incoming: list(data.incoming).map(normalizeOrder), active: list(data.active).map(normalizeOrder), settled: [...list(data.settled), ...list(data.declined)].map(normalizeOrder) };
  }
  const all = list(data, 'orders').map(normalizeOrder);
  return {
    incoming: all.filter(o => INCOMING.has(o.status)),
    active: all.filter(o => ACTIVE.has(o.status)),
    settled: all.filter(o => !INCOMING.has(o.status) && !ACTIVE.has(o.status)),
  };
}

export function normalizeOverview(data = {}) {
  const capacity = list(data.capacity ?? data, 'capacity', 'rows').map(c => {
    const total = num(c.total) ?? 0, reserved = num(c.reserved, c.held) ?? 0;
    return { gpu: c.gpu ?? '', region: c.region ?? '', total, reserved, free: num(c.free) ?? Math.max(0, total - reserved) };
  });
  const inc = data.income ?? {};
  const bucket = b => ({ premiums: num(b?.premiums, b?.premiumsReceived) ?? 0, computeBills: num(b?.computeBills) ?? 0, floorPayouts: num(b?.floorPayouts) ?? 0 });
  return {
    neocloud: data.neocloud ?? null,
    capacity,
    income: { month: bucket(inc.month ?? inc.thisMonth), toDate: bucket(inc.toDate ?? inc.total ?? inc) },
    nextDeliveries: list(data.nextDeliveries).map(normalizeOrder),
    pending: num(data.pendingConfirmations, data.pendingCount, data.pending) ?? 0,
  };
}

/* ---------- overview ---------- */
export function capacityRows(capacity) {
  if (!capacity.length) return empty('No capacity registered for this neocloud.');
  return `<ul class="p-cap">${capacity.map(c => {
    const share = c.total > 0 ? Math.min(100, Math.round((c.reserved / c.total) * 100)) : 0;
    return `<li class="p-cap-row">
      <div class="p-cap-top"><span class="p-cap-name">${gpuChip(c.gpu)}<span>${escapeHtml(c.region)}</span></span>
        <span class="p-cap-nums"><b>${int(c.free)}</b> free of ${int(c.total)} GPUs</span></div>
      <div class="c-bar" role="img" aria-label="${escapeHtml(`${int(c.reserved)} of ${int(c.total)} ${c.gpu} reserved in ${c.region}`)}"><i class="is-cap" data-w="${share}"></i></div>
      <span class="p-cap-sub">${int(c.reserved)} reserved · ${share}% held</span>
    </li>`;
  }).join('')}</ul>`;
}

export function incomeList(income) {
  const row = (label, sub, a, b) => `<div><dt>${escapeHtml(label)}<span>${escapeHtml(sub)}</span></dt><dd>${money(a)}<small>${money(b)} to date</small></dd></div>`;
  const totalMonth = income.month.premiums + income.month.computeBills + income.month.floorPayouts;
  const totalAll = income.toDate.premiums + income.toDate.computeBills + income.toDate.floorPayouts;
  return `<dl class="p-income">
    ${row('Premiums received', 'Your 85% share of cap premiums', income.month.premiums, income.toDate.premiums)}
    ${row('Compute bills', 'Invoiced at settlement, paid through escrow', income.month.computeBills, income.toDate.computeBills)}
    ${row('Floor payouts', 'From the matched buyer pool', income.month.floorPayouts, income.toDate.floorPayouts)}
    <div class="is-total"><dt>This month</dt><dd>${money(totalMonth)}<small>${money(totalAll)} to date</small></dd></div>
  </dl>`;
}

export function deliveryList(orders) {
  if (!orders.length) return `<li class="d-muted">No deliveries scheduled.</li>`;
  return orders.slice(0, 5).map(o => {
    const d = new Date(Date.parse(o.start));
    const day = Number.isFinite(d.getTime()) ? `<b>${d.getUTCDate()}</b><small>${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })}</small>` : '<b>—</b>';
    return `<li><span class="c-day">${day}</span><span class="c-date-text">${icon('server')}<span>${escapeHtml(`${o.count} × ${o.gpu} for ${o.buyer}`)}<small>${escapeHtml(windowText(o.start, o.end))} · ${escapeHtml(o.ref)}</small></span></span>${statusPill(o.status)}</li>`;
  }).join('');
}

/* ---------- orders ---------- */
const STATUS = {
  pending_payment: ['clock', 'neutral', 'Awaiting payment'], paid: ['circle-check', 'info', 'Paid'],
  reserving: ['clock', 'warning', 'Awaiting your confirmation'], reserved: ['lock', 'info', 'Reserved'],
  delivering: ['circle-play', 'success', 'Delivering'], settled: ['circle-check', 'neutral', 'Settled'],
  cancelled: ['circle-x', 'neutral', 'Cancelled'], declined: ['circle-x', 'error', 'Declined'],
};
export const statusPill = status => pill(...(STATUS[status] || ['info', 'neutral', String(status)]));
const termCell = o => `${escapeHtml(KIND_TEXT[o.kind] || o.kind)}${o.strike != null ? ` at ${rate(o.strike)}` : ''}`;

export function incomingRows(orders) {
  if (!orders.length) return empty('No reservations are waiting for you.', 6);
  return orders.map(o => `<tr data-ref="${escapeHtml(o.ref)}">
    <th scope="row"><span class="d-pos-l">${escapeHtml(o.ref)}</span><span class="d-pos-s">${escapeHtml(o.buyer)}</span></th>
    <td><span class="d-pos">${gpuChip(o.gpu)}<span><span class="d-pos-l">${int(o.count)} GPUs</span><span class="d-pos-s">${escapeHtml(o.region)}</span></span></span></td>
    <td>${escapeHtml(windowText(o.start, o.end))}<span class="d-sub">${int(o.hours)} GPU-hours</span></td>
    <td>${termCell(o)}</td>
    <td><span class="p-hold">${icon('lock')}<span>Holds ${int(o.count)} ${escapeHtml(o.gpu)} in ${escapeHtml(o.region || 'your region')}</span></span></td>
    <td class="c-act-cell"><div class="c-acts">
      <button type="button" class="btn btn-sm btn-primary" data-act="confirm" data-ref="${escapeHtml(o.ref)}">${icon('check')}<span>Confirm</span></button>
      <button type="button" class="btn btn-sm" data-act="decline" data-ref="${escapeHtml(o.ref)}">${icon('x')}<span>Decline</span></button>
    </div></td></tr>`).join('');
}

export function activeRows(orders) {
  if (!orders.length) return empty('Nothing is reserved or delivering right now.', 6);
  return orders.map(o => {
    const share = o.hours ? Math.min(100, Math.round((o.usageHours / o.hours) * 100)) : 0;
    return `<tr data-ref="${escapeHtml(o.ref)}">
    <th scope="row"><span class="d-pos-l">${escapeHtml(o.ref)}</span><span class="d-pos-s">${escapeHtml(o.buyer)}</span></th>
    <td><span class="d-pos">${gpuChip(o.gpu)}<span class="d-pos-l">${int(o.count)} GPUs</span></span></td>
    <td>${escapeHtml(windowText(o.start, o.end))}</td>
    <td>${statusPill(o.status)}<span class="d-sub">${o.deliveryChoice === 'resell' ? 'Hours resold to another buyer' : 'Buyer uses the hours'}</span></td>
    <td class="r">${int(o.usageHours)} of ${int(o.hours)} h<span class="c-bar p-mini-bar"><i class="is-cap" data-w="${share}"></i></span></td>
    <td class="r">${o.runningAvg == null ? '—' : rate(o.runningAvg)}<span class="d-sub">${termCell(o)}</span></td></tr>`;
  }).join('');
}

export function settledRows(orders) {
  if (!orders.length) return empty('No settled or closed orders yet.', 5);
  return orders.map(o => {
    const s = o.settlement || {};
    return `<tr><th scope="row"><span class="d-pos-l">${escapeHtml(o.ref)}</span><span class="d-pos-s">${escapeHtml(o.buyer)}</span></th>
    <td><span class="d-pos">${gpuChip(o.gpu)}<span class="d-pos-l">${int(o.count)} GPUs</span></span></td>
    <td>${escapeHtml(windowText(o.start, o.end))}</td><td>${statusPill(o.status)}</td>
    <td class="r">${s.windowAvg != null ? rate(Number(s.windowAvg)) : '—'}<span class="d-sub">${s.computeBill != null ? `bill ${money(s.computeBill)}` : termCell(o)}</span></td></tr>`;
  }).join('');
}

/* ---------- contracts and what-if ---------- */
export const NEOCLOUD_SHARE = 0.85;
// A sold cap counts the neocloud's 85% of the premium; a bought floor counts the whole premium paid.
export function normalizeContract(c = {}) {
  const kind = kindKey(c.kind ?? c.type), count = num(c.count) ?? 0;
  const days = Math.max(0, (Date.parse(c.end) - Date.parse(c.start)) / 86400000) || 0;
  const total = num(c.premium, c.premiumTotal) ?? 0;
  return {
    ref: String(c.orderRef ?? c.ref ?? ''), kind, gpu: c.gpu ?? '', count, status: c.status ?? '',
    hours: num(c.hours, c.gpuHours) ?? count * 24 * days, start: c.start ?? '', end: c.end ?? '',
    strike: num(c.strike) ?? 0, premium: kind === 'cap' && c.premium == null ? Math.round(total * NEOCLOUD_SHARE * 100) / 100 : total,
    expectedAvg: num(c.expectedAvg, c.expectedWindowAverage), value: num(c.value), settled: c.status === 'settled',
  };
}
export const normalizeContracts = data => (Array.isArray(data?.contracts) ? data.contracts.map(normalizeContract)
  : [...list(data?.capsSold).map(c => normalizeContract({ ...c, kind: 'cap' })), ...list(data?.floorsBought).map(c => normalizeContract({ ...c, kind: 'floor' }))]);

export function normalizeSettings(data = {}) {
  const n = data.neocloud ?? data.settings ?? data;
  return { autoConfirm: n.autoConfirm, webhookUrl: n.webhookUrl ?? '', apiKeyLast4: n.apiKeyLast4 ?? n.apiKeyPreview ?? null, company: data.company ?? null, name: n.name ?? null };
}

// Provider side: a sold cap keeps its premium and gives up anything above the strike; a bought floor pays its premium and receives the shortfall below the strike.
export function providerPayoff(contract, avg) {
  const { kind, strike, hours, premium } = contract;
  if (kind === 'floor') { const payout = Math.max(strike - avg, 0) * hours; return { gross: payout, net: payout - premium }; }
  if (kind === 'lock') { const diff = (strike - avg) * hours; return { gross: diff, net: diff }; }
  const giveUp = Math.max(avg - strike, 0) * hours;
  return { gross: -giveUp, net: premium - giveUp };
}

export function contractRows(contracts) {
  if (!contracts.length) return empty('No caps sold or floors bought yet.', 7);
  return contracts.map(c => `<tr>
    <th scope="row"><span class="d-pos-l">${escapeHtml(c.ref)}</span><span class="d-pos-s">${c.kind === 'floor' ? 'Floor bought' : c.kind === 'lock' ? 'Fixed price sold' : 'Cap sold'}</span></th>
    <td><span class="d-pos">${gpuChip(c.gpu)}<span class="d-pos-l">${int(c.count)} GPUs</span></span></td>
    <td>${escapeHtml(windowText(c.start, c.end))}<span class="d-sub">${int(c.hours)} GPU-hours</span></td>
    <td class="r">${rate(c.strike)}</td>
    <td class="r">${money(c.premium)}<span class="d-sub">${c.kind === 'floor' ? 'paid' : 'your 85% received'}</span></td>
    <td class="r">${c.expectedAvg == null ? '—' : rate(c.expectedAvg)}${c.settled ? '<span class="d-sub">final window average</span>' : ''}</td>
    <td class="r ${toneOf(c.value)}">${c.settled ? statusPill('settled') : signedMoney(c.value)}</td></tr>`).join('');
}

export function whatIfSummary(all, avg) {
  const contracts = all.filter(c => !c.settled);
  const caps = contracts.filter(c => c.kind === 'cap'), floors = contracts.filter(c => c.kind === 'floor');
  const sum = (items, key) => items.reduce((total, c) => total + providerPayoff(c, avg)[key], 0);
  const capNet = sum(caps, 'net'), floorNet = sum(floors, 'net');
  const capNote = !caps.length ? 'No caps sold.' : caps.some(c => avg > c.strike) ? 'Above a strike you give up the excess over it.' : 'Below every strike you keep the full premium.';
  const floorNote = !floors.length ? 'No floors bought.' : floors.some(c => avg < c.strike) ? 'Below a strike the floor pays the shortfall.' : 'Above every strike the floor pays nothing.';
  const cell = (label, value, note) => `<div><dt>${escapeHtml(label)}</dt><dd class="${toneOf(value)}">${signedMoney(value)}</dd><p class="p-note">${escapeHtml(note)}</p></div>`;
  return `<dl class="p-whatif-dl">
    ${cell('Caps sold, net of premium', capNet, capNote)}
    ${cell('Floors bought, net of premium', floorNet, floorNote)}
    ${cell('Both sides together', capNet + floorNet, 'Each contract settles on its window average of the daily index.')}
  </dl>`;
}

/* ---------- settlements and payouts ---------- */
export function settlementRows(rows) {
  const items = list(rows, 'settlements');
  if (!items.length) return empty('No order has settled yet. Statements appear here when a window ends.', 8);
  return items.map(raw => {
    const s = raw.settlement ?? raw;
    return `<tr><th scope="row"><span class="d-pos-l">${escapeHtml(raw.orderRef ?? raw.ref ?? '')}</span><span class="d-pos-s">${escapeHtml(KIND_TEXT[s.kind] || s.kind || '')}</span></th>
      <td class="r">${rate(num(s.windowAvg))}</td><td class="r">${rate(num(s.strike))}</td><td class="r">${int(s.hours)}</td>
      <td class="r">${money(num(s.computeBill))}</td><td class="r">${money(num(s.premiumPaid, s.premium))}</td>
      <td class="r">${money(num(s.payout, s.saving))}</td><td>${escapeHtml(stamp(s.computedAt ?? raw.computedAt))}</td></tr>`;
  }).join('');
}

const DIRECTION_TEXT = {
  buyer_to_neocloud: 'Compute bill from buyer', premium_to_neocloud: 'Premium share to you', premium_to_dodona: 'Platform fee to Dodona',
  resale_to_holder: 'Resale proceeds to holder', floor_to_holder: 'Floor payout to holder',
};
export function payoutRows(rows) {
  const items = list(rows, 'payouts');
  if (!items.length) return empty('No payouts yet.', 6);
  return items.map(p => `<tr><th scope="row">${escapeHtml(p.orderRef ?? '')}</th>
    <td>${escapeHtml(DIRECTION_TEXT[p.direction] || p.direction || '')}</td><td class="r">${money(num(p.amount))}</td>
    <td>${p.status === 'paid' ? pill('circle-check', 'success', 'Paid') : pill('clock', 'warning', 'Scheduled')}</td>
    <td>${escapeHtml(stamp(p.dueAt))}</td><td>${p.paidAt ? escapeHtml(stamp(p.paidAt)) : '—'}</td></tr>`).join('');
}

// Cells that start with a formula character are prefixed so a spreadsheet shows them as text.
const csvCell = value => {
  const text = value == null ? '' : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) && !/^-?\d/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};
export const toCsv = (header, rows) => [header, ...rows].map(row => row.map(csvCell).join(',')).join('\n') + '\n';
export function statementCsv(settlements, payouts) {
  const s = list(settlements, 'settlements').map(raw => {
    const x = raw.settlement ?? raw;
    return ['settlement', raw.orderRef ?? raw.ref, x.kind, x.windowAvg, x.strike, x.hours, x.computeBill, x.premiumPaid ?? x.premium, x.payout ?? x.saving, '', x.computedAt ?? raw.computedAt];
  });
  const p = list(payouts, 'payouts').map(x => ['payout', x.orderRef, x.direction, '', '', '', '', '', x.amount, x.status, x.paidAt ?? x.dueAt]);
  return toCsv(['row', 'order', 'kind or direction', 'window average', 'strike', 'hours', 'compute bill', 'premium', 'amount', 'status', 'date'], [...s, ...p]);
}

/* ---------- integration events ---------- */
const DIRECTION = { dodona_to_neocloud: ['arrow-right', 'Dodona to you'], neocloud_to_dodona: ['arrow-right', 'You to Dodona'], internal: ['settings', 'Internal'] };
export function eventRows(events) {
  const items = list(events, 'events');
  if (!items.length) return `<li class="d-muted">No messages yet. They appear when a buyer pays for an order on your capacity.</li>`;
  return items.map(e => {
    const [ic, text] = DIRECTION[e.direction] || ['info', String(e.direction ?? '')];
    const ok = Number(e.httpStatus) >= 200 && Number(e.httpStatus) < 300;
    let body;
    try { body = JSON.stringify(e.payload ?? {}, null, 2); } catch { body = String(e.payload); }
    return `<li class="p-event${e.direction === 'neocloud_to_dodona' ? ' is-out' : ''}"><details>
      <summary><span class="p-ev-dir">${icon(ic)}<span>${escapeHtml(text)}</span></span>
        <code class="p-ev-type">${escapeHtml(e.type ?? '')}</code>
        <span class="p-ev-ref">${escapeHtml(e.orderRef ?? '')}</span>
        ${pill(ok ? 'circle-check' : 'circle-x', ok ? 'success' : 'error', `HTTP ${e.httpStatus ?? '—'}`)}
        <time datetime="${escapeHtml(e.at ?? '')}">${escapeHtml(stamp(e.at))}</time></summary>
      <pre class="p-json"><code>${escapeHtml(body)}</code></pre></details></li>`;
  }).join('');
}

/* ---------- gate ---------- */
export const gateFor = account => (account && account.role === 'provider' ? 'portal' : 'signin');

/** HTML renderers for the demo admin portal. Every value from the API passes through escapeHtml. */
import { escapeHtml as esc, icon, pill } from './dashboard-view.js';

export { esc, icon };

export const ROLES = ['buyer', 'lender', 'provider', 'admin'];
export const STAGES = ['lead', 'demo', 'kyb', 'active', 'churned'];
export const KYBS = ['pending', 'verified', 'rejected'];
export const ORDER_STATUSES = ['pending_payment', 'paid', 'reserving', 'reserved', 'delivering', 'settled', 'cancelled', 'declined'];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const KYB_LOOK = { verified: ['circle-check', 'success'], pending: ['clock', 'warning'], rejected: ['circle-x', 'error'] };
const STAGE_LOOK = { lead: ['info', 'neutral'], demo: ['clock', 'info'], kyb: ['shield', 'warning'], active: ['circle-check', 'success'], churned: ['circle-x', 'error'] };
const STATUS_LOOK = {
  pending_payment: ['credit-card', 'warning'], paid: ['circle-check', 'info'], reserving: ['clock', 'info'], reserved: ['check', 'info'],
  delivering: ['activity', 'success'], settled: ['circle-check', 'neutral'], cancelled: ['circle-x', 'neutral'], declined: ['circle-x', 'error'],
  scheduled: ['clock', 'info'], succeeded: ['circle-check', 'success'], failed: ['circle-x', 'error'],
};
const ROLE_TEXT = { buyer: 'Buyer', lender: 'Lender', provider: 'Provider', admin: 'Admin' };
const KIND_TEXT = { cap: 'Cap', call: 'Cap', floor: 'Floor', put: 'Floor', lock: 'Lock' };
const DIRECTION_TEXT = {
  buyer_to_neocloud: 'Compute bill to the neocloud', premium_to_neocloud: 'Premium to the neocloud', premium_to_dodona: 'Platform fee to Dodona',
  resale_to_holder: 'Resale proceeds to the holder', floor_to_holder: 'Floor payout to the holder',
};

export const words = value => String(value ?? '').replaceAll('_', ' ');
export const label = value => { const text = words(value); return text.charAt(0).toUpperCase() + text.slice(1); };
export const roleText = role => ROLE_TEXT[role] || label(role);
export const kindText = kind => KIND_TEXT[kind] || label(kind);

export function money(value) {
  if (value == null || value === '' || !Number.isFinite(Number(value))) return '—';
  const n = Number(value);
  return `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
export const perHour = value => (value == null || !Number.isFinite(Number(value)) ? '—' : `$${Number(value).toFixed(4)}/h`);
export const toneOf = value => (value == null || Math.abs(value) < 0.005 ? '' : value > 0 ? 'is-gain' : 'is-loss');

export function day(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
export function stamp(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : `${day(iso)}, ${d.toISOString().slice(11, 16)} UTC`;
}
export const windowText = (start, end) => (start ? `${day(start)} to ${day(end)}` : '—');

const look = (lookup, value) => lookup[value] || ['info', 'neutral'];
export const kybPill = kyb => pill(...look(KYB_LOOK, kyb), `KYB ${words(kyb) || 'unknown'}`);
export const stagePill = stage => pill(...look(STAGE_LOOK, stage), label(stage) || 'No stage');
export const statusPill = status => pill(...look(STATUS_LOOK, status), label(status) || 'Unknown');

export const options = (values, selected, { any = '', text = label } = {}) =>
  (any ? `<option value="">${esc(any)}</option>` : '') + values.map(v => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(text(v))}</option>`).join('');

const emptyRow = (text, cols) => `<tr><td colspan="${cols}" class="d-empty">${esc(text)}</td></tr>`;

// A titled container with an optional count, a description, header actions and a footnote.
export function container({ id, title, count, desc = '', acts = '', body, span = '', iconName = '', foot = '' }) {
  return `<section class="c-ctr${span ? ' ' + span : ''}" aria-labelledby="${id}-h">
    <div class="c-ctr-h"><div><h2 id="${id}-h">${iconName ? icon(iconName, 'c-h-ic') : ''}${esc(title)}${count == null ? '' : ` <span class="c-count">${esc(count)}</span>`}</h2>${desc ? `<p>${esc(desc)}</p>` : ''}</div>${acts}</div>
    ${body}${foot ? `<p class="fine c-ctr-foot">${esc(foot)}</p>` : ''}
  </section>`;
}

// Heads given as ['Label'] are right-aligned number columns.
export function table(caption, heads, rows, emptyText) {
  const th = heads.map(h => (Array.isArray(h) ? `<th scope="col" class="r">${esc(h[0])}</th>` : `<th scope="col">${esc(h)}</th>`)).join('');
  return `<div class="d-scroll"><table class="d-table a-table"><caption class="visually-hidden">${esc(caption)}</caption><thead><tr>${th}</tr></thead><tbody>${rows.length ? rows.join('') : emptyRow(emptyText, heads.length)}</tbody></table></div>`;
}

// Accounts list: the whole row opens the account; the company link is the keyboard target.
export const ACCOUNT_HEADS = ['Company', 'Contact email', 'Role', 'KYB', 'Stage', ['Orders'], ['Premiums paid'], 'Last active', 'Created'];
export function accountRows(accounts) {
  return accounts.map(a => `<tr class="a-row" data-href="#account/${encodeURIComponent(a.id)}">
    <th scope="row"><a class="a-link" href="#account/${encodeURIComponent(a.id)}">${esc(a.company || '(no company)')}</a></th>
    <td class="a-email">${esc(a.email)}</td><td>${esc(roleText(a.role))}</td><td>${kybPill(a.kyb)}</td><td>${stagePill(a.stage)}</td>
    <td class="r d-num">${esc(a.ordersCount ?? 0)}</td><td class="r d-num">${money(a.premiumsPaid ?? 0)}</td>
    <td>${esc(stamp(a.lastActiveAt))}</td><td>${esc(day(a.createdAt))}</td></tr>`);
}

export function accountFilters(filters) {
  return `<form class="a-filters" id="a-filters" role="search" aria-label="Filter accounts">
    <div class="field a-search"><label for="a-q">Search</label><input id="a-q" name="q" type="search" value="${esc(filters.q || '')}" placeholder="Company or email" autocomplete="off"></div>
    <div class="field"><label for="a-f-role">Role</label><select id="a-f-role" name="role">${options(ROLES, filters.role, { any: 'Any role', text: roleText })}</select></div>
    <div class="field"><label for="a-f-stage">Stage</label><select id="a-f-stage" name="stage">${options(STAGES, filters.stage, { any: 'Any stage' })}</select></div>
    <div class="field"><label for="a-f-kyb">KYB</label><select id="a-f-kyb" name="kyb">${options(KYBS, filters.kyb, { any: 'Any KYB' })}</select></div>
  </form>`;
}

export function createForm() {
  return `<form class="d-form a-create" id="a-create" novalidate>
    <div class="field"><label for="a-c-email">Email</label><input id="a-c-email" name="email" type="email" required autocomplete="off" placeholder="name@company.com"></div>
    <div class="field"><label for="a-c-company">Company</label><input id="a-c-company" name="company" required maxlength="120" autocomplete="off"></div>
    <div class="field"><label for="a-c-password">Password</label><input id="a-c-password" name="password" type="text" required minlength="8" maxlength="128" autocomplete="off" placeholder="8 characters or more"></div>
    <div class="field"><label for="a-c-role">Role</label><select id="a-c-role" name="role">${options(['buyer', 'lender', 'provider'], 'buyer', { text: roleText })}</select></div>
    <div class="field"><label for="a-c-stage">Stage</label><select id="a-c-stage" name="stage">${options(STAGES, 'demo')}</select></div>
    <div class="field"><label for="a-c-kyb">KYB</label><select id="a-c-kyb" name="kyb">${options(KYBS, 'pending')}</select></div>
    <div class="a-form-acts"><button type="submit" class="btn btn-primary">${icon('user-plus')}<span>Create account</span></button><button type="button" class="btn" data-act="create-close">${icon('x')}<span>Cancel</span></button></div>
    <p class="fine a-form-msg" id="a-create-msg" role="alert"></p>
    <p class="fine">Any email works and nothing is sent to it. Share the password with whoever uses the login in the meeting.</p>
  </form>`;
}

export const orderHeads = withAccount => ['Order', ...(withAccount ? ['Account'] : []), 'Status', 'Contract', 'Neocloud', 'Window', ['Strike'], ['Paid'], ['Net result'], 'Neocloud messages'];
const accountCell = o => {
  const id = o.account?.id ?? o.accountId;
  return `<td>${id ? `<a class="a-link" href="#account/${encodeURIComponent(id)}">${esc(o.account?.company || o.account?.email || id)}</a>` : '—'}</td>`;
};
export function orderRows(orders, { withAccount = false } = {}) {
  return orders.map(o => `<tr>
    <th scope="row"><span class="d-mono">${esc(o.ref)}</span></th>
    ${withAccount ? accountCell(o) : ''}
    <td>${statusPill(o.status)}</td><td>${esc(kindText(o.kind))} · ${esc(o.gpu ?? '')} × ${esc(o.count ?? '')}</td><td>${esc(o.neocloud?.name || '—')}</td>
    <td>${esc(windowText(o.start, o.end))}</td><td class="r d-num">${esc(perHour(o.strike))}</td>
    <td class="r d-num">${money(o.payNow ?? o.premiumTotal)}</td>
    <td class="r d-num ${toneOf(o.settlement?.netResult)}">${o.settlement ? money(o.settlement.netResult) : '—'}</td>
    <td><button type="button" class="btn btn-sm" data-act="order-events" data-ref="${esc(o.ref)}">${icon('activity')}<span>Events</span></button></td></tr>`);
}

export const EVENT_HEADS = ['Time', 'Type', 'Direction', 'Order', ['HTTP'], 'Details'];
const directionText = d => (d === 'dodona_to_neocloud' ? 'Dodona to neocloud' : d === 'neocloud_to_dodona' ? 'Neocloud to Dodona' : 'Internal');
export function eventRows(events) {
  return events.map(e => `<tr>
    <td>${esc(stamp(e.at))}</td><td><span class="d-mono">${esc(e.type)}</span></td><td>${esc(directionText(e.direction))}</td>
    <td class="d-mono">${esc(e.orderRef || '—')}</td><td class="r d-num">${esc(e.httpStatus ?? '—')}</td>
    <td><details class="a-payload"><summary>Payload</summary><pre>${esc(JSON.stringify(e.payload ?? {}, null, 2))}</pre></details></td></tr>`);
}

export function notesList(notes) {
  if (!notes.length) return '<p class="d-muted a-notes-empty">No notes yet. Add the first one below.</p>';
  return `<ol class="a-notes">${notes.map(n => `<li><div class="a-note-meta"><b>${esc(n.author || 'admin')}</b><span>${esc(stamp(n.createdAt))}</span></div><p>${esc(n.text)}</p></li>`).join('')}</ol>`;
}

export function noteForm() {
  return `<form class="a-note-form" id="a-note-form" novalidate>
    <div class="field"><label for="a-note-text">Add a note</label><textarea id="a-note-text" name="text" maxlength="2000" rows="3" placeholder="What happened in the meeting, next steps, who to follow up with"></textarea></div>
    <div class="a-form-acts"><button type="submit" class="btn btn-primary">${icon('plus')}<span>Add note</span></button><span class="fine a-form-msg" id="a-note-msg" role="alert"></span></div>
  </form>`;
}

export function contactCard(a) {
  return `<form class="a-contact" id="a-contact" novalidate>
    <dl class="d-kv">
      <div><dt>Email</dt><dd>${esc(a.email)}</dd></div>
      <div><dt>Role</dt><dd>${esc(roleText(a.role))}</dd></div>
      <div><dt>Created</dt><dd>${esc(stamp(a.createdAt))}</dd></div>
      <div><dt>Last active</dt><dd>${esc(stamp(a.lastActiveAt))}</dd></div>
    </dl>
    <div class="a-contact-fields">
      <div class="field"><label for="a-e-company">Company</label><input id="a-e-company" name="company" maxlength="120" value="${esc(a.company || '')}"></div>
      <div class="field"><label for="a-e-phone">Phone</label><input id="a-e-phone" name="phone" type="tel" maxlength="40" value="${esc(a.phone || '')}" placeholder="Not recorded"></div>
      <div class="field"><label for="a-e-kyb">KYB</label><select id="a-e-kyb" name="kyb">${options(KYBS, a.kyb)}</select></div>
      <div class="field"><label for="a-e-stage">Stage</label><select id="a-e-stage" name="stage">${options(STAGES, a.stage)}</select></div>
    </div>
    <div class="a-form-acts"><button type="submit" class="btn btn-primary">${icon('check')}<span>Save changes</span></button><span class="fine a-form-msg" id="a-contact-msg" role="alert"></span></div>
  </form>`;
}

export function clockCard(a, confirming) {
  const reset = confirming
    ? `<div class="a-confirm" role="group" aria-label="Confirm reset"><span>Reset ${esc(a.company || a.email)}?</span><button type="button" class="btn btn-primary" data-act="reset-confirm">${icon('rotate-ccw')}<span>Yes, reset it</span></button><button type="button" class="btn" data-act="reset-cancel">${icon('x')}<span>Keep it</span></button></div>`
    : `<button type="button" class="btn" data-act="reset">${icon('rotate-ccw')}<span>Reset this demo account</span></button>`;
  return `<dl class="d-kv">
      <div><dt>Demo date</dt><dd>${esc(stamp(a.demoNow))}</dd></div>
      <div><dt>Scenario</dt><dd>${esc(label(a.scenario || 'market'))}</dd></div>
    </dl>
    <div class="c-ctr-b a-clock-acts"><p class="fine">Reset reseeds this account: orders, index prints, emails and its demo clock go back to the starting state. Notes stay.</p>${reset}</div>`;
}

export function capacityTable(n) {
  const rows = (n.capacity || []).map(c => `<tr><th scope="row">${esc(c.gpu)}</th><td>${esc(c.region)}</td><td class="r d-num">${esc(c.total)}</td><td class="r d-num">${esc(c.reserved ?? 0)}</td><td class="r d-num">${esc(c.free ?? c.total - (c.reserved ?? 0))}</td></tr>`);
  return table(`${n.name} capacity`, ['GPU', 'Region', ['Total'], ['Reserved'], ['Free']], rows, 'No capacity recorded.');
}

export function neocloudCard(n) {
  if (!n) return '';
  return `<dl class="d-kv"><div><dt>Neocloud</dt><dd>${esc(n.name)}</dd></div><div><dt>Auto-confirm</dt><dd>${n.autoConfirm === false ? 'Off' : 'On'}</dd></div></dl>${capacityTable(n)}`;
}

// One neocloud: who runs it, its capacity pools, and the contracts written on it (orders across every account).
export function neocloudBlock(n, orders = []) {
  const counts = n.contracts || {};
  const tally = `<div class="a-pills">${pill('layers', 'neutral', `${counts.caps ?? 0} caps`)}${pill('layers', 'neutral', `${counts.floors ?? 0} floors`)}${pill('layers', 'neutral', `${counts.locks ?? 0} locks`)}</div>`;
  const rows = orders.map(o => `<tr><th scope="row" class="d-mono">${esc(o.ref)}</th>${accountCell(o)}<td>${statusPill(o.status)}</td><td>${esc(kindText(o.kind))} · ${esc(o.gpu)} × ${esc(o.count)}</td><td>${esc(windowText(o.start, o.end))}</td><td class="r d-num">${esc(perHour(o.strike))}</td><td class="r d-num">${money(o.premiumTotal)}</td></tr>`);
  return container({
    id: `a-nc-${String(n.id).replace(/[^a-z0-9_-]/gi, '')}`, title: n.name, iconName: 'server', count: `${(n.capacity || []).length} pools`,
    desc: `${n.ownerEmail ? `Provider login ${n.ownerEmail}` : 'Supplies offers, no login'} · ${(n.regions || []).join(', ') || 'no regions'} · auto-confirm ${n.autoConfirm === false ? 'off' : 'on'}`,
    body: `${tally}<h3 class="a-sub">Capacity now</h3>${capacityTable(n)}<h3 class="a-sub">Contracts</h3>${table(`${n.name} contracts`, ['Order', 'Account', 'Status', 'Contract', 'Window', ['Strike'], ['Premium']], rows, 'No contracts on this neocloud yet.')}`,
  });
}

export const PAYMENT_HEADS = ['Time', 'Order', ['Amount'], 'Status', 'Card'];
export function paymentRows(payments) {
  return payments.map(p => `<tr><td>${esc(stamp(p.createdAt ?? p.at))}</td><td class="d-mono">${esc(p.orderRef)}</td><td class="r d-num">${money(p.amount)}</td><td>${statusPill(p.status)}${p.code ? ` <span class="d-muted">${esc(words(p.code))}</span>` : ''}</td><td>${esc(p.brand ? `${p.brand} ending ${p.last4}` : '—')}</td></tr>`);
}

export const PAYOUT_HEADS = ['Order', 'Flow', ['Amount'], 'Status', 'Due', 'Paid'];
export function payoutRows(payouts) {
  return payouts.map(p => `<tr><td class="d-mono">${esc(p.orderRef)}</td><td>${esc(DIRECTION_TEXT[p.direction] || words(p.direction))}</td><td class="r d-num">${money(p.amount)}</td><td>${statusPill(p.status)}</td><td>${esc(day(p.dueAt))}</td><td>${esc(day(p.paidAt))}</td></tr>`);
}

export const EMAIL_HEADS = ['Sent', 'To', 'Subject', 'Order'];
export function emailRows(emails) {
  return emails.map(e => `<tr><td>${esc(stamp(e.at))}</td><td>${esc(e.to)}</td><td><details class="a-payload"><summary>${esc(e.subject)}</summary><pre>${esc(e.body || '')}</pre></details></td><td class="d-mono">${esc(e.orderRef || '—')}</td></tr>`);
}

function syncStatus(s) {
  const result = s.lastResult;
  const state = !s.configured ? pill('info', 'neutral', 'Not configured') : result && !result.ok ? pill('circle-x', 'error', 'Last run failed') : pill('circle-check', 'success', 'Mirroring');
  const counts = Object.entries(s.tables || {}).map(([name, n]) => `<tr><th scope="row">${esc(label(name))}</th><td class="r d-num">${n == null ? '—' : esc(n)}</td><td class="r d-num">${esc(result?.pushed?.[name] ?? '—')}</td></tr>`);
  return container({
    id: 'a-sync-state', title: 'Mirror status', iconName: 'database', span: 'c-s7',
    desc: 'The demo database is the source of truth. The mirror copies the CRM tables to your Supabase project.',
    acts: `<button type="button" class="btn btn-primary" data-act="sync-now">${icon('refresh-cw')}<span>Sync now</span></button>`,
    body: `<dl class="d-kv">
        <div><dt>State</dt><dd>${state}</dd></div>
        <div><dt>Runs</dt><dd>${s.configured ? `Every ${esc(s.intervalSeconds || 60)} seconds and on Sync now` : 'Off until configured'}</dd></div>
        <div><dt>Last run</dt><dd>${esc(s.lastRunAt ? stamp(s.lastRunAt) : 'Never')}</dd></div>
        <div><dt>Last result</dt><dd>${esc(result ? result.message : 'No run yet')}</dd></div>
      </dl>
      <p class="a-sync-msg" id="a-sync-msg" role="status" hidden></p>
      ${table('Rows per table', ['Table', ['Rows in the demo database'], ['Sent in the last run']], counts, 'No tables.')}`,
    foot: 'Password hashes, session tokens and card details are never sent. Payments go across as amount and outcome only.',
  });
}

function syncSteps(s) {
  return container({
    id: 'a-sync-steps', title: 'Set it up', iconName: 'info', span: 'c-s5', desc: 'About ten minutes, once.',
    body: `<ol class="a-steps">
        <li>Create a Supabase project at supabase.com, or open the one the signup form already uses.</li>
        <li>Open the SQL editor, paste the file <code>supabase/demo-crm.sql</code> from this repository and run it. It creates six tables with row level security on and no public access.</li>
        <li>In the project's API settings, copy the project URL and the service role key. The key is a server secret: never share it or put it in a browser.</li>
        <li>Add three lines to the server's environment: <code>SUPABASE_URL</code>, <code>SUPABASE_SERVICE_ROLE_KEY</code> and <code>DEMO_SUPABASE_MIRROR=1</code>.</li>
        <li>On the live site the demo platform also needs <code>DEMO_PLATFORM=1</code> and <code>DEMO_SEED_PASSWORD</code> (12 characters or more), which becomes the password of the seeded demo logins.</li>
        <li>Restart the server. This panel then shows "Mirroring", and Supabase's Table editor shows the demo accounts within a minute.</li>
      </ol>
      ${s.missing?.length ? `<p class="fine c-ctr-foot">Missing now: ${s.missing.map(m => `<code>${esc(m)}</code>`).join(', ')}.</p>` : ''}
      ${s.invalid ? `<p class="fine c-ctr-foot is-loss">${esc(s.invalid)}</p>` : ''}`,
  });
}

export const syncPanel = s => `<div class="c-grid">${syncStatus(s)}${syncSteps(s)}</div>`;

// --- activity log (feature/activity) ---
// Kind chips map to the API's kind filter; "Pages" covers server page loads and in-page views.
export const ACTIVITY_CHIPS = [['', 'All'], ['page,nav', 'Pages'], ['click', 'Clicks'], ['api', 'API calls'], ['error', 'Errors'], ['auth', 'Sign-ins']];
const KIND_LOOK = {
  page: ['file-text', 'neutral', 'Page'], nav: ['compass', 'neutral', 'View'], click: ['mouse-pointer-click', 'info', 'Click'],
  api: ['plug', 'neutral', 'API'], error: ['triangle-alert', 'error', 'Error'], auth: ['log-in', 'info', 'Sign-in'],
};
export const ACTIVITY_HEADS = ['Time', 'Kind', 'What happened', 'Result', 'Detail'];
export const FAILURE_HEADS = ['Time', 'Account', 'Kind', 'What happened', 'Result', 'Detail'];
const AUTH_WORDS = { '/api/auth/sign-in': 'Signed in', '/api/auth/sign-out': 'Signed out', '/api/auth/sign-up': 'Signed up' };

// One plain sentence per row, e.g. "Clicked Pay now on /checkout" or "POST /api/orders/DOD-ABC/pay 402 card_declined".
export function activityText(row) {
  const d = row.detail || {};
  const at = row.page ? ` on ${row.page}` : '';
  if (row.kind === 'click') return `Clicked ${row.target || d.act || d.nav || 'an element'}${at}`;
  if (row.kind === 'nav') return `Viewed ${row.page || 'a page'}`;
  if (row.kind === 'page') return `Opened ${row.page || 'a page'}${d.status && d.status !== 200 ? ` (${d.status})` : ''}`;
  if (row.kind === 'error') return `Script error: ${d.message || 'unknown'}${d.source ? ` in ${d.source}${d.line ? `:${d.line}` : ''}` : ''}${at}`;
  if (row.kind === 'auth') {
    const base = AUTH_WORDS[(d.path || '').split('?')[0]] || 'Account';
    return row.ok ? base : `${base === 'Signed in' ? 'Sign-in' : base} failed: ${d.message || d.code || d.status}`;
  }
  const call = `${d.method || ''} ${d.path || row.page || ''} ${d.status ?? ''}`.trim();
  return row.ok ? `${call} in ${d.ms ?? 0} ms` : `${call} ${d.code || ''}`.trim();
}

export const kindPill = kind => pill(...(KIND_LOOK[kind] || ['info', 'neutral', label(kind)]));
export const resultPill = row => (row.ok ? pill('circle-check', 'success', 'OK') : pill('circle-x', 'error', row.detail?.code ? `Failed · ${words(row.detail.code)}` : 'Failed'));
const rawDetail = row => `<details class="a-payload"><summary>Raw</summary><pre>${esc(JSON.stringify({ at: row.at, kind: row.kind, page: row.page, target: row.target, session: row.sessionId, detail: row.detail }, null, 2))}</pre></details>`;
const timeCell = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '—' : `${day(iso)}, ${d.toISOString().slice(11, 19)} UTC`; };

export function activityRows(rows) {
  return rows.map(r => `<tr class="${r.ok ? '' : 'a-act-fail'}"><td class="d-num">${esc(timeCell(r.at))}</td><td>${kindPill(r.kind)}</td>
    <td class="a-act-what">${esc(activityText(r))}</td><td>${resultPill(r)}</td><td>${rawDetail(r)}</td></tr>`);
}

export function failureRows(rows) {
  return rows.map(r => `<tr><td class="d-num">${esc(timeCell(r.at))}</td>
    <td>${r.account ? `<a class="a-link" href="#account/${encodeURIComponent(r.account.id)}">${esc(r.account.company || r.account.email)}</a>` : '—'}</td>
    <td>${kindPill(r.kind)}</td><td class="a-act-what">${esc(activityText(r))}</td><td>${resultPill(r)}</td><td>${rawDetail(r)}</td></tr>`);
}

export function activityFilters(f) {
  const chips = ACTIVITY_CHIPS.map(([kind, text]) => `<button type="button" data-act="act-kind" data-kind="${esc(kind)}" aria-pressed="${kind === f.kind}">${esc(text)}</button>`).join('');
  return `<form class="a-act-filters" id="a-act-filters" role="search" aria-label="Filter the activity log">
    <div class="a-act-chips"><div class="d-seg a-seg" role="group" aria-label="Kind">${chips}</div>
      <div class="d-seg" role="group" aria-label="Result"><button type="button" data-act="act-failed" aria-pressed="${Boolean(f.failed)}">${icon('triangle-alert')}<span>Only failures</span></button></div></div>
    <div class="a-act-fields">
      <div class="field a-search"><label for="a-act-q">Search</label><input id="a-act-q" name="q" type="search" value="${esc(f.q || '')}" placeholder="Button, page, path or error code" autocomplete="off"></div>
      <div class="field"><label for="a-act-since">Since (UTC)</label><input id="a-act-since" name="since" type="datetime-local" value="${esc(f.since || '')}"></div>
      <div class="field"><label for="a-act-until">Until (UTC)</label><input id="a-act-until" name="until" type="datetime-local" value="${esc(f.until || '')}"></div>
    </div>
  </form>`;
}

export function activityPanel(f) {
  return container({
    id: 'a-d-activity', title: 'Activity log', iconName: 'activity',
    desc: 'What this account opened, clicked and called, and what failed. Newest first. Input values and card details are never recorded.',
    acts: `<a class="btn btn-sm" id="a-act-csv" href="#" download>${icon('download')}<span>Export CSV</span></a>`,
    body: `<div class="c-ctr-b a-filter-bar">${activityFilters(f)}</div>
      <div class="a-tall a-act-list">${table('Activity log', ACTIVITY_HEADS, [`<tr><td colspan="${ACTIVITY_HEADS.length}" class="d-empty">Loading the activity log…</td></tr>`], '').replace('<tbody>', '<tbody id="a-act-rows">')}</div>
      <div class="c-ctr-b a-act-more"><span class="fine" id="a-act-count" role="status"></span><button type="button" class="btn btn-sm" data-act="act-more" id="a-act-more" hidden>${icon('chevron-down')}<span>Load more</span></button></div>`,
  });
}
// --- end activity log ---

/** Admin portal API: a small CRM over every demo account, their orders, payments, payouts, emails and events. Queries stay thin. */
import { all, get, insert, update, newId } from './db.mjs';
import { accountView, createAccount, hashPassword, parseSignUp, ROLES } from './auth.mjs';
import { orderView, PAID_STATUSES, STATUSES } from './orders.mjs';
import { capacityOf, eventView, neocloudView } from './neocloud.mjs';
import { emailView } from './outbox.mjs';
import { reseedAccount } from './seed.mjs';
import { settleAccount } from './clock.mjs';
import { toCsv } from './settlement.mjs';
import { route, ADMIN } from './route.mjs';
import { invalid, notFound, oneOf, onlyKeys, text, roundCents } from './validate.mjs';

export const KYB = Object.freeze(['pending', 'verified', 'rejected']);
export const STAGES = Object.freeze(['lead', 'demo', 'kyb', 'active', 'churned']);
const inList = list => list.map(() => '?').join(',');
const payoutView = row => ({ id: row.id, orderRef: row.order_ref, direction: row.direction, amount: row.amount, status: row.status, dueAt: row.due_at, paidAt: row.paid_at });
const paymentView = row => ({ id: row.id, orderRef: row.order_ref, amount: row.amount, brand: row.brand, last4: row.last4, status: row.status, code: row.code, at: row.at });
const noteView = row => ({ id: row.id, accountId: row.account_id, author: row.author, text: row.text, createdAt: row.created_at });

function summary(db, row) {
  const totals = get(db, `SELECT COUNT(*) AS n, COALESCE(SUM(premium_total), 0) AS premiums FROM orders WHERE account_id = ? AND status IN (${inList(PAID_STATUSES)})`, row.id, ...PAID_STATUSES);
  return { id: row.id, email: row.email, company: row.company, role: row.role, kyb: row.kyb, stage: row.stage, phone: row.phone, ordersCount: totals.n, premiumsPaid: roundCents(totals.premiums), lastActiveAt: row.last_active_at, createdAt: row.created_at };
}

export function listAccounts(db, params) {
  const q = (params.get('q') || '').trim().toLowerCase().slice(0, 100);
  const filters = { role: params.get('role'), stage: params.get('stage'), kyb: params.get('kyb') };
  return all(db, 'SELECT * FROM accounts ORDER BY created_at DESC, email')
    .filter(row => (!q || row.email.includes(q) || row.company.toLowerCase().includes(q)) && Object.entries(filters).every(([key, value]) => !value || row[key] === value))
    .map(row => summary(db, row));
}

export const accountsCsv = accounts => toCsv(['id', 'email', 'company', 'role', 'kyb', 'stage', 'phone', 'ordersCount', 'premiumsPaid', 'lastActiveAt', 'createdAt'],
  accounts.map(a => [a.id, a.email, a.company, a.role, a.kyb, a.stage, a.phone, a.ordersCount, a.premiumsPaid.toFixed(2), a.lastActiveAt ?? '', a.createdAt]));

function loadAccount(db, id) {
  const row = get(db, 'SELECT * FROM accounts WHERE id = ?', id);
  if (!row) throw notFound('No account with that id.');
  return row;
}

export function accountDetail(db, id) {
  const row = loadAccount(db, id);
  const nc = row.neocloud_id ? get(db, 'SELECT * FROM neoclouds WHERE id = ?', row.neocloud_id) : null;
  return {
    account: { ...accountView(db, row), ...summary(db, row) },
    notes: all(db, 'SELECT * FROM notes WHERE account_id = ? ORDER BY created_at DESC', id).map(noteView),
    orders: all(db, 'SELECT * FROM orders WHERE account_id = ? ORDER BY ordered_at DESC', id).map(o => orderView(db, o)),
    payments: all(db, 'SELECT * FROM payments WHERE account_id = ? ORDER BY at DESC', id).map(paymentView),
    payouts: all(db, 'SELECT * FROM payouts WHERE account_id = ? ORDER BY due_at DESC', id).map(payoutView),
    emails: all(db, 'SELECT * FROM emails WHERE account_id = ? ORDER BY at DESC, seq DESC', id).map(emailView),
    events: all(db, 'SELECT * FROM events WHERE account_id = ? OR (neocloud_id IS NOT NULL AND neocloud_id = ?) ORDER BY seq DESC LIMIT 200', id, row.neocloud_id).map(eventView),
    neocloud: nc ? { ...neocloudView(nc), capacity: capacityOf(db, nc.id, row.demo_now) } : null,
  };
}

export function updateAccount(db, id, body, at) {
  onlyKeys(body, ['kyb', 'stage', 'phone', 'company']);
  loadAccount(db, id);
  const fields = {};
  if (body.kyb !== undefined) fields.kyb = oneOf(body.kyb, KYB, 'KYB');
  if (body.stage !== undefined) fields.stage = oneOf(body.stage, STAGES, 'Stage');
  if (body.phone !== undefined) {
    fields.phone = text(body.phone, 'Phone', { min: 0, max: 40 });
    if (fields.phone && !/^[+\d][\d ()./-]{3,39}$/.test(fields.phone)) throw invalid('Enter a phone number with digits, spaces and + ( ) - only.');
  }
  if (body.company !== undefined) fields.company = text(body.company, 'Company', { max: 80 });
  if (!Object.keys(fields).length) throw invalid('Send at least one of kyb, stage, phone or company.');
  update(db, 'accounts', { id }, fields, at);
  return accountDetail(db, id).account;
}

export function addNote(db, id, author, body, at) {
  onlyKeys(body, ['text']);
  loadAccount(db, id);
  const row = { id: newId('note'), account_id: id, author, text: text(body.text, 'Note', { max: 2000 }) };
  insert(db, 'notes', row, at);
  return noteView({ ...row, created_at: at });
}

/** Admin-made demo logins for a meeting: sign-up fields plus stage, KYB and phone. */
export async function adminCreateAccount(db, body, at) {
  onlyKeys(body, ['email', 'password', 'company', 'role', 'stage', 'kyb', 'phone']);
  const input = parseSignUp(body, ROLES.filter(role => role !== 'admin'));
  const extra = { stage: body.stage === undefined ? 'demo' : oneOf(body.stage, STAGES, 'Stage'), kyb: body.kyb === undefined ? 'pending' : oneOf(body.kyb, KYB, 'KYB'), phone: body.phone === undefined ? '' : text(body.phone, 'Phone', { min: 0, max: 40 }) };
  const row = createAccount(db, { ...input, ...extra, passwordHash: await hashPassword(input.password), at });
  return summary(db, row);
}

export function adminOrders(db, status) {
  if (status) oneOf(status, STATUSES, 'Status');
  const rows = status ? all(db, 'SELECT * FROM orders WHERE status = ? ORDER BY ordered_at DESC', status) : all(db, 'SELECT * FROM orders ORDER BY ordered_at DESC');
  return rows.map(row => {
    const owner = get(db, 'SELECT email, company FROM accounts WHERE id = ?', row.account_id);
    return { ...orderView(db, row), account: { id: row.account_id, email: owner.email, company: owner.company } };
  });
}

export function neoclouds(db, nowIso) {
  return all(db, 'SELECT * FROM neoclouds ORDER BY name').map(nc => {
    const counts = Object.fromEntries(all(db, `SELECT kind, COUNT(*) AS n FROM orders WHERE neocloud_id = ? AND status IN (${inList(PAID_STATUSES)}) GROUP BY kind`, nc.id, ...PAID_STATUSES).map(r => [r.kind, r.n]));
    const owner = nc.owner_account_id ? get(db, 'SELECT email FROM accounts WHERE id = ?', nc.owner_account_id)?.email ?? null : null;
    return { ...neocloudView(nc), ownerEmail: owner, capacity: capacityOf(db, nc.id, nowIso), contracts: { caps: counts.cap || 0, floors: counts.floor || 0, locks: counts.lock || 0 } };
  });
}

/** The Supabase mirror status; the admin builder wires `mirror` ({ status(), runNow() }) in lib/crm-mirror.mjs. */
function syncStatus(db, mirror) {
  const tables = Object.fromEntries(['accounts', 'notes', 'orders', 'payments'].map(t => [t, get(db, `SELECT COUNT(*) AS n FROM ${t}`).n]));
  const status = mirror?.status?.() ?? { configured: false, lastRunAt: null, lastResult: null };
  return { ...status, tables };
}

export function adminRoutes({ now, prices, mirror }) {
  const opts = { roles: ADMIN };
  const at = () => new Date(now()).toISOString();
  return [
    route('GET', '/api/admin/accounts', ({ db, url }) => ({ body: { accounts: listAccounts(db, url.searchParams) } }), opts),
    route('POST', '/api/admin/accounts', async ({ db, body }) => ({ status: 201, body: { account: await adminCreateAccount(db, body, at()) } }), { ...opts, body: true }),
    route('GET', '/api/admin/accounts.csv', ({ db, url }) => ({ raw: accountsCsv(listAccounts(db, url.searchParams)), headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="dodona-demo-accounts.csv"' } }), opts),
    route('GET', '/api/admin/accounts/:id', ({ db, params }) => ({ body: accountDetail(db, params.id) }), opts),
    route('POST', '/api/admin/accounts/:id', ({ db, params, body }) => ({ body: { account: updateAccount(db, params.id, body, at()) } }), { ...opts, body: true }),
    route('POST', '/api/admin/accounts/:id/notes', ({ db, params, body, account }) => ({ status: 201, body: { note: addNote(db, params.id, account.email, body, at()) } }), { ...opts, body: true }),
    route('POST', '/api/admin/accounts/:id/reset', async ({ db, params }) => {
      const history = await prices();
      const row = reseedAccount(db, loadAccount(db, params.id), { nowMs: now(), settle: (acc, to) => settleAccount(db, acc, to, history) });
      return { body: { account: accountView(db, row) } };
    }, opts),
    route('GET', '/api/admin/orders', ({ db, url }) => ({ body: { orders: adminOrders(db, url.searchParams.get('status')) } }), opts),
    route('GET', '/api/admin/neoclouds', ({ db }) => ({ body: { neoclouds: neoclouds(db, at()) } }), opts),
    route('GET', '/api/admin/events', ({ db, url }) => {
      const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') || '100', 10) || 100, 1), 500);
      return { body: { events: all(db, 'SELECT * FROM events ORDER BY seq DESC LIMIT ?', limit).map(row => ({ ...eventView(row), accountId: row.account_id, neocloudId: row.neocloud_id })) } };
    }, opts),
    route('GET', '/api/admin/sync', ({ db }) => ({ body: syncStatus(db, mirror) }), opts),
    route('POST', '/api/admin/sync', async ({ db }) => {
      if (!mirror?.runNow) return { body: { ...syncStatus(db, mirror), message: 'The Supabase mirror is not configured. Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and DEMO_SUPABASE_MIRROR=1, then restart.' } };
      await mirror.runNow();
      return { body: syncStatus(db, mirror) };
    }, opts),
  ];
}

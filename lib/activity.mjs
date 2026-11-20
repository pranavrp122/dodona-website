/**
 * Per-account activity log for the demo platform: the pages an account opened, what it clicked, the API calls it made and
 * what failed, so the founders can follow a demo session. It never stores request bodies, input values or card data.
 */
import { createHash } from 'node:crypto';
import { all, get, transaction } from './db.mjs';
import { toCsv } from './settlement.mjs';
import { route, ADMIN } from './route.mjs';
import { invalid, notFound } from './validate.mjs';

export const KINDS = Object.freeze(['page', 'click', 'nav', 'api', 'error', 'auth']);
const CLIENT_KINDS = Object.freeze(['click', 'nav', 'error']);
export const ACCOUNT_CAP = 5000;
export const MAX_BATCH = 50;
export const MAX_EVENT_BYTES = 1024;
const MAX_PAGE = 200;
const MAX_TARGET = 120;
const MAX_DETAIL = 2048;
const MAX_TEXT = 300;
const PAGE_SIZE = 100;
const MAX_FAILURES = 200;
const BATCH_BODY_BYTES = 64 * 1024;
// Client timestamps are kept only when they fall in the last few minutes; anything else gets the server's time.
const CLIENT_SKEW_MS = 15 * 60 * 1000;
const CLIENT_AHEAD_MS = 5000;
// Twelve or more digits in a row (spaces or dashes allowed between them) look like a card or account number.
const DIGIT_RUN = /\d(?:[ -]?\d){11,}/g;
const CONTROL = /[\x00-\x1f\x7f]/g;
const DETAIL_KEYS = Object.freeze({ click: ['tag', 'act', 'nav', 'id', 'href'], nav: ['from'], error: ['message', 'source', 'line', 'col'] });
const AUTH_TEXT = Object.freeze({ bad_credentials: 'wrong password', rate_limited: 'rate limited' });
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z?$/;

/** Plain text for the log: control characters out, long digit runs masked, trimmed to `max`. */
export const scrub = (value, max = MAX_TEXT) => String(value ?? '').replace(CONTROL, ' ').replace(DIGIT_RUN, '[number removed]').trim().slice(0, max);

/** A path with its query values removed (keys kept) and the hash kept, e.g. /api/offers?gpu&kind. */
export function cleanPath(raw, max = MAX_PAGE) {
  const text = String(raw ?? '');
  const hashAt = text.indexOf('#');
  const base = hashAt >= 0 ? text.slice(0, hashAt) : text;
  const hash = hashAt >= 0 ? text.slice(hashAt) : '';
  const queryAt = base.indexOf('?');
  const path = queryAt >= 0 ? base.slice(0, queryAt) : base;
  const keys = queryAt >= 0 ? [...new Set(new URLSearchParams(base.slice(queryAt + 1)).keys())] : [];
  return scrub(`${path}${keys.length ? `?${keys.map(encodeURIComponent).join('&')}` : ''}${hash}`, max);
}

/** The first eight characters of the session token's hash: enough to tell sessions apart, useless as a credential. */
export const sessionTag = token => (token ? createHash('sha256').update(token).digest('hex').slice(0, 8) : null);

function detailText(detail) {
  const text = JSON.stringify(detail || {}, (key, value) => (typeof value === 'string' ? scrub(value) : value));
  return text.length > MAX_DETAIL ? JSON.stringify({ truncated: true }) : text;
}

/** Inserts one row, then trims the account's log to its newest ACCOUNT_CAP rows. */
export function recordActivity(db, { accountId = null, sessionId = null, at, kind, page = '', target = null, detail = {}, ok = true }) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown activity kind ${kind}.`);
  db.prepare('INSERT INTO activity (account_id, session_id, at, kind, page, target, detail, ok, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(accountId, sessionId, at, kind, cleanPath(page), target == null ? null : scrub(target, MAX_TARGET), detailText(detail), ok ? 1 : 0, new Date().toISOString());
  if (accountId) {
    db.prepare('DELETE FROM activity WHERE account_id = ? AND id IN (SELECT id FROM activity WHERE account_id = ? ORDER BY at DESC, id DESC LIMIT -1 OFFSET ?)').run(accountId, accountId, ACCOUNT_CAP);
  }
}

/** The server-side row for one platform API call or page view, built from what the response already said. */
export function requestRow({ method, pathname, search, status, ms, error, page }) {
  const path = cleanPath(`${pathname}${search || ''}`);
  if (page) return { kind: 'page', page: path, target: null, detail: { status }, ok: status < 400 };
  const auth = pathname.startsWith('/api/auth/');
  const detail = { method, path, status, ms: Math.max(0, Math.round(ms)) };
  if (status >= 400) {
    detail.code = error?.code || `http_${status}`;
    detail.message = auth ? AUTH_TEXT[error?.code] || error?.message || '' : error?.message || '';
  }
  return { kind: auth ? 'auth' : 'api', page: path, target: null, detail, ok: status < 400 };
}

function clientTime(value, nowMs) {
  const ms = typeof value === 'string' && value.length <= 40 ? Date.parse(value) : NaN;
  const usable = Number.isFinite(ms) && ms <= nowMs + CLIENT_AHEAD_MS && ms >= nowMs - CLIENT_SKEW_MS;
  return new Date(usable ? Math.min(ms, nowMs) : nowMs).toISOString();
}

// Every detail field is a short string, except an error's line and column numbers. Unknown keys reject the event.
function clientDetail(kind, raw) {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!DETAIL_KEYS[kind].includes(key)) return null;
    if (key === 'line' || key === 'col') {
      if (!Number.isInteger(value) || value < 0 || value > 1e7) return null;
      out[key] = value;
      continue;
    }
    if (typeof value !== 'string' || value.length > MAX_TEXT) return null;
    if (key === 'tag' && !/^[a-z][a-z0-9-]{0,19}$/.test(value)) return null;
    out[key] = ['source', 'href', 'from'].includes(key) ? cleanPath(value.replace(/^https?:\/\/[^/]+/i, '')) : scrub(value);
  }
  return out;
}

/** One validated browser event, or null when anything about it is malformed or oversize. */
export function clientEvent(raw, nowMs) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (Buffer.byteLength(JSON.stringify(raw)) > MAX_EVENT_BYTES) return null;
  if (Object.keys(raw).some(key => !['kind', 'page', 'target', 'detail', 'at'].includes(key)) || !CLIENT_KINDS.includes(raw.kind)) return null;
  if (typeof raw.page !== 'string' || !raw.page.startsWith('/') || raw.page.length > MAX_PAGE) return null;
  if (raw.target != null && (typeof raw.target !== 'string' || raw.target.length > MAX_TARGET)) return null;
  const detail = clientDetail(raw.kind, raw.detail);
  if (!detail) return null;
  return { kind: raw.kind, page: raw.page, target: raw.target ?? null, detail, ok: raw.kind !== 'error', at: clientTime(raw.at, nowMs) };
}

function parseDetail(text) {
  try { return JSON.parse(text || '{}'); } catch { return {}; }
}

export const activityView = row => ({
  id: row.id, accountId: row.account_id, sessionId: row.session_id, at: row.at, kind: row.kind, page: row.page, target: row.target, detail: parseDetail(row.detail), ok: row.ok === 1,
});

// since and until take a date (whole day) or a UTC time to the minute or second.
function moment(value, name, endOfRange) {
  if (!value) return null;
  if (DAY.test(value)) return `${value}T${endOfRange ? '23:59:59.999' : '00:00:00.000'}Z`;
  const ms = MOMENT.test(value) ? Date.parse(value.endsWith('Z') ? value : `${value}Z`) : NaN;
  if (!Number.isFinite(ms)) throw invalid(`${name} must be a date like 2026-10-01 or a UTC time like 2026-10-01T09:30.`);
  const toMinute = value.replace(/Z$/, '').length === 16;
  return new Date(ms + (endOfRange && toMinute ? 59999 : 0)).toISOString();
}

// Filters from the query string: kind (comma list), failed=1, q (target, page or detail), since, until and the paging cursor `before` (a row id).
function filters(db, accountId, params) {
  const where = ['account_id = ?'];
  const args = [accountId];
  const kinds = (params.get('kind') || '').split(',').map(k => k.trim()).filter(Boolean);
  if (kinds.some(kind => !KINDS.includes(kind))) throw invalid(`kind must be one or more of ${KINDS.join(', ')}.`);
  if (kinds.length) { where.push(`kind IN (${kinds.map(() => '?').join(',')})`); args.push(...kinds); }
  if (['1', 'true'].includes(params.get('failed'))) where.push('ok = 0');
  const q = (params.get('q') || '').trim().slice(0, 100);
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, c => `\\${c}`)}%`;
    where.push("(target LIKE ? ESCAPE '\\' OR page LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\')");
    args.push(like, like, like);
  }
  const since = moment(params.get('since'), 'since', false);
  const until = moment(params.get('until'), 'until', true);
  if (since) { where.push('at >= ?'); args.push(since); }
  if (until) { where.push('at <= ?'); args.push(until); }
  const before = params.get('before');
  if (before) {
    if (!/^\d{1,15}$/.test(before)) throw invalid('before must be a row id from nextBefore.');
    const anchor = get(db, 'SELECT id, at FROM activity WHERE id = ?', Number(before));
    if (anchor) { where.push('(at < ? OR (at = ? AND id < ?))'); args.push(anchor.at, anchor.at, anchor.id); }
    else { where.push('id < ?'); args.push(Number(before)); }
  }
  return { sql: where.join(' AND '), args };
}

/** One page of an account's log, newest first, with the cursor for the next page (null at the end). */
export function accountActivity(db, accountId, params, pageSize = PAGE_SIZE) {
  const { sql, args } = filters(db, accountId, params);
  const rows = all(db, `SELECT * FROM activity WHERE ${sql} ORDER BY at DESC, id DESC LIMIT ?`, ...args, pageSize + 1);
  const page = rows.slice(0, pageSize).map(activityView);
  return { rows: page, nextBefore: rows.length > pageSize ? page[page.length - 1].id : null };
}

/** The same filter as CSV: every matching row, at most ACCOUNT_CAP. */
export function activityCsv(db, accountId, params) {
  const { rows } = accountActivity(db, accountId, params, ACCOUNT_CAP);
  return toCsv(['at', 'kind', 'result', 'page', 'target', 'status', 'code', 'session', 'detail'],
    rows.map(r => [r.at, r.kind, r.ok ? 'ok' : 'failed', r.page, r.target ?? '', r.detail.status ?? '', r.detail.code ?? '', r.sessionId ?? '', JSON.stringify(r.detail)]));
}

/** The latest failed API calls, browser errors and sign-ins across every account. */
export function recentFailures(db, limit) {
  return all(db, `SELECT a.*, acc.email, acc.company FROM activity a LEFT JOIN accounts acc ON acc.id = a.account_id
    WHERE a.ok = 0 AND a.kind IN ('api', 'error', 'auth') ORDER BY a.at DESC, a.id DESC LIMIT ?`, limit)
    .map(row => ({ ...activityView(row), account: row.account_id ? { id: row.account_id, email: row.email, company: row.company } : null }));
}

/** Failure rows for the Supabase mirror: no clicks, no successful calls, and detail as an object. */
export function failureMirrorRows(db) {
  return all(db, "SELECT * FROM activity WHERE ok = 0 AND kind IN ('api', 'error', 'auth')").map(row => {
    const view = activityView(row);
    return { id: view.id, account_id: view.accountId, session_id: view.sessionId, at: view.at, kind: view.kind, page: view.page, target: view.target, detail: view.detail, created_at: row.created_at };
  });
}

function loadAccountId(db, id) {
  if (!get(db, 'SELECT 1 AS x FROM accounts WHERE id = ?', id)) throw notFound('No account with that id.');
  return id;
}

/** POST /api/activity (the browser's batches) and the three admin read routes. */
export function activityRoutes({ now, limit }) {
  const opts = { roles: ADMIN };
  return [
    // Signed-out batches are ignored with a plain answer, so the client can stop sending.
    route('POST', '/api/activity', ({ db, account, body, session }) => {
      if (!account) return { body: { stored: 0, signedIn: false } };
      limit(account.id, 'activity', 60, 60 * 1000);
      if (!Array.isArray(body.events)) throw invalid('Send { "events": [...] }.');
      const nowMs = now();
      const events = body.events.slice(0, MAX_BATCH).map(e => clientEvent(e, nowMs)).filter(Boolean);
      transaction(db, () => { for (const e of events) recordActivity(db, { ...e, accountId: account.id, sessionId: session }); });
      return { body: { stored: events.length, dropped: body.events.length - events.length, signedIn: true } };
    }, { body: true, bodyLimit: BATCH_BODY_BYTES, beacon: true }),
    route('GET', '/api/admin/accounts/:id/activity', ({ db, params, url }) => ({ body: accountActivity(db, loadAccountId(db, params.id), url.searchParams) }), opts),
    route('GET', '/api/admin/accounts/:id/activity.csv', ({ db, params, url }) => ({
      raw: activityCsv(db, loadAccountId(db, params.id), url.searchParams),
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="dodona-demo-activity.csv"' },
    }), opts),
    route('GET', '/api/admin/activity/failures', ({ db, url }) => {
      const n = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), MAX_FAILURES);
      return { body: { rows: recentFailures(db, n) } };
    }, opts),
  ];
}

/** Paths whose own calls are not logged: the browser's batches and the admin reading the log. */
export const UNLOGGED = /^\/api\/(?:activity$|admin\/activity\/|admin\/accounts\/[^/]+\/activity(?:\.csv)?$)/;

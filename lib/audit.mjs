/** Audit trail: a hash-chained, append-only log of demo activity, kept in memory and appended to a JSONL file when possible. */
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPage, escapeHtml } from './site.mjs';
import { METHOD_VERSION } from './valuation.mjs';

export const KINDS = Object.freeze(['quote', 'booking_created', 'exercise_confirmed', 'listing_created', 'offer_sent', 'signup', 'rfq', 'mark', 'system']);
export const GENESIS = '0'.repeat(64);
const MAX_ENTRIES = 1000;
const MAX_SUMMARY = 200;
const MAX_DATA_BYTES = 1024;
const PAGE_ROWS = 50;
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
// No personal data in the log: emails, phone numbers, card numbers and long digit runs are refused.
const PII_PATTERNS = [
  /[^\s@]+@[^\s@]+\.[a-z]{2,}/i,
  /\d{7,}/,
  /\b(?:\d{4}[ -]){3}\d{1,4}\b/,
  /\+?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/,
];
const defaultFile = fileURLToPath(new URL('../data/audit.jsonl', import.meta.url));

export class AuditError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Sorted keys, no whitespace; the browser verifier in audit.js uses the same rule.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function hashEntry({ id, ts, kind, ref, summary, data }, prevHash) {
  return createHash('sha256').update(prevHash + '\n' + canonicalJson({ id, ts, kind, ref, summary, data })).digest('hex');
}

// Checks each entry's own hash and its link to the entry before it (oldest first).
export function verifyEntries(entries) {
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const linked = index === 0 || entry.prevHash === entries[index - 1].hash;
    if (!linked || hashEntry(entry, entry.prevHash) !== entry.hash) return { ok: false, entries: entries.length, firstBad: entry.id ?? null };
  }
  return { ok: true, entries: entries.length, firstBad: null };
}

function resolveFile(environment) {
  const setting = environment.AUDIT_LOG_FILE;
  if (setting === 'off') return null;
  return setting || defaultFile;
}

export function createAuditLog({ file = resolveFile(process.env), now = () => new Date(), max = MAX_ENTRIES, logger = console } = {}) {
  let entries = [];
  let lastHash = GENESIS;
  let loaded = false;
  let diskOk = Boolean(file);

  function load() {
    if (loaded) return;
    loaded = true;
    if (!file) return;
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { return; }
    const parsed = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { parsed.push(JSON.parse(line)); } catch { logger.error('[audit] Skipped an unreadable log line.'); }
    }
    entries = parsed.slice(-max);
    if (entries.length) lastHash = entries.at(-1).hash;
  }

  function persist(entry) {
    if (!diskOk) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, JSON.stringify(entry) + '\n');
    } catch {
      diskOk = false;
      logger.error('[audit] Log file is not writable; keeping entries in memory only.');
    }
  }

  function record(kind, summary, data = {}, { ref = null } = {}) {
    load();
    if (!KINDS.includes(kind)) throw new AuditError(400, 'Unknown audit kind.');
    const body = { id: randomUUID(), ts: now().toISOString(), kind, ref: ref ?? null, summary: String(summary), data: data ?? {} };
    const entry = { ...body, prevHash: lastHash, hash: hashEntry(body, lastHash) };
    lastHash = entry.hash;
    entries = [...entries, entry].slice(-max);
    persist(entry);
    return entry;
  }

  function list({ limit = 100, kind = null } = {}) {
    load();
    const size = Math.max(1, Math.min(max, Number.isInteger(limit) ? limit : 100));
    return entries.filter(entry => !kind || entry.kind === kind).slice(-size).reverse();
  }

  function verify() {
    load();
    return verifyEntries(entries);
  }

  return { record, list, verify, get file() { return diskOk ? file : null; } };
}

// The shared log is created on first use, so importing this module never touches the disk.
let defaultLog;
const log = () => (defaultLog ??= createAuditLog());

export const record = (...args) => log().record(...args);
export const list = options => log().list(options);
export const verify = () => log().verify();

// For other server routes; an audit failure never breaks the caller.
export function recordServerEvent(kind, summary, data = {}, options = {}) {
  try { return log().record(kind, summary, data, options); }
  catch { return null; }
}

export const recordStartup = () => recordServerEvent('system', `Server started · method ${METHOD_VERSION}`);

const stripControl = value => value.replace(CONTROL, '');
const looksPersonal = text => PII_PATTERNS.some(pattern => pattern.test(text));

function cleanData(data) {
  if (data == null) return {};
  if (typeof data !== 'object' || Array.isArray(data)) throw new AuditError(400, 'data must be an object.');
  const cleaned = JSON.parse(JSON.stringify(data, (key, value) => typeof value === 'string' ? stripControl(value) : value));
  const serialised = JSON.stringify(cleaned);
  if (Buffer.byteLength(serialised) > MAX_DATA_BYTES) throw new AuditError(400, 'data is too large.');
  if (looksPersonal(serialised)) throw new AuditError(400, 'Personal details are not allowed in the audit log.');
  return cleaned;
}

// Validates a client-posted event; throws AuditError with a status for bad input.
export function validateEvent(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AuditError(400, 'Send a JSON object.');
  if (!KINDS.includes(body.kind)) throw new AuditError(400, 'Unknown audit kind.');
  if (typeof body.summary !== 'string') throw new AuditError(400, 'summary is required.');
  const summary = stripControl(body.summary).trim();
  if (!summary || summary.length > MAX_SUMMARY) throw new AuditError(400, `summary must be 1 to ${MAX_SUMMARY} characters.`);
  if (looksPersonal(summary)) throw new AuditError(400, 'Personal details are not allowed in the audit log.');
  let ref = null;
  if (body.ref != null) {
    if (typeof body.ref !== 'string' || !REF_PATTERN.test(body.ref) || looksPersonal(body.ref)) throw new AuditError(400, 'ref must be a short reference like DEMO-ABC123.');
    ref = body.ref;
  }
  return { kind: body.kind, summary, data: cleanData(body.data), ref };
}

export function acceptEvent(body, auditLog = log()) {
  const event = validateEvent(body);
  const entry = auditLog.record(event.kind, event.summary, event.data, { ref: event.ref });
  return { id: entry.id, hash: entry.hash };
}

export function auditFeed(url, auditLog = log()) {
  const kind = url.searchParams.get('kind') || null;
  if (kind && !KINDS.includes(kind)) throw new AuditError(400, 'Unknown audit kind.');
  const limit = Number.parseInt(url.searchParams.get('limit') || '100', 10);
  const entries = auditLog.list({ limit: Number.isInteger(limit) ? limit : 100, kind });
  return { asOf: new Date().toISOString(), count: entries.length, chainOk: auditLog.verify().ok, entries };
}

export const KIND_LABELS = Object.freeze({ quote: 'Quote', booking_created: 'Booking', exercise_confirmed: 'Exercise', listing_created: 'Listing', offer_sent: 'Offer', signup: 'Signup', rfq: 'RFQ', mark: 'Mark', system: 'System' });
const kindLabel = kind => KIND_LABELS[kind] || kind;
const short = hash => (hash || '').slice(0, 10);

export function auditRows(entries) {
  if (!entries.length) return '<tr><td colspan="6" class="a-empty">No entries yet.</td></tr>';
  return entries.map(entry => `<tr id="e-${escapeHtml(entry.hash)}">
    <td><time datetime="${escapeHtml(entry.ts)}">${escapeHtml(entry.ts.slice(0, 19).replace('T', ' '))} UTC</time></td>
    <td><span class="a-kind">${escapeHtml(kindLabel(entry.kind))}</span></td>
    <td class="a-ref">${entry.ref ? escapeHtml(entry.ref) : '—'}</td>
    <td>${escapeHtml(entry.summary)}</td>
    <td><code class="a-hash" title="${escapeHtml(entry.hash)}">${escapeHtml(short(entry.hash))}</code></td>
    <td>${entry.prevHash === GENESIS ? '<code class="a-hash">genesis</code>' : `<a class="a-hash" href="#e-${escapeHtml(entry.prevHash)}" title="${escapeHtml(entry.prevHash)}"><code>${escapeHtml(short(entry.prevHash))}</code></a>`}</td>
  </tr>`).join('');
}

export function kindFilters(active) {
  return ['', ...KINDS].map(kind => {
    const href = kind ? `/audit?kind=${kind}` : '/audit';
    const current = (active || '') === kind;
    return `<a class="a-filter${current ? ' is-active' : ''}" href="${href}" data-kind="${kind}"${current ? ' aria-current="true"' : ''}>${kind ? escapeHtml(kindLabel(kind)) : 'All'}</a>`;
  }).join('');
}

const jsonDocument = (status, value) => ({ status, type: 'application/json; charset=utf-8', body: JSON.stringify(value), cacheControl: 'no-store' });

// Returns a response description for the audit page and feed, or null for other paths.
export async function auditDocument(url, { settings, origin = '', auditLog = log() } = {}) {
  if (url.pathname === '/api/audit') {
    try { return jsonDocument(200, auditFeed(url, auditLog)); }
    catch (error) {
      if (error instanceof AuditError) return jsonDocument(error.status, { error: error.message });
      throw error;
    }
  }
  if (url.pathname !== '/audit') return null;
  const requested = url.searchParams.get('kind');
  const kind = KINDS.includes(requested) ? requested : null;
  const check = auditLog.verify();
  let html = await readFile(new URL('../audit.html', import.meta.url), 'utf8');
  const replacements = {
    A_FILTERS: kindFilters(kind),
    A_ROWS: auditRows(auditLog.list({ limit: PAGE_ROWS, kind })),
    A_STATUS: check.ok ? `Server check: chain intact · ${check.entries} entries` : 'Server check: chain broken',
  };
  for (const [marker, content] of Object.entries(replacements)) html = html.replaceAll(`<!-- ${marker} -->`, content);
  return { status: 200, type: 'text/html; charset=utf-8', body: renderPage(html, { settings, origin, path: '/audit' }), cacheControl: 'no-store' };
}

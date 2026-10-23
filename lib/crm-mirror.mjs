/** Supabase mirror for the demo CRM: upserts accounts, notes, orders, payment summaries and settlements from the demo SQLite database through PostgREST. */
import { projectOrigin, supabaseHeaders } from './supabase.mjs';

const INTERVAL_MS = 60 * 1000;
const CHUNK = 500;
const TIMEOUT_MS = 8000;
const NOT_CONFIGURED = 'The Supabase mirror is not configured, so nothing was sent. Follow the setup steps on this page, then restart the server.';

// Each mirrored table names exactly the columns it reads. Password hashes, session tokens and card details are never selected.
export const MIRROR_TABLES = [
  {
    name: 'accounts', remote: 'demo_accounts', key: 'id', source: 'accounts',
    columns: {
      id: 'id', email: 'email', company: 'company', role: 'role', kyb: 'kyb', stage: 'stage', phone: 'phone',
      neocloud_id: 'neocloud_id', demo_now: 'demo_now', scenario: 'scenario', last_active_at: 'last_active_at',
      created_at: 'created_at', updated_at: 'updated_at',
    },
  },
  {
    name: 'notes', remote: 'demo_notes', key: 'id', source: 'notes',
    columns: { id: 'id', account_id: 'account_id', author: 'author', text: 'text', created_at: 'created_at', updated_at: 'updated_at' },
  },
  {
    name: 'orders', remote: 'demo_orders', key: 'ref', source: 'orders',
    columns: {
      ref: 'ref', account_id: 'account_id', offer_id: 'offer_id', neocloud_id: 'neocloud_id', gpu: 'gpu', gpu_count: 'count',
      region: 'region', kind: 'kind', strike: 'strike', window_start: 'start', window_end: 'end', status: 'status',
      delivery_choice: 'delivery_choice', premium_per_gpu_hour: 'premium_per_gpu_hour', premium_total: 'premium_total',
      platform_fee: 'platform_fee', booking_fee: 'booking_fee', pay_now: 'pay_now', created_at: 'created_at', updated_at: 'updated_at',
    },
  },
  {
    name: 'payments', remote: 'demo_payments', key: 'id', source: 'payments',
    columns: { id: 'id', order_ref: 'order_ref', account_id: 'account_id', amount: 'amount', status: 'status', outcome: 'code', created_at: 'created_at', updated_at: 'updated_at' },
  },
  // Settlements live as JSON on the order; only the statement's numbers are copied.
  { name: 'settlements', remote: 'demo_settlements', key: 'order_ref', source: 'orders', count: 'settlement_json IS NOT NULL', read: settlementRows },
];

const quote = name => `"${name.replaceAll('"', '""')}"`;
const number = value => (value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));

function settlementRows(db) {
  const rows = db.prepare('SELECT ref, account_id, kind, settlement_json, updated_at FROM orders WHERE settlement_json IS NOT NULL').all();
  return rows.map(row => {
    let s = {};
    try { s = JSON.parse(row.settlement_json) || {}; } catch { /* an unreadable statement still mirrors its order reference */ }
    return {
      order_ref: row.ref, account_id: row.account_id, kind: s.kind ?? row.kind, window_avg: number(s.windowAvg), strike: number(s.strike),
      hours: number(s.hours), compute_bill: number(s.computeBill), saving: number(s.saving), payout: number(s.payout),
      resale_proceeds: number(s.resaleProceeds), premium_paid: number(s.premiumPaid), net_result: number(s.netResult),
      computed_at: s.computedAt ?? null, updated_at: row.updated_at,
    };
  });
}

/** Reads the three settings that switch the mirror on; the key itself never leaves this object. */
export function mirrorSettings(environment = process.env) {
  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].filter(name => !environment[name]);
  if (environment.DEMO_SUPABASE_MIRROR !== '1') missing.push('DEMO_SUPABASE_MIRROR');
  if (missing.length) return { configured: false, missing };
  try {
    return { configured: true, missing: [], url: projectOrigin(environment.SUPABASE_URL), key: environment.SUPABASE_SERVICE_ROLE_KEY.trim() };
  } catch {
    return { configured: false, missing: ['SUPABASE_URL'], invalid: 'SUPABASE_URL must be the HTTPS Supabase project URL.' };
  }
}

/** Every row of one table, mapped to the Supabase column names. */
export function mirrorRows(db, table) {
  if (table.read) return table.read(db);
  const columns = Object.entries(table.columns);
  const select = columns.map(([remote, local]) => `${quote(local)} AS ${quote(remote)}`).join(', ');
  const rows = db.prepare(`SELECT ${select} FROM ${quote(table.source)}`).all();
  return rows.map(row => Object.fromEntries(columns.map(([remote]) => [remote, row[remote] ?? null])));
}

function localCount(db, table) {
  try { return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${quote(table.source)}${table.count ? ` WHERE ${table.count}` : ''}`).get().n); }
  catch { return null; }
}

function failureMessage(table, status) {
  if (status === 401 || status === 403) return `Supabase rejected the service role key while writing ${table.remote}.`;
  if (status === 404) return `Supabase has no ${table.remote} table yet. Run supabase/demo-crm.sql in the SQL editor first.`;
  return `Supabase answered ${status} while writing ${table.remote}.`;
}

async function upsert({ url, key, fetchImpl }, table, rows) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const response = await fetchImpl(`${url}/rest/v1/${table.remote}?on_conflict=${table.key}`, {
      method: 'POST',
      headers: { ...supabaseHeaders(key), 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows.slice(i, i + CHUNK)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(failureMessage(table, response.status));
  }
}

// Rows a demo reset removed locally are removed from Supabase too, so the mirror matches the demo database.
async function remove({ url, key, fetchImpl }, table, keys) {
  for (let i = 0; i < keys.length; i += CHUNK) {
    const list = keys.slice(i, i + CHUNK).map(k => `"${encodeURIComponent(k)}"`).join(',');
    const response = await fetchImpl(`${url}/rest/v1/${table.remote}?${table.key}=in.(${list})`, {
      method: 'DELETE', headers: { ...supabaseHeaders(key), Prefer: 'return=minimal' }, signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(failureMessage(table, response.status));
  }
}

// The demo stamps rows with each account's demo clock, which differs per account and rewinds on reset,
// so changes are found by comparing each row with what was last sent rather than by an updated_at watermark.
function diff(rows, table, sent = new Map()) {
  const current = new Map(rows.map(row => [String(row[table.key]), JSON.stringify(row)]));
  return {
    current,
    changed: rows.filter(row => sent.get(String(row[table.key])) !== current.get(String(row[table.key]))),
    removed: [...sent.keys()].filter(k => !current.has(k)),
  };
}

/** The mirror: status for the admin page, run() on demand, and a 60-second timer when configured. It never throws. */
export function createCrmMirror({ db, environment = process.env, fetchImpl = fetch, logger = console, now = Date.now, intervalMs = INTERVAL_MS, tables = MIRROR_TABLES } = {}) {
  const settings = mirrorSettings(environment);
  const sent = new Map();
  let lastRunAt = null, lastResult = null, timer = null, pending = 0, queue = Promise.resolve();

  async function sync() {
    const started = now();
    const pushed = {}, removed = {};
    const remote = { ...settings, fetchImpl };
    try {
      for (const table of tables) {
        const change = diff(mirrorRows(db, table), table, sent.get(table.name));
        if (change.changed.length) await upsert(remote, table, change.changed);
        if (change.removed.length) await remove(remote, table, change.removed);
        sent.set(table.name, change.current);
        pushed[table.name] = change.changed.length;
        removed[table.name] = change.removed.length;
      }
      const total = Object.values(pushed).reduce((a, b) => a + b, 0), gone = Object.values(removed).reduce((a, b) => a + b, 0);
      lastResult = { ok: true, message: `Sent ${total} changed row${total === 1 ? '' : 's'} to Supabase${gone ? ` and removed ${gone} that a demo reset deleted` : ''}.`, pushed, removed };
    } catch (error) {
      const message = error?.name === 'TimeoutError' ? 'Supabase did not answer within 8 seconds.' : error?.message?.startsWith('Supabase') ? error.message : 'The mirror could not read the demo database or reach Supabase.';
      lastResult = { ok: false, message, pushed };
    }
    lastRunAt = new Date(started).toISOString();
    logger[lastResult.ok ? 'log' : 'error'](`[crm-mirror] ${lastResult.ok ? 'synced' : 'failed'} in ${now() - started} ms: ${lastResult.message}`);
    return lastResult;
  }

  return {
    get configured() { return settings.configured; },
    status() {
      const counts = Object.fromEntries(tables.map(table => [table.name, localCount(db, table)]));
      return { configured: settings.configured, missing: settings.missing, invalid: settings.invalid || null, intervalSeconds: Math.round(intervalMs / 1000), running: pending > 0, lastRunAt, lastResult, tables: counts };
    },
    // Runs queue one after another, so a Sync now during a timed run still reads the database after the latest change.
    async run() {
      if (!settings.configured) return { ok: false, ran: false, configured: false, message: settings.invalid || NOT_CONFIGURED };
      pending++;
      const job = queue.then(sync).finally(() => { pending--; });
      queue = job;
      return { ...(await job), ran: true, configured: true };
    },
    start() {
      if (!settings.configured || timer) return;
      timer = setInterval(() => { this.run().catch(() => {}); }, intervalMs);
      timer.unref?.();
      this.run().catch(() => {});
    },
    stop() { clearInterval(timer); timer = null; },
  };
}

/**
 * The mirror as the platform's admin routes use it: `status(db)` and `runNow(db)` take the demo database the route already
 * opened, and `start(db)` begins the 60-second timer. One mirror per server, created on first use.
 */
export function createMirrorService(options = {}) {
  let mirror = null;
  const forDb = db => (mirror ??= createCrmMirror({ ...options, db }));
  return {
    configured: mirrorSettings(options.environment).configured,
    status: db => forDb(db).status(),
    runNow: db => forDb(db).run(),
    start: db => forDb(db).start(),
    stop: () => mirror?.stop(),
  };
}

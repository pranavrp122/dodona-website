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
    columns: { id: 'id', order_ref: 'order_ref', account_id: 'account_id', amount: 'amount', status: 'status', outcome: 'outcome', created_at: 'created_at', updated_at: 'updated_at' },
  },
  {
    name: 'settlements', remote: 'demo_settlements', key: 'order_ref', source: 'settlements',
    columns: {
      order_ref: 'order_ref', account_id: 'account_id', kind: 'kind', window_avg: 'window_avg', strike: 'strike', hours: 'hours',
      compute_bill: 'compute_bill', saving: 'saving', resale_proceeds: 'resale_proceeds', premium_paid: 'premium_paid',
      net_result: 'net_result', computed_at: 'computed_at', updated_at: 'updated_at',
    },
  },
];

const quote = name => `"${name.replaceAll('"', '""')}"`;

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

/** Rows of one table changed since the watermark, mapped to the Supabase column names. */
export function changedRows(db, table, since = '') {
  const columns = Object.entries(table.columns);
  const select = columns.map(([remote, local]) => `${quote(local)} AS ${quote(remote)}`).join(', ');
  const rows = db.prepare(`SELECT ${select} FROM ${quote(table.source)} WHERE ${quote(table.columns.updated_at)} > ? ORDER BY ${quote(table.columns.updated_at)}`).all(since);
  return rows.map(row => Object.fromEntries(columns.map(([remote]) => [remote, row[remote] ?? null])));
}

function localCount(db, table) {
  try { return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${quote(table.source)}`).get().n); }
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

/** The mirror: status for the admin page, run() on demand, and a 60-second timer when configured. It never throws. */
export function createCrmMirror({ db, environment = process.env, fetchImpl = fetch, logger = console, now = Date.now, intervalMs = INTERVAL_MS, tables = MIRROR_TABLES } = {}) {
  const settings = mirrorSettings(environment);
  const watermarks = new Map();
  let lastRunAt = null, lastResult = null, running = null, timer = null;

  async function sync() {
    const started = now();
    const pushed = {};
    try {
      for (const table of tables) {
        const rows = changedRows(db, table, watermarks.get(table.name) || '');
        if (rows.length) await upsert({ ...settings, fetchImpl }, table, rows);
        pushed[table.name] = rows.length;
        if (rows.length) watermarks.set(table.name, rows.at(-1).updated_at);
      }
      lastResult = { ok: true, message: `Sent ${Object.values(pushed).reduce((a, b) => a + b, 0)} changed rows to Supabase.`, pushed };
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
      return { configured: settings.configured, missing: settings.missing, invalid: settings.invalid || null, intervalSeconds: Math.round(intervalMs / 1000), running: Boolean(running), lastRunAt, lastResult, tables: counts };
    },
    async run() {
      if (!settings.configured) return { ok: false, ran: false, configured: false, message: settings.invalid || NOT_CONFIGURED };
      running ??= sync().finally(() => { running = null; });
      return { ...(await running), ran: true, configured: true };
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

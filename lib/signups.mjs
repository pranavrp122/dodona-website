// Server-side Supabase store for the signup, contact and quote-request tables.
import { projectOrigin, supabaseHeaders } from './supabase.mjs';

export const FORM_TABLES = Object.freeze({ signup: 'signups', contact: 'contact_messages', rfq: 'rfq_requests' });
const allowedTables = new Set(Object.values(FORM_TABLES));
const REQUEST_TIMEOUT_MS = 8000;

export class SupabaseTableStore {
  constructor({ url, key, fetchImpl = fetch }) {
    this.origin = projectOrigin(url);
    if (typeof key !== 'string' || !key.trim()) throw new Error('Missing server-side Supabase service role key.');
    this.key = key.trim();
    this.fetchImpl = fetchImpl;
  }

  async request(table, query, options = {}) {
    if (!allowedTables.has(table)) throw new Error('Unknown storage table.');
    return this.fetchImpl(`${this.origin}/rest/v1/${table}${query}`, {
      ...options,
      headers: { ...supabaseHeaders(this.key), 'Content-Type': 'application/json', ...options.headers },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  async health(table) {
    const response = await this.request(table, '?select=id&limit=0');
    if (!response.ok) throw new Error('Storage is unavailable.');
    const result = await response.json();
    if (!Array.isArray(result) || result.length !== 0) throw new Error('Unexpected storage response.');
  }

  // Inserts one row. With onConflict, an existing row is left untouched and reported as a duplicate.
  async insertRow(table, row, { onConflict } = {}) {
    const query = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}&select=id` : '?select=id';
    const prefer = onConflict ? 'resolution=ignore-duplicates,return=representation' : 'return=representation';
    const response = await this.request(table, query, { method: 'POST', headers: { Prefer: prefer }, body: JSON.stringify(row) });
    if (!response.ok) throw new Error('Storage did not confirm the row.');
    const rows = await response.json();
    const confirmed = Array.isArray(rows) && rows.length <= 1 && rows.every(item => typeof item?.id === 'string');
    if (!confirmed || (rows.length === 0 && !onConflict)) throw new Error('Unexpected storage confirmation.');
    return { duplicate: rows.length === 0 };
  }
}

export function formStoreFromEnvironment(environment = process.env) {
  if (!environment.SUPABASE_URL || !environment.SUPABASE_SERVICE_ROLE_KEY) return null;
  return new SupabaseTableStore({ url: environment.SUPABASE_URL, key: environment.SUPABASE_SERVICE_ROLE_KEY });
}

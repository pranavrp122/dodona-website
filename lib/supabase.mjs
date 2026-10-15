export class SupabaseWaitlistStore {
  constructor({ url, key, fetchImpl = fetch }) {
    const project = new URL(url);
    if (project.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/.test(project.hostname) ||
        project.username || project.password || project.port || project.pathname !== '/' || project.search || project.hash) {
      throw new Error('SUPABASE_URL must be the HTTPS Supabase project URL.');
    }
    if (typeof key !== 'string' || !key.trim()) throw new Error('Missing server-side Supabase service role key.');
    this.url = project.origin + '/rest/v1/waitlist';
    this.key = key.trim();
    this.fetchImpl = fetchImpl;
  }

  async request(query, options = {}) {
    return this.fetchImpl(this.url + query, {
      ...options,
      headers: {
        apikey: this.key,
        Authorization: `Bearer ${this.key}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
      signal: AbortSignal.timeout(8000),
    });
  }

  async health() {
    const response = await this.request('?select=id&limit=0');
    if (!response.ok) throw new Error('Storage is unavailable.');
    const result = await response.json();
    if (!Array.isArray(result) || result.length !== 0) throw new Error('Unexpected storage response.');
  }

  async insert({ email, interest, useCase }) {
    const response = await this.request('?on_conflict=email&select=id', {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
      body: JSON.stringify({ email, interest: interest || null, use_case: useCase || null }),
    });
    if (!response.ok) throw new Error('Storage did not confirm the signup.');
    const rows = await response.json();
    // Empty representation means ON CONFLICT DO NOTHING: this email is already stored.
    if (!Array.isArray(rows) || rows.length > 1 || (rows.length === 1 && typeof rows[0]?.id !== 'string')) {
      throw new Error('Unexpected storage confirmation.');
    }
    return { duplicate: rows.length === 0 };
  }
}

export function storeFromEnvironment(environment = process.env) {
  if (!environment.SUPABASE_URL || !environment.SUPABASE_SERVICE_ROLE_KEY) return null;
  return new SupabaseWaitlistStore({ url: environment.SUPABASE_URL, key: environment.SUPABASE_SERVICE_ROLE_KEY });
}

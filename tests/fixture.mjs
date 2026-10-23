// Test-only PostgREST fixture. This is not durable storage or a production mode.
import { createServer } from 'node:http';
import { SupabaseWaitlistStore } from '../lib/supabase.mjs';
import { createApp } from '../server.mjs';

// Route tests keep the shared audit log in memory so they never write data/audit.jsonl.
process.env.AUDIT_LOG_FILE ??= 'off';
// The demo platform uses a private in-memory database per app in tests, never data/demo.sqlite.
process.env.DEMO_DB_FILE ??= ':memory:';

export async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}

export async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

export async function fixture(options = {}) {
  const rows = new Map();
  const state = { failure: false, malformed: false, delay: 0, writes: 0, requests: [] };
  const key = 'test-only-service-role-key';
  const database = createServer(async (request, response) => {
    state.requests.push({ method: request.method, path: request.url, headers: request.headers });
    const send = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (request.headers.apikey !== key || request.headers.authorization !== `Bearer ${key}`) return send(401, { message: 'denied' });
    if (state.failure) return send(500, { message: 'test-only database failure' });
    if (state.malformed) return send(200, { wrong: true });
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'GET' && url.searchParams.get('limit') === '0') return send(200, []);
    if (request.method !== 'POST' || url.pathname !== '/rest/v1/waitlist') return send(404, {});
    if (url.searchParams.get('on_conflict') !== 'email' || request.headers.prefer !== 'resolution=ignore-duplicates,return=representation') return send(400, {});
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const row = JSON.parse(Buffer.concat(chunks));
    state.writes++;
    if (state.delay) await new Promise(resolve => setTimeout(resolve, state.delay));
    if (rows.has(row.email)) return send(201, []);
    rows.set(row.email, { ...row, id: 'test-only-id-' + rows.size });
    send(201, [{ id: rows.get(row.email).id }]);
  });
  const dbOrigin = await listen(database);
  const store = new SupabaseWaitlistStore({
    url: 'https://test-project.supabase.co', key,
    fetchImpl: (url, init) => fetch(url.replace('https://test-project.supabase.co', dbOrigin), init),
  });
  let time = Date.now();
  const app = createApp({ store, siteSettings: { operatorName: 'Test fixture operator', contactEmail: 'fixture@example.invalid', retentionDays: 30 }, now: options.realClock ? Date.now : () => time, logger: { error() {} }, platform: true, db: ':memory:', ...options });
  const origin = await listen(app);
  return {
    origin, store, rows, state,
    advance(ms) { time += ms; },
    async token() {
      const response = await fetch(origin + '/api/waitlist/status');
      const data = await response.json();
      time += 2000;
      return data.token;
    },
    async submit(body) {
      return fetch(origin + '/api/waitlist', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
    },
    async cleanup() { await close(app); await close(database); },
  };
}

/**
 * Demo platform fixture: an app with the platform on, an in-memory database, the embedded index and a fixed clock.
 * `as(email)` signs in a seeded account (password demo-dodona-2026) and returns a client that sends its cookie.
 */
export async function platformFixture(options = {}) {
  const { fallbackHistory } = await import('../lib/prices.mjs');
  const logs = [];
  let time = Date.parse(options.start || '2026-10-23T12:00:00Z');
  const app = createApp({
    store: null, prices: async () => fallbackHistory(), now: () => time, platform: true, db: ':memory:',
    siteSettings: { operatorName: 'Test fixture operator', contactEmail: 'fixture@example.invalid', retentionDays: 30 },
    logger: { error: (...args) => logs.push(args.join(' ')), log: (...args) => logs.push(args.join(' ')) }, ...options,
  });
  const origin = await listen(app);
  const client = cookie => {
    const send = async (method, path, body, headers = {}) => {
      const init = { method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...headers } };
      if (body !== undefined) { init.body = typeof body === 'string' ? body : JSON.stringify(body); init.headers['Content-Type'] ??= 'application/json'; }
      const response = await fetch(origin + path, init);
      const text = await response.text();
      let data = null;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: response.status, headers: response.headers, data };
    };
    return { cookie, get: path => send('GET', path), post: (path, body, headers) => send('POST', path, body, headers) };
  };
  const anonymous = client(null);
  return {
    origin, logs, anonymous,
    advance(ms) { time += ms; },
    async as(email, password = 'demo-dodona-2026') {
      const response = await anonymous.post('/api/auth/sign-in', { email, password });
      if (response.status !== 200) throw new Error(`sign-in failed for ${email}: ${response.status}`);
      return client(response.headers.get('set-cookie').split(';')[0]);
    },
    client,
    cleanup: () => close(app),
  };
}

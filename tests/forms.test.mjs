import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from '../server.mjs';
import { validateForm } from '../forms.js';
import { SupabaseTableStore, formStoreFromEnvironment } from '../lib/signups.mjs';
import { SupabaseWaitlistStore, supabaseHeaders } from '../lib/supabase.mjs';
import { listen, close } from './fixture.mjs';

const settings = { operatorName: 'Test fixture operator', contactEmail: 'fixture@example.invalid', retentionDays: null };
const NOW = Date.parse('2026-10-22T12:00:00Z');
const signup = { email: 'Ops@Example.com ', company: 'Sample Labs', role: 'buyer', useCase: 'Cap H100 cost for a run.', business: true, website: 'samplelabs.example.com', nickname: '' };
const contact = { name: 'Ada', email: 'ada@example.com', company: '', message: 'Tell me about caps.', nickname: '' };
const rfq = { email: 'buyer@example.com', company: 'Sample Labs', gpu: 'H100', count: '512', start: '2026-12-01', end: '2027-01-31', type: 'cap', strike: '2.50', notes: '', nickname: '' };

// In-memory stand-in for SupabaseTableStore with the same method names.
function fakeStore() {
  const tables = new Map();
  return {
    tables, healthy: true, failInsert: false,
    async health() { if (!this.healthy) throw new Error('down'); },
    async insertRow(table, row, { onConflict } = {}) {
      if (this.failInsert) throw new Error('insert failed');
      const rows = tables.get(table) ?? [];
      tables.set(table, rows);
      if (onConflict && rows.some(existing => existing[onConflict] === row[onConflict])) return { duplicate: true };
      rows.push(row);
      return { duplicate: false };
    },
  };
}

async function setup(t, options = {}) {
  let time = NOW;
  const errors = [];
  const server = createApp({ store: null, siteSettings: settings, now: () => time, logger: { error: message => errors.push(message) }, ...options });
  const origin = await listen(server);
  t.after(() => close(server));
  return {
    origin, errors,
    async token(form) {
      const response = await fetch(`${origin}/api/forms/status?form=${form}`);
      const data = await response.json();
      time += 2000;
      return data.token;
    },
    post(path, body, headers = {}) {
      return fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify(body) });
    },
  };
}

test('shared validation accepts good input and normalises it', () => {
  const result = validateForm('signup', signup, NOW);
  assert.equal(result.ok, true);
  assert.equal(result.value.email, 'ops@example.com');
  const quote = validateForm('rfq', rfq, NOW);
  assert.equal(quote.ok, true);
  assert.equal(quote.value.count, 512);
  assert.equal(quote.value.strike, 2.5);
  assert.equal(quote.value.start, '2026-12-01T00:00:00.000Z');
  assert.equal(validateForm('rfq', { ...rfq, strike: '' }, NOW).value.strike, null);
  assert.equal(validateForm('contact', contact, NOW).ok, true);
});

test('shared validation names the failing field', () => {
  const cases = [
    ['signup', { ...signup, email: 'not-an-email' }, 'email'],
    ['signup', { ...signup, company: '' }, 'company'],
    ['signup', { ...signup, role: 'trader' }, 'role'],
    ['signup', { ...signup, business: false }, 'business'],
    ['signup', { ...signup, website: 'not a site' }, 'website'],
    ['signup', { ...signup, useCase: 'x'.repeat(281) }, 'useCase'],
    ['contact', { ...contact, message: '' }, 'message'],
    ['contact', { ...contact, name: 'x'.repeat(81) }, 'name'],
    ['rfq', { ...rfq, gpu: 'RTX 5090' }, 'gpu'],
    ['rfq', { ...rfq, count: '0' }, 'count'],
    ['rfq', { ...rfq, count: '1.5' }, 'count'],
    ['rfq', { ...rfq, start: '2020-01-01' }, 'start'],
    ['rfq', { ...rfq, end: '2026-11-01' }, 'end'],
    ['rfq', { ...rfq, type: 'swap' }, 'type'],
    ['rfq', { ...rfq, strike: '-1' }, 'strike'],
  ];
  for (const [kind, body, field] of cases) {
    const result = validateForm(kind, body, NOW);
    assert.equal(result.ok, false, `${kind} ${field}`);
    assert.equal(result.field, field, `${kind} ${field}`);
  }
  assert.equal(validateForm('contact', { ...contact, nickname: 'bot' }, NOW).ok, false);
});

test('invalid submissions get a 400 with the field, before storage is checked', async t => {
  const f = await setup(t);
  const response = await f.post('/api/signups', { ...signup, email: 'nope' });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { message: 'Enter a valid email address.', field: 'email' });
  const rfqResponse = await f.post('/api/rfq', { ...rfq, end: '2026-11-01' });
  assert.equal(rfqResponse.status, 400);
  assert.equal((await rfqResponse.json()).field, 'end');
  const malformed = await fetch(f.origin + '/api/contact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[1,2]' });
  assert.equal(malformed.status, 400);
});

test('without storage, valid submissions honestly return 503 and status has no token', async t => {
  const f = await setup(t);
  for (const [path, body] of [['/api/signups', signup], ['/api/contact', contact], ['/api/rfq', rfq]]) {
    const response = await f.post(path, body);
    assert.equal(response.status, 503, path);
    assert.match((await response.json()).message, /./);
  }
  const status = await fetch(f.origin + '/api/forms/status?form=signup');
  assert.equal(status.status, 503);
  assert.deepEqual(await status.json(), { available: false, message: 'Signups are stored once the database is connected.' });
});

test('with a store, each form saves one row with the mapped columns', async t => {
  const store = fakeStore();
  const f = await setup(t, { formStore: store });
  for (const [path, body, form] of [['/api/signups', signup, 'signup'], ['/api/contact', contact, 'contact'], ['/api/rfq', rfq, 'rfq']]) {
    const token = await f.token(form);
    const response = await f.post(path, { ...body, token });
    assert.equal(response.status, 200, path);
    assert.deepEqual(await response.json(), { status: 'saved' });
  }
  assert.deepEqual(store.tables.get('signups'), [{ email: 'ops@example.com', company: 'Sample Labs', role: 'buyer', use_case: 'Cap H100 cost for a run.', website: 'samplelabs.example.com' }]);
  assert.deepEqual(store.tables.get('contact_messages'), [{ name: 'Ada', email: 'ada@example.com', company: null, message: 'Tell me about caps.' }]);
  assert.deepEqual(store.tables.get('rfq_requests'), [{ email: 'buyer@example.com', company: 'Sample Labs', gpu: 'H100', gpu_count: 512, start_at: '2026-12-01T00:00:00.000Z', end_at: '2027-01-31T00:00:00.000Z', type: 'cap', strike: 2.5, notes: null }]);
});

test('a repeat signup is reported as a duplicate and not stored twice', async t => {
  const store = fakeStore();
  const f = await setup(t, { formStore: store });
  const first = await f.post('/api/signups', { ...signup, token: await f.token('signup') });
  const second = await f.post('/api/signups', { ...signup, email: 'ops@example.com', token: await f.token('signup') });
  assert.deepEqual(await first.json(), { status: 'saved' });
  assert.deepEqual(await second.json(), { status: 'duplicate' });
  assert.equal(store.tables.get('signups').length, 1);
});

test('submissions need a fresh token, the site origin, JSON and a small body', async t => {
  const store = fakeStore();
  const f = await setup(t, { formStore: store });
  const missing = await f.post('/api/contact', contact);
  assert.equal(missing.status, 403);
  assert.equal((await missing.json()).code, 'FORM_EXPIRED');
  const token = await f.token('contact');
  const crossSite = await f.post('/api/contact', { ...contact, token }, { Origin: 'https://unrelated.example' });
  assert.equal(crossSite.status, 403);
  const wrongType = await fetch(f.origin + '/api/contact', { method: 'POST', headers: { 'Content-Type': 'text/plain', Origin: f.origin }, body: JSON.stringify({ ...contact, token }) });
  assert.equal(wrongType.status, 415);
  const oversized = await f.post('/api/contact', { ...contact, message: 'x'.repeat(9000), token });
  assert.equal(oversized.status, 413);
  const getApi = await fetch(f.origin + '/api/rfq');
  assert.equal(getApi.status, 405);
  assert.equal(store.tables.size, 0);
});

test('form posts are rate limited per client', async t => {
  const f = await setup(t, { formStore: fakeStore() });
  let last;
  for (let i = 0; i < 21; i++) last = await f.post('/api/contact', { ...contact, email: 'bad' });
  assert.equal(last.status, 429);
});

test('a storage failure returns 503 and logs no submitted details', async t => {
  const store = fakeStore();
  store.failInsert = true;
  const f = await setup(t, { formStore: store });
  const response = await f.post('/api/rfq', { ...rfq, token: await f.token('rfq') });
  assert.equal(response.status, 503);
  assert.ok(f.errors.length > 0);
  assert.ok(!f.errors.join(' ').includes('buyer@example.com'));
});

test('pages render with the form markup and external scripts only', async t => {
  const f = await setup(t);
  const expected = { '/signup': ['id="signup-form"', 'action="/api/signups"', 'name="business"', 'src="/signup.js"'], '/contact': ['id="contact-form"', 'action="/api/contact"', 'name="message"'], '/rfq': ['id="rfq-form"', 'action="/api/rfq"', 'name="gpu"', 'name="strike"'] };
  for (const [path, markers] of Object.entries(expected)) {
    const response = await fetch(f.origin + path);
    assert.equal(response.status, 200, path);
    const html = await response.text();
    for (const marker of markers) assert.ok(html.includes(marker), `${path} has ${marker}`);
    assert.ok(html.includes('src="/forms.js"'), `${path} loads forms.js`);
    assert.ok(!/<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>/.test(html), `${path} has no inline script`);
    assert.ok(!/\son[a-z]+=/.test(html), `${path} has no inline handlers`);
    assert.ok(!html.includes('<!-- CANONICAL -->'), `${path} went through renderPage`);
  }
  for (const asset of ['/forms.js', '/signup.js', '/forms.css']) assert.equal((await fetch(f.origin + asset)).status, 200, asset);
  const script = await (await fetch(f.origin + '/signup.js')).text();
  assert.ok(script.includes("sessionStorage.setItem('dodonaDemoSession'"));
  assert.ok(script.includes("location.assign('/dashboard')"));
  assert.ok(script.includes("kyb: 'pending'"));
});

test('the home page footer links to contact and quote requests', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(html.includes('<a href="/contact">Contact</a>'));
  assert.ok(html.includes('<a href="/rfq">Request a quote</a>'));
});

test('new sb_secret_ keys send only apikey; legacy keys also send the bearer header', async () => {
  assert.deepEqual(supabaseHeaders('sb_secret_abc'), { apikey: 'sb_secret_abc' });
  assert.deepEqual(supabaseHeaders('legacy.jwt.key'), { apikey: 'legacy.jwt.key', Authorization: 'Bearer legacy.jwt.key' });
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, init }); return new Response('[]', { status: 200 }); };
  await new SupabaseWaitlistStore({ url: 'https://demo.supabase.co', key: 'sb_secret_abc', fetchImpl }).health();
  await new SupabaseTableStore({ url: 'https://demo.supabase.co', key: 'sb_secret_abc', fetchImpl }).health('signups');
  for (const { init } of seen) {
    assert.equal(init.headers.apikey, 'sb_secret_abc');
    assert.equal(init.headers.Authorization, undefined);
  }
  assert.equal(seen[1].url, 'https://demo.supabase.co/rest/v1/signups?select=id&limit=0');
});

test('the table store inserts with the right query, reports duplicates and rejects unknown tables', async () => {
  const seen = [];
  let reply = [{ id: 'row-1' }];
  const fetchImpl = async (url, init) => { seen.push({ url, init }); return new Response(JSON.stringify(reply), { status: 201 }); };
  const store = new SupabaseTableStore({ url: 'https://demo.supabase.co', key: 'legacy-key', fetchImpl });
  assert.deepEqual(await store.insertRow('signups', { email: 'a@example.com' }, { onConflict: 'email' }), { duplicate: false });
  assert.equal(seen[0].url, 'https://demo.supabase.co/rest/v1/signups?on_conflict=email&select=id');
  assert.equal(seen[0].init.headers.Prefer, 'resolution=ignore-duplicates,return=representation');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer legacy-key');
  reply = [];
  assert.deepEqual(await store.insertRow('signups', { email: 'a@example.com' }, { onConflict: 'email' }), { duplicate: true });
  await assert.rejects(store.insertRow('contact_messages', { name: 'x' }), /Unexpected storage confirmation/);
  reply = [{ id: 'row-2' }];
  assert.deepEqual(await store.insertRow('rfq_requests', { gpu: 'H100' }), { duplicate: false });
  assert.equal(seen.at(-1).init.headers.Prefer, 'return=representation');
  await assert.rejects(store.insertRow('waitlist', {}), /Unknown storage table/);
  assert.throws(() => new SupabaseTableStore({ url: 'https://example.com', key: 'k' }));
  assert.equal(formStoreFromEnvironment({}), null);
});

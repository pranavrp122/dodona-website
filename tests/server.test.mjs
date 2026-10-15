import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { SupabaseWaitlistStore, storeFromEnvironment } from '../lib/supabase.mjs';
import { fixture, listen, close } from './fixture.mjs';

async function setup(t, options) { const f = await fixture(options); t.after(() => f.cleanup()); return f; }
const valid = { email: 'interested@example.com', interest: 'Individual trading', useCase: 'Follow GPU price changes.', website: '' };

test('without credentials, availability and submissions honestly return unavailable', async t => {
  const server = createApp({ store: null });
  const origin = await listen(server);
  t.after(() => close(server));
  const status = await fetch(origin + '/api/waitlist/status');
  assert.equal(status.status, 503);
  assert.equal((await status.json()).available, false);
  const response = await fetch(origin + '/api/waitlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(valid) });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).status, undefined);
});

test('valid submission reaches the storage adapter with normalized email and optional fields', async t => {
  const f = await setup(t);
  const response = await f.submit({ ...valid, email: '  Interested@Example.COM  ', token: await f.token() });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'saved' });
  assert.equal(f.rows.size, 1);
  assert.deepEqual(f.rows.get('interested@example.com'), { email: 'interested@example.com', interest: valid.interest, use_case: valid.useCase, id: 'test-only-id-0' });
});

test('optional fields can be omitted', async t => {
  const f = await setup(t);
  assert.equal((await f.submit({ email: valid.email, token: await f.token() })).status, 200);
  assert.equal(f.rows.get(valid.email).interest, null);
  assert.equal(f.rows.get(valid.email).use_case, null);
});

test('duplicates and concurrent retries produce one row and do not expose list membership', async t => {
  const f = await setup(t);
  const token = await f.token();
  const responses = await Promise.all(Array.from({ length: 3 }, () => f.submit({ ...valid, token })));
  for (const response of responses) { assert.equal(response.status, 200); assert.deepEqual(await response.json(), { status: 'saved' }); }
  const duplicate = await f.submit({ email: 'INTERESTED@example.com', interest: 'Partnership', token });
  assert.equal(duplicate.status, 200);
  assert.equal(f.rows.size, 1);
  assert.equal(f.rows.get(valid.email).interest, 'Individual trading');
});

test('malformed emails and inputs are rejected server-side without a write', async t => {
  const f = await setup(t);
  const token = await f.token();
  for (const body of [
    { ...valid, email: 'not-an-email' }, { ...valid, email: 'a@localhost' },
    { ...valid, email: 'a..b@example.com' }, { ...valid, email: 'a@-example.com' },
    { ...valid, email: ['a@example.com'] }, { ...valid, email: 'a'.repeat(65) + '@example.com' },
    { ...valid, interest: 'Deposits' }, { ...valid, useCase: 'x'.repeat(281) },
    { ...valid, useCase: '\u0000' }, { ...valid, useCase: {} },
    { ...valid, website: 'spam.example' }, { ...valid, website: true },
  ]) assert.equal((await f.submit({ ...body, token })).status, 422);
  assert.equal(f.state.writes, 0);
});

test('form tokens reject missing, altered, overly fast, and expired submissions', async t => {
  const f = await setup(t);
  assert.equal((await f.submit(valid)).status, 403);
  const status = await fetch(f.origin + '/api/waitlist/status');
  const { token } = await status.json();
  assert.equal((await f.submit({ ...valid, token })).status, 429);
  f.advance(2000);
  assert.equal((await f.submit({ ...valid, token: token + 'x' })).status, 403);
  f.advance(2 * 60 * 60 * 1000);
  const response = await f.submit({ ...valid, token });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'FORM_EXPIRED');
  assert.equal(f.state.writes, 0);
});

test('a successful response waits for storage confirmation', async t => {
  const f = await setup(t);
  f.state.delay = 100;
  let complete = false;
  const token = await f.token();
  const pending = f.submit({ ...valid, token }).then(response => { complete = true; return response; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(complete, false);
  assert.equal(f.rows.size, 0);
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(f.rows.size, 1);
});

test('storage failures and invalid confirmations never produce signup success', async t => {
  const f = await setup(t);
  const token = await f.token();
  for (const failure of ['failure', 'malformed']) {
    f.state[failure] = true;
    const response = await f.submit({ ...valid, token });
    assert.equal(response.status, 503);
    const result = await response.json();
    assert.equal(result.status, undefined);
    assert.ok(!JSON.stringify(result).includes('test-only-service-role-key'));
    f.state[failure] = false;
  }
  assert.equal(f.rows.size, 0);
  f.advance(31000);
  assert.equal((await fetch(f.origin + '/api/waitlist/status')).status, 200);
  assert.equal((await f.submit({ ...valid, token })).status, 200);
});

test('unhealthy storage is reported unavailable', async t => {
  const f = await setup(t);
  f.state.failure = true;
  assert.equal((await fetch(f.origin + '/api/waitlist/status')).status, 503);
  f.state.failure = false;
  f.advance(31000);
  assert.equal((await fetch(f.origin + '/api/waitlist/status')).status, 200);
});

test('rate limits cannot be bypassed with a spoofed forwarded header', async t => {
  const f = await setup(t, { rateLimit: 2 });
  const token = await f.token();
  assert.equal((await f.submit({ ...valid, token })).status, 200);
  assert.equal((await f.submit({ ...valid, token })).status, 200);
  const response = await fetch(f.origin + '/api/waitlist', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '1.2.3.4' }, body: JSON.stringify({ ...valid, token }) });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '600');
  f.advance(600001);
  assert.equal((await f.submit({ ...valid, token })).status, 200);
});

test('cross-origin submissions and non-JSON bodies are rejected', async t => {
  const f = await setup(t);
  const token = await f.token();
  const response = await fetch(f.origin + '/api/waitlist', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://unrelated.example' }, body: JSON.stringify({ ...valid, token }) });
  assert.equal(response.status, 403);
  const form = await fetch(f.origin + '/api/waitlist', { method: 'POST', body: 'email=a@example.com' });
  assert.equal(form.status, 415);
  assert.equal(f.state.writes, 0);
});

test('JSON shape, payload size, and method limits are enforced', async t => {
  const f = await setup(t);
  for (const body of ['[1,2]', 'null', '{invalid']) {
    const response = await fetch(f.origin + '/api/waitlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(response.status, 400);
  }
  const oversized = await fetch(f.origin + '/api/waitlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: valid.email, large: 'x'.repeat(5000) }) });
  assert.equal(oversized.status, 413);
  assert.equal((await fetch(f.origin + '/api/waitlist', { method: 'DELETE' })).status, 405);
});

test('only public assets are served; submissions, secrets, source, and directories remain private', async t => {
  const f = await setup(t);
  for (const path of ['/.env', '/.env.example', '/server.mjs', '/lib/supabase.mjs', '/supabase/waitlist.sql', '/api/waitlist', '/api/waitlist?email=eq.interested@example.com', '/assets/', '/%2e%2e/.env', '/tests/fixture.mjs']) {
    assert.equal((await fetch(f.origin + path)).status, 404, path);
  }
  const response = await fetch(f.origin + '/');
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('content-security-policy').includes("connect-src 'self'"));
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(!(await response.text()).includes('test-only-service-role-key'));
  for (const path of ['/styles.css', '/waitlist.js', '/assets/favicon.svg', '/assets/fonts/albert-sans-latin-wght-normal.woff2']) assert.equal((await fetch(f.origin + path)).status, 200);
});

test('Supabase configuration keeps credentials scoped to an HTTPS project', () => {
  assert.equal(storeFromEnvironment({}), null);
  for (const url of ['http://test.supabase.co', 'https://example.com', 'https://test.supabase.co/extra', 'https://username@test.supabase.co', 'https://test.supabase.co?query=1']) {
    assert.throws(() => new SupabaseWaitlistStore({ url, key: 'test' }));
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { fallbackHistory } from '../lib/prices.mjs';
import { createAuditLog, verifyEntries, hashEntry, canonicalJson, validateEvent, GENESIS, KINDS } from '../lib/audit.mjs';
import { listen, close } from './fixture.mjs';

// The shared log reads AUDIT_LOG_FILE on first use, so route tests stay in memory.
process.env.AUDIT_LOG_FILE = 'off';
const settings = { operatorName: 'Test fixture operator', contactEmail: 'fixture@example.invalid', retentionDays: null };
const quiet = { error() {} };

async function app(t) {
  const server = createApp({ store: null, prices: async () => fallbackHistory(), siteSettings: settings });
  const origin = await listen(server);
  t.after(() => close(server));
  return origin;
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dodona-audit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const post = (origin, body, headers = {}) => fetch(origin + '/api/audit/events', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('canonical JSON sorts keys and drops whitespace', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, 'x'], c: null } }), '{"a":{"c":null,"d":[1,"x"]},"b":1}');
});

test('entries chain from the genesis hash and verify', () => {
  const log = createAuditLog({ file: null });
  const first = log.record('system', 'Server started · method v0.1-test');
  const second = log.record('quote', 'Quote · H100 × 64 · call $2.50', { premium: 0.25 }, { ref: 'DEMO-ABC123' });
  assert.equal(first.prevHash, GENESIS);
  assert.equal(second.prevHash, first.hash);
  assert.match(second.hash, /^[a-f0-9]{64}$/);
  assert.equal(second.hash, hashEntry(second, first.hash));
  assert.deepEqual(log.verify(), { ok: true, entries: 2, firstBad: null });
  assert.deepEqual(log.list({ limit: 1 }).map(e => e.id), [second.id]);
  assert.deepEqual(log.list({ kind: 'system' }).map(e => e.id), [first.id]);
});

test('tampering with a past entry is detected', () => {
  const log = createAuditLog({ file: null });
  for (const n of [1, 2, 3]) log.record('mark', `Mark · ${n} positions`);
  const entries = log.list({ limit: 10 }).reverse();
  const edited = entries.map((e, i) => i === 1 ? { ...e, summary: 'Mark · 9 positions' } : e);
  assert.deepEqual(verifyEntries(edited), { ok: false, entries: 3, firstBad: entries[1].id });
  const rehashed = edited.map((e, i) => i === 1 ? { ...e, hash: hashEntry(e, e.prevHash) } : e);
  assert.equal(verifyEntries(rehashed).firstBad, entries[2].id, 'a re-hashed edit breaks the next link');
});

test('the log keeps only the latest entries in memory', () => {
  const log = createAuditLog({ file: null, max: 3 });
  for (const n of [1, 2, 3, 4, 5]) log.record('mark', `Mark ${n}`);
  assert.equal(log.list({ limit: 100 }).length, 3);
  assert.equal(log.verify().ok, true);
});

test('disk append and reload continue the chain', t => {
  const file = join(tempDir(t), 'audit.jsonl');
  const first = createAuditLog({ file, logger: quiet });
  first.record('system', 'Server started');
  const last = first.record('booking_created', 'Booking · H100 × 8', {}, { ref: 'DEMO-XYZ789' });
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 2);
  const reloaded = createAuditLog({ file, logger: quiet });
  const next = reloaded.record('system', 'Server started');
  assert.equal(next.prevHash, last.hash);
  assert.deepEqual(reloaded.verify(), { ok: true, entries: 3, firstBad: null });
  const lines = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(verifyEntries(lines).ok, true);
  writeFileSync(file, readFileSync(file, 'utf8').replace('Booking · H100 × 8', 'Booking · H100 × 80'));
  assert.equal(createAuditLog({ file, logger: quiet }).verify().ok, false);
});

test('an unwritable log file does not crash recording', t => {
  const log = createAuditLog({ file: tempDir(t), logger: quiet });
  assert.equal(log.record('system', 'Server started').prevHash, GENESIS);
  assert.equal(log.file, null);
});

test('event validation strips control characters and refuses personal details', () => {
  assert.equal(validateEvent({ kind: 'rfq', summary: 'RFQ\u0007 · B200 × 128' }).summary, 'RFQ · B200 × 128');
  for (const summary of ['Signup by jane@example.com', 'Call 4155550123', 'Card 4111 1111 1111 1111', 'Phone (415) 555-0123']) {
    assert.throws(() => validateEvent({ kind: 'signup', summary }), /Personal details/, summary);
  }
  assert.doesNotThrow(() => validateEvent({ kind: 'quote', summary: 'Quote · H100 × 64 · 2026-11-16 to 2026-11-23 · call $2.50', ref: 'DEMO-ABC123' }));
  assert.throws(() => validateEvent({ kind: 'quote', summary: 'x', ref: 'not a ref!' }), /ref/);
  assert.throws(() => validateEvent({ kind: 'quote', summary: 'x', data: { note: 'a@b.co' } }), /Personal details/);
  assert.throws(() => validateEvent({ kind: 'quote', summary: 'x'.repeat(201) }), /summary/);
});

test('POST /api/audit/events accepts a valid event and rejects bad ones', async t => {
  const origin = await app(t);
  const ok = await post(origin, { kind: 'booking_created', ref: 'DEMO-ABC123', summary: 'Booking · H100 × 64 · call $2.50', data: { gpuHours: 10752 } });
  assert.equal(ok.status, 202);
  const accepted = await ok.json();
  assert.match(accepted.hash, /^[a-f0-9]{64}$/);
  assert.match(accepted.id, /^[0-9a-f-]{36}$/);

  assert.equal((await post(origin, { kind: 'withdrawal', summary: 'x' })).status, 400);
  assert.equal((await post(origin, { kind: 'signup', summary: 'New signup jane@example.com' })).status, 400);
  assert.equal((await post(origin, { kind: 'quote', summary: 'x', data: { blob: 'y'.repeat(1100) } })).status, 400);
  assert.equal((await post(origin, JSON.stringify({ kind: 'quote', summary: 'z'.repeat(5000) }))).status, 413);
  assert.equal((await post(origin, { kind: 'quote', summary: 'x' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(origin + '/api/audit/events', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
});

test('GET /api/audit returns the newest entries with the chain status', async t => {
  const origin = await app(t);
  await post(origin, { kind: 'quote', summary: 'Quote · H100 × 64 · call $2.50 · fee $0.25/h' });
  await post(origin, { kind: 'mark', summary: 'Mark · 7 positions · net +$596k · Ornn 17 Oct' });
  const response = await fetch(origin + '/api/audit?limit=2');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const feed = await response.json();
  assert.deepEqual(Object.keys(feed).sort(), ['asOf', 'chainOk', 'count', 'entries']);
  assert.equal(feed.count, 2);
  assert.equal(feed.chainOk, true);
  assert.equal(feed.entries[0].kind, 'mark');
  assert.equal(feed.entries[0].prevHash, feed.entries[1].hash);
  assert.deepEqual(Object.keys(feed.entries[0]).sort(), ['data', 'hash', 'id', 'kind', 'prevHash', 'ref', 'summary', 'ts']);
  const quotes = await (await fetch(origin + '/api/audit?kind=quote')).json();
  assert.ok(quotes.entries.every(e => e.kind === 'quote'));
  assert.equal((await fetch(origin + '/api/audit?kind=nope')).status, 400);
});

test('GET /audit renders the page with server-rendered rows and no inline script', async t => {
  const origin = await app(t);
  await post(origin, { kind: 'offer_sent', ref: 'DEMO-OFF001', summary: 'Offer · 93c on H5 <b>' });
  const response = await fetch(origin + '/audit');
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Audit trail/);
  assert.match(html, /Demo data\. Hashes are real\./);
  assert.match(html, /DEMO-OFF001/);
  assert.match(html, /Offer · 93c on H5 &lt;b&gt;/);
  assert.match(html, /<script type="module" src="\/audit\.js"><\/script>/);
  assert.doesNotMatch(html, /<script>/);
  assert.equal(KINDS.filter(kind => html.includes(`data-kind="${kind}"`)).length, KINDS.length);
  assert.match(html, /data-kind="rfq">RFQ</);
  assert.match(html, /<span class="a-kind">Offer<\/span>/);
  for (const path of ['/audit.js', '/audit.css']) assert.equal((await fetch(origin + path)).status, 200, path);
});

test('quotes are audited at most once per client every 15 seconds and marks once per day', async t => {
  let clock = Date.parse('2026-10-20T12:00:00Z');
  const server = createApp({ store: null, prices: async () => fallbackHistory(), siteSettings: settings, now: () => clock });
  const origin = await listen(server);
  t.after(() => close(server));
  const count = async kind => (await (await fetch(`${origin}/api/audit?kind=${kind}&limit=1000`)).json()).count;
  const quoteUrl = `${origin}/api/quote?gpu=H100&count=64&start=2026-11-02T00:00:00Z&end=2026-11-09T00:00:00Z&type=call&strike=2.50&region=US%20East&config=SXM-IB`;

  const quotesBefore = await count('quote');
  for (let i = 0; i < 3; i++) assert.equal((await fetch(quoteUrl)).status, 200);
  assert.equal(await count('quote'), quotesBefore + 1);
  clock += 16000;
  await fetch(quoteUrl);
  assert.equal(await count('quote'), quotesBefore + 2);
  const [latest] = (await (await fetch(`${origin}/api/audit?kind=quote&limit=1`)).json()).entries;
  assert.match(latest.summary, /^Quote · H100 × 64 · 2026-11-02 to 2026-11-09 · call \$2\.50 · fee \$\d+\.\d{2}\/h$/);
  assert.deepEqual(Object.keys(latest.data).sort(), ['asOf', 'method', 'premiumTotal']);
  assert.equal((await fetch(`${origin}/api/quote?gpu=TPU`)).status, 400);
  assert.equal(await count('quote'), quotesBefore + 2);

  const marksBefore = await count('mark');
  for (let i = 0; i < 2; i++) assert.equal((await fetch(`${origin}/api/portfolio`)).status, 200);
  assert.equal(await count('mark'), marksBefore + 1);
  const [mark] = (await (await fetch(`${origin}/api/audit?kind=mark&limit=1`)).json()).entries;
  assert.match(mark.summary, /^Mark · \d+ positions · net [+−]\$[\d,]+k · Ornn \d{4}-\d{2}-\d{2}$/);
});

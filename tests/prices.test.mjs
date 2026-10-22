import test from 'node:test';
import assert from 'node:assert/strict';
import { createPriceSource, parseIndexHistory, fallbackHistory, GPU_API_NAMES } from '../lib/prices.mjs';
import { createApp } from '../server.mjs';
import { listen, close } from './fixture.mjs';

const quiet = { error() {} };
const ornnBody = price => ({
  success: true,
  gpu_type: 'test',
  data: [
    { timestamp: '2026-10-17T20:00:00.000Z', index_value: price + 0.1 },
    { timestamp: '2026-10-16T20:00:00.000Z', index_value: price },
    { timestamp: 'not a date', index_value: 9 },
  ],
});
const okFetch = calls => async url => {
  calls.push(url);
  return { ok: true, json: async () => ornnBody(2) };
};

test('parses index history into sorted daily pairs and drops bad points', () => {
  assert.deepEqual(parseIndexHistory(ornnBody(2)), [['2026-10-16', 2], ['2026-10-17', 2.1]]);
  assert.throws(() => parseIndexHistory({ success: false, data: [] }));
  assert.throws(() => parseIndexHistory({ success: true, data: [{ timestamp: '2026-10-16T00:00:00Z', index_value: 2 }] }));
});

test('live fetch uses the encoded Ornn names and caches for an hour', async () => {
  const calls = [];
  let time = 0;
  const source = createPriceSource({ fetchImpl: okFetch(calls), now: () => time, logger: quiet });
  const first = await source();
  assert.equal(first.live, true);
  assert.equal(first.source, 'ornn');
  assert.equal(first.asOf, '2026-10-17');
  assert.deepEqual(Object.keys(first.data), Object.keys(GPU_API_NAMES));
  assert.ok(calls.includes('https://api.ornnai.com/api/gpu/H100%20SXM/index-history'));
  assert.ok(calls.includes('https://api.ornnai.com/api/gpu/A100%20SXM4/index-history'));
  time += 59 * 60 * 1000;
  await source();
  assert.equal(calls.length, 5);
  time += 2 * 60 * 1000;
  await source();
  assert.equal(calls.length, 10);
});

test('any failed request falls back to the embedded index', async () => {
  const source = createPriceSource({ fetchImpl: async () => ({ ok: false, status: 502 }), logger: quiet });
  const result = await source();
  assert.equal(result.live, false);
  assert.equal(result.asOf, fallbackHistory().asOf);
  assert.ok(result.data.H100.length > 80);
  const thrown = await createPriceSource({ fetchImpl: async () => { throw new Error('offline'); }, logger: quiet })();
  assert.equal(thrown.live, false);
});

test('concurrent callers share one load', async () => {
  const calls = [];
  const source = createPriceSource({ fetchImpl: okFetch(calls), logger: quiet });
  await Promise.all([source(), source(), source()]);
  assert.equal(calls.length, 5);
});

test('GET /api/prices returns the price object with a short public cache', async t => {
  const server = createApp({ store: null, prices: async () => fallbackHistory() });
  const origin = await listen(server);
  t.after(() => close(server));
  const response = await fetch(origin + '/api/prices');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=300');
  const body = await response.json();
  assert.equal(body.live, false);
  assert.ok(Array.isArray(body.data.B200));
});

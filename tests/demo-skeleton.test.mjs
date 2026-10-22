import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { fallbackHistory } from '../lib/prices.mjs';
import { getPortfolio } from '../lib/portfolio.mjs';
import { listen, close } from './fixture.mjs';

const settings = { operatorName: 'Test fixture operator', contactEmail: 'fixture@example.invalid', retentionDays: null };

async function app(t) {
  const server = createApp({ store: null, prices: async () => fallbackHistory(), siteSettings: settings });
  const origin = await listen(server);
  t.after(() => close(server));
  return origin;
}

const apiPlaceholders = [
  ['GET', '/api/portfolio'], ['POST', '/api/signups'],
  ['POST', '/api/contact'], ['POST', '/api/rfq'],
];

test('placeholder API routes return 501 not implemented', async t => {
  const origin = await app(t);
  for (const [method, path] of apiPlaceholders) {
    const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
    assert.equal(response.status, 501, `${method} ${path}`);
    assert.deepEqual(await response.json(), { error: 'not implemented' });
  }
});

test('placeholder pages render a coming soon page', async t => {
  const origin = await app(t);
  for (const path of ['/dashboard', '/signup']) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type'), /^text\/html/);
    assert.match(await response.text(), /Coming soon/);
  }
});

test('pricing and portfolio stubs keep their agreed shapes', async () => {
  assert.deepEqual(await getPortfolio('demo'), { positions: [], asOf: null });
});

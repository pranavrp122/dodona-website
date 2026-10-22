import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { fallbackHistory } from '../lib/prices.mjs';
import { buildBoard, buildContractDetail } from '../lib/contracts.mjs';
import { demoConfirmation, ATTRIBUTION } from '../contracts-view.js';
import samples from '../data/sample-contracts.json' with { type: 'json' };
import { listen, close } from './fixture.mjs';

const today = '2026-10-19';
const now = () => Date.parse(today + 'T12:00:00Z');
const settings = { operatorName: 'Test fixture operator', contactEmail: 'fixture@example.invalid', retentionDays: null };

async function app(t) {
  const server = createApp({ store: null, prices: async () => fallbackHistory(), now, siteSettings: settings });
  const origin = await listen(server);
  t.after(() => close(server));
  return origin;
}

test('sample data has eight labelled contracts, two fleets, and some underwater contracts', () => {
  assert.equal(samples.contracts.length, 8);
  assert.equal(samples.fleets.length, 2);
  assert.ok(samples.contracts.every(c => c.note === 'Sample contract for demonstration. Parties and terms are illustrative.'));
  assert.ok(samples.contracts.filter(c => c.status === 'listed').every(c => Number.isFinite(c.askingCents)));
  const board = buildBoard(fallbackHistory(), { today });
  assert.ok(board.contracts.filter(c => c.valuation.centsOnDollar < 100).length >= 2);
  assert.ok(board.contracts.some(c => c.valuation.remainingHours < c.count * (Date.parse(c.end) - Date.parse(c.start)) / 3600000));
});

test('board totals agree with the contracts', () => {
  const board = buildBoard(fallbackHistory(), { today });
  const hours = board.contracts.reduce((sum, c) => sum + c.valuation.remainingHours, 0);
  assert.equal(board.kpis.remainingHours, hours);
  assert.equal(board.regions.reduce((sum, r) => sum + r.contracts, 0), 8);
  assert.equal(board.prices.live, false);
  assert.ok(board.fleets.every(f => ['ok', 'watch', 'breach'].includes(f.mark.ltvStatus)));
});

test('GET /api/contracts and /api/contracts/<id> return valuations, history, and inputs', async t => {
  const origin = await app(t);
  const board = await (await fetch(origin + '/api/contracts')).json();
  assert.equal(board.contracts.length, 8);
  assert.equal(board.methodVersion, 'v0.1-test');
  const id = board.contracts[0].id;
  const response = await fetch(origin + '/api/contracts/' + id);
  assert.equal(response.status, 200);
  const detail = await response.json();
  assert.equal(detail.contract.id, id);
  assert.equal(detail.history.length, 90);
  assert.equal(detail.contract.valuation.inputs.today, today);
  assert.deepEqual(detail, JSON.parse(JSON.stringify(buildContractDetail(id, fallbackHistory(), { today }))));
});

test('unknown or malformed contract ids return 404 JSON', async t => {
  const origin = await app(t);
  for (const path of ['/api/contracts/nope', '/api/contracts/%3Cscript%3E', '/contracts/nope']) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 404, path);
    assert.match(response.headers.get('content-type'), /application\/json/);
  }
});

test('the board page server-renders a readable no-JS state and honours a region filter', async t => {
  const origin = await app(t);
  const response = await fetch(origin + '/contracts');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  const html = await response.text();
  assert.ok(!html.includes('<!-- C_'));
  assert.equal((html.match(/class="c-row"/g) || []).length, 8);
  assert.ok(html.includes('Contract values · Sample'));
  assert.ok(html.includes('class="region-map'));
  assert.ok(html.includes('Lender view'));
  assert.ok(html.includes(ATTRIBUTION));
  assert.ok(!/\brating\b/i.test(html.replace(/not ratings/g, '')));
  const filtered = await (await fetch(origin + '/contracts?region=Europe')).text();
  assert.equal((filtered.match(/class="c-row" data-region="Europe">/g) || []).length, 2);
  assert.equal((filtered.match(/class="c-row" data-region="[^"]+" hidden>/g) || []).length, 6);
});

test('the contract page server-renders value, chart, term sheet, and the right action', async t => {
  const origin = await app(t);
  const held = samples.contracts.find(c => c.status === 'held');
  const listed = samples.contracts.find(c => c.status === 'listed');
  const heldHtml = await (await fetch(origin + '/contracts/' + held.id)).text();
  assert.ok(heldHtml.includes(held.label));
  assert.ok(heldHtml.includes('class="value-chart"'));
  assert.ok(heldHtml.includes('Term sheet'));
  assert.ok(heldHtml.includes('How this value is computed'));
  assert.ok(heldHtml.includes('List for sale'));
  assert.ok(heldHtml.includes(ATTRIBUTION));
  const listedHtml = await (await fetch(origin + '/contracts/' + listed.id)).text();
  assert.ok(listedHtml.includes('Make an offer'));
  const head = await fetch(origin + '/contracts/' + held.id, { method: 'HEAD' });
  assert.equal(head.status, 200);
});

test('page scripts and styles are served from the same origin', async t => {
  const origin = await app(t);
  for (const path of ['/contracts.css', '/contracts.js', '/contract.js', '/contracts-view.js']) {
    assert.equal((await fetch(origin + path)).status, 200, path);
  }
});

test('demo confirmation explains who pays whom without creating anything', () => {
  assert.match(demoConfirmation('list', 92, 1000000, 85.9), /seller would pay the buyer about \$80\.0K/);
  assert.match(demoConfirmation('offer', 104, 1000000, 110), /buyer would pay the seller about \$40\.0K/);
  assert.match(demoConfirmation('offer', 104, 1000000, 110), /nothing was sent/);
});

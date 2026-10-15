import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../server.mjs';
import { createDemoReservations } from '../lib/demo-reservations.mjs';
import { fixture, listen, close } from './fixture.mjs';

async function connect(t, origin) {
  const client = new Client({ name: 'dodona-test-client', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp')));
  t.after(() => client.close());
  return client;
}
const details = time => ({ gpuType: 'H100', gpuCount: 1, gpuHours: 100, region: 'US East', usageStartsAt: new Date(time + 86400000).toISOString(), usageEndsAt: new Date(time + 6 * 86400000).toISOString(), maxUpfrontUsd: 22, maxTotalIfUsedUsd: 322 });

test('real MCP client discovers tools, resources, questions, and a booking prompt', async t => {
  const server = createApp({ store: null });
  const origin = await listen(server);
  t.after(() => close(server));
  const client = await connect(t, origin);
  assert.match(client.getInstructions(), /No|unavailable/);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['confirm_demo_reservation', 'get_product', 'get_reservation_requirements', 'get_waitlist_status', 'join_waitlist', 'quote_demo_reservation']);
  assert.equal(tools.find(tool => tool.name === 'join_waitlist').annotations.readOnlyHint, false);
  const product = await client.callTool({ name: 'get_product', arguments: {} });
  assert.equal(product.structuredContent.capabilities.purchaseProtection, false);
  assert.equal(product.structuredContent.capabilities.mcp.reservationMode, 'demo_only');
  const requirements = await client.callTool({ name: 'get_reservation_requirements', arguments: {} });
  assert.equal(requirements.structuredContent.mode, 'demo');
  assert.equal(requirements.structuredContent.questions.length, 4);
  assert.ok(requirements.structuredContent.questions[1].question.includes('timezone'));
  const { resources } = await client.listResources();
  assert.deepEqual(resources.map(resource => resource.uri).sort(), ['dodona://guide', 'dodona://product']);
  const guide = await client.readResource({ uri: 'dodona://guide' });
  assert.match(guide.contents[0].text, /No OAuth or API key is required for this demo/);
  const prompt = await client.getPrompt({ name: 'reserve_compute_demo' });
  assert.match(prompt.messages[0].content.text, /ask me to confirm/);
});

test('MCP quote and confirmed receipt remain simulated, repeatable, and do not write signup data', async t => {
  const f = await fixture();
  t.after(() => f.cleanup());
  const client = await connect(t, f.origin);
  const quote = await client.callTool({ name: 'quote_demo_reservation', arguments: details(Date.now()) });
  assert.equal(quote.isError, false);
  const data = quote.structuredContent;
  assert.equal(data.mode, 'demo');
  assert.equal(data.prices.upfrontTotalCents, 2200);
  assert.equal(data.prices.computePaymentIfUsedCents, 30000);
  assert.equal(data.prices.totalIfUsedCents, 32200);
  assert.match(data.disclaimer, /DEMO ONLY/);
  const withoutConfirmation = await client.callTool({ name: 'confirm_demo_reservation', arguments: { quoteToken: data.quoteToken, userConfirmed: false } });
  assert.equal(withoutConfirmation.isError, true);
  const args = { quoteToken: data.quoteToken, userConfirmed: true };
  const receipt = await client.callTool({ name: 'confirm_demo_reservation', arguments: args });
  const repeated = await client.callTool({ name: 'confirm_demo_reservation', arguments: args });
  assert.deepEqual(receipt.structuredContent, repeated.structuredContent);
  assert.equal(receipt.structuredContent.status, 'simulated');
  for (const field of ['paymentCharged', 'capacityHeld', 'realReservationCreated', 'persisted']) assert.equal(receipt.structuredContent[field], false);
  assert.equal(f.rows.size, 0);
  assert.equal(f.state.writes, 0);
  f.advance(15 * 60 * 1000);
  const expired = await client.callTool({ name: 'confirm_demo_reservation', arguments: args });
  assert.equal(expired.isError, true);
  assert.equal(expired.structuredContent.code, 'QUOTE_EXPIRED');
});

test('signed quotes reject altered terms, wrong secrets, invalid windows, unsupported GPUs, and budget overruns', () => {
  let time = Date.now();
  const demos = createDemoReservations({ secret: 'test-only-secret', now: () => time });
  const request = details(time);
  const quote = demos.quote(request);
  const [payload, signature] = quote.quoteToken.split('.');
  const altered = JSON.parse(Buffer.from(payload, 'base64url'));
  altered.prices.upfrontTotalCents = 0;
  const token = Buffer.from(JSON.stringify(altered)).toString('base64url') + '.' + signature;
  assert.throws(() => demos.confirm({ quoteToken: token, userConfirmed: true }), { code: 'INVALID_QUOTE' });
  assert.throws(() => createDemoReservations({ secret: 'another-secret', now: () => time }).confirm({ quoteToken: quote.quoteToken, userConfirmed: true }), { code: 'INVALID_QUOTE' });
  assert.throws(() => demos.confirm({ quoteToken: quote.quoteToken, userConfirmed: false }), { code: 'CONFIRMATION_REQUIRED' });
  for (const patch of [
    { gpuType: 'A100' }, { gpuCount: 0 }, { gpuHours: -1 }, { gpuHours: 1.5 },
    { usageStartsAt: 'tomorrow' }, { usageStartsAt: '2027-02-30T00:00:00Z' },
    { usageStartsAt: '2027-01-01T00:00:00' }, { region: 'bad\nregion' }, { mode: 'live' },
  ]) assert.throws(() => demos.quote({ ...request, ...patch }), { code: 'INVALID_DETAILS' });
  assert.throws(() => demos.quote({ ...request, maxUpfrontUsd: 21.99 }), { code: 'BUDGET_EXCEEDED' });
  assert.throws(() => demos.quote({ ...request, maxTotalIfUsedUsd: 321.99 }), { code: 'BUDGET_EXCEEDED' });
  assert.throws(() => demos.quote({ ...request, usageEndsAt: request.usageStartsAt }), { code: 'INVALID_WINDOW' });
  assert.throws(() => demos.quote({ ...request, usageEndsAt: new Date(time + 2 * 86400000).toISOString() }), { code: 'WINDOW_TOO_SHORT' });
  const parallel = demos.quote({ ...request, gpuCount: 2, usageEndsAt: new Date(time + 4 * 86400000).toISOString() });
  assert.equal(parallel.prices.totalIfUsedCents, quote.prices.totalIfUsedCents);
  time += 2 * 86400000;
  assert.throws(() => demos.confirm({ quoteToken: quote.quoteToken, userConfirmed: true }), { code: 'QUOTE_EXPIRED' });
});

test('MCP waitlist shares validation, tokens, duplicate handling, and limits with the website', async t => {
  const f = await fixture({ rateLimit: 3 });
  t.after(() => f.cleanup());
  const client = await connect(t, f.origin);
  const status = await client.callTool({ name: 'get_waitlist_status', arguments: {} });
  const token = status.structuredContent.token;
  const args = { email: 'mcp-user@example.invalid', userConsent: true, token, interest: 'Business hedging' };
  const noConsent = await client.callTool({ name: 'join_waitlist', arguments: { ...args, userConsent: false } });
  assert.equal(noConsent.isError, true);
  assert.equal(f.state.writes, 0);
  const tooFast = await client.callTool({ name: 'join_waitlist', arguments: args });
  assert.equal(tooFast.structuredContent.code, 'FORM_TOO_FAST');
  assert.equal(tooFast.structuredContent.retryAfterSeconds, 2);
  f.advance(2000);
  const saved = await client.callTool({ name: 'join_waitlist', arguments: args });
  assert.deepEqual(saved.structuredContent, { status: 'saved' });
  const duplicate = await f.submit({ email: args.email, token });
  assert.deepEqual(await duplicate.json(), { status: 'saved' });
  assert.equal(f.rows.size, 1);
  const limited = await client.callTool({ name: 'join_waitlist', arguments: args });
  assert.equal(limited.isError, true);
  assert.equal(limited.structuredContent.code, 'RATE_LIMIT');
  assert.ok(limited.structuredContent.retryAfterSeconds > 0);
  f.rows.clear();
});

test('MCP reports unavailable signup honestly and rejects bad HTTP origin, host, method, and oversized body', async t => {
  const app = createApp({ store: null });
  const origin = await listen(app);
  t.after(() => close(app));
  const client = await connect(t, origin);
  const status = await client.callTool({ name: 'get_waitlist_status', arguments: {} });
  assert.equal(status.structuredContent.available, false);
  assert.equal(status.structuredContent.token, undefined);
  const join = await client.callTool({ name: 'join_waitlist', arguments: { email: 'test@example.invalid', token: 'not-a-real-token', userConsent: true } });
  assert.equal(join.isError, true);
  assert.equal(join.structuredContent.status, 'not_completed');
  for (const method of ['GET', 'DELETE']) assert.equal((await fetch(origin + '/mcp', { method })).status, 405);
  const send = (body, headers = {}) => fetch(origin + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body });
  for (const headers of [{ Origin: 'https://untrusted.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) assert.equal((await send('{}', headers)).status, 403);
  // Node fetch normalizes Host, so use a raw HTTP client to test rebinding protection.
  const wrongHost = await new Promise((resolve, reject) => {
    const request = httpRequest(origin + '/mcp', { method: 'POST', headers: { Host: 'untrusted.example', 'Content-Type': 'application/json' } }, response => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
    request.on('error', reject);
    request.end('{}');
  });
  assert.equal(wrongHost, 403);
  assert.equal((await send(JSON.stringify({ tooLarge: 'x'.repeat(5000) }))).status, 413);
  assert.equal((await send('[{}]')).status, 400);
  assert.equal((await send('{invalid')).status, 400);
  const unsupported = await client.callTool({ name: 'quote_demo_reservation', arguments: { ...details(Date.now()), gpuType: 'A100' } });
  assert.equal(unsupported.isError, true);
});

test('MCP transport rate limit includes initialization and every call', async t => {
  let now = Date.now();
  const app = createApp({ store: null, now: () => now });
  const origin = await listen(app);
  t.after(() => close(app));
  const rpc = () => fetch(origin + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  for (let i = 0; i < 120; i++) assert.equal((await rpc()).status, 200);
  const blocked = await rpc();
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  now += 60001;
  assert.equal((await rpc()).status, 200);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../server.mjs';
import { renderPage, readSiteSettings } from '../lib/site.mjs';
import { fixture, listen, close } from './fixture.mjs';

test('public discovery works without storage and does not imply live trading or successful signup', async t => {
  const server = createApp({ store: null, siteSettings: readSiteSettings({}) });
  const origin = await listen(server);
  t.after(() => close(server));
  for (const [path, type] of [
    ['/agents', 'text/html'], ['/api/site', 'application/json'], ['/openapi.json', 'application/json'],
    ['/llms.txt', 'text/plain'], ['/llms-full.txt', 'text/plain'], ['/robots.txt', 'text/plain'],
  ]) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200, path);
    assert.ok(response.headers.get('content-type').startsWith(type), path);
    assert.ok(response.headers.get('link').includes('/openapi.json'));
    const body = await response.text();
    assert.ok(!body.includes('SUPABASE_SERVICE_ROLE_KEY'));
    assert.ok(!body.includes('test-only-service-role-key'));
    const head = await fetch(origin + path, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(Buffer.byteLength(body)));
    assert.equal(await head.text(), '');
    const write = await fetch(origin + path, { method: 'POST' });
    assert.equal(write.status, path === '/agents' ? 404 : 405);
  }
  const site = await (await fetch(origin + '/api/site')).json();
  assert.equal(site.status, 'in_development');
  for (const capability of ['purchaseProtection', 'trading', 'resale', 'buyback', 'computeAccess']) assert.equal(site.capabilities[capability], false);
  assert.equal(site.capabilities.waitlist.requiresUserConsent, true);
  assert.equal(site.capabilities.waitlist.statusUrl, '/api/waitlist/status');
  assert.equal((await fetch(origin + site.capabilities.waitlist.statusUrl)).status, 503);
  assert.equal((await fetch(origin + '/sitemap.xml')).status, 503);
  assert.ok(!(await (await fetch(origin + '/robots.txt')).text()).includes('Sitemap:'));
});

test('configured discovery uses only the canonical origin, and document links resolve to public routes', async t => {
  const canonical = 'https://dodona.example';
  const f = await fixture({ origin: canonical });
  t.after(() => f.cleanup());
  const site = await (await fetch(f.origin + '/api/site', { headers: { 'X-Forwarded-Host': 'untrusted.example' } })).json();
  for (const link of Object.values(site.links)) {
    const url = new URL(link);
    assert.equal(url.origin, canonical);
    assert.equal((await fetch(f.origin + url.pathname)).status, 200, link);
  }
  const sitemap = await (await fetch(f.origin + '/sitemap.xml')).text();
  assert.ok(sitemap.includes(canonical + '/agents'));
  assert.ok(!sitemap.includes('untrusted.example'));
  const robots = await (await fetch(f.origin + '/robots.txt')).text();
  assert.ok(robots.includes('Sitemap: ' + canonical + '/sitemap.xml'));
  const page = await (await fetch(f.origin + '/agents')).text();
  assert.ok(page.includes('rel="canonical" href="' + canonical + '/agents"'));
});

test('agents can follow the documented token flow without browser JavaScript; limits still apply', async t => {
  const f = await fixture();
  t.after(() => f.cleanup());
  const schema = await (await fetch(f.origin + '/openapi.json')).json();
  assert.equal(schema.openapi, '3.1.0');
  assert.deepEqual(Object.keys(schema.paths).sort(), ['/api/quote', '/api/site', '/api/waitlist', '/api/waitlist/status']);
  const fields = schema.components.schemas.Signup;
  assert.deepEqual(fields.required, ['email', 'token']);
  assert.equal(fields.properties.website.const, '');
  const { token } = await (await fetch(f.origin + '/api/waitlist/status')).json();
  const send = body => fetch(f.origin + '/api/waitlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const submission = { email: 'agent-requested@example.invalid', token, interest: 'Business hedging', useCase: 'User-provided project description', website: '' };
  const tooFast = await send(submission);
  assert.equal(tooFast.status, 429);
  assert.equal(tooFast.headers.get('retry-after'), '2');
  f.advance(2000);
  for (let i = 0; i < 2; i++) {
    const result = await send(submission);
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { status: 'saved' });
  }
  assert.equal(f.rows.size, 1);
  assert.equal(f.rows.get(submission.email).interest, 'Business hedging');
  f.rows.clear();
  const guide = await (await fetch(f.origin + '/llms-full.txt')).text();
  assert.ok(guide.includes('user has asked') || guide.includes('user wants to join'));
  assert.ok(guide.includes('1.5 seconds'));
  assert.ok(guide.includes('Retry-After'));
  assert.ok(guide.includes('not a URL field'));
});

test('machine figures match the visible totals and payout examples', async t => {
  const f = await fixture();
  t.after(() => f.cleanup());
  const { example } = await (await fetch(f.origin + '/api/site')).json();
  const html = await (await fetch(f.origin + '/')).text();
  assert.equal(example.protectionPayment, example.upfrontTotal);
  assert.ok(!('bookingFee' in example), 'no flat per-order fee');
  assert.equal(example.gpuHours * example.rentalPricePerGpuHour, example.computePayment);
  assert.equal(example.computePayment + example.upfrontTotal, example.totalIfUsed);
  assert.equal(example.resale.salePrice - example.resale.fee, example.resale.sellerPayout);
  assert.equal(example.buyback.fundedPurchaseValue - example.buyback.deduction, example.buyback.customerPayout);
  assert.ok(html.includes('$' + example.totalIfUsed + ' total'));
  assert.ok(html.includes('$' + example.resale.sellerPayout.toFixed(2)));
  assert.ok(html.includes('$' + example.buyback.customerPayout.toFixed(2)));
  assert.equal(example.illustrative, true);
  assert.equal(example.finalPricing, false);
});

test('structured data remains valid JSON, escapes script-closing text, and uses a matching CSP hash', async t => {
  const html = renderPage('<!-- STRUCTURED_DATA -->', { settings: { operatorName: '</script><script>bad()</script>', contactEmail: '', retentionDays: null } });
  assert.equal((html.match(/<script/g) || []).length, 1);
  assert.ok(!html.includes('<script>bad()'));
  const escaped = html.match(/<script[^>]*>(.*?)<\/script>/s)[1];
  assert.equal(JSON.parse(escaped)['@graph'][0].name, '</script><script>bad()</script>');
  const f = await fixture({ origin: 'https://dodona.example' });
  t.after(() => f.cleanup());
  const response = await fetch(f.origin + '/');
  const page = await response.text();
  const raw = page.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1];
  const graph = JSON.parse(raw)['@graph'];
  assert.equal(graph[1].url, 'https://dodona.example/');
  assert.ok(!raw.includes('Offer') && !raw.includes('AggregateRating'));
  const hash = createHash('sha256').update(raw).digest('base64');
  assert.ok(response.headers.get('content-security-policy').includes("'sha256-" + hash + "'"));
  assert.ok(!response.headers.get('content-security-policy').includes('unsafe-inline'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readSiteSettings, renderPage } from '../lib/site.mjs';
import { createApp } from '../server.mjs';
import { fixture } from './fixture.mjs';

test('demo privacy uses the owner-provided identity and keeps data until removal is requested', () => {
  const settings = readSiteSettings({});
  const html = renderPage('<!-- PRIVACY_BODY --><!-- CONTACT_LINK -->', { settings });
  assert.ok(html.includes('Dodona operates'));
  assert.ok(html.includes('dodonamarkets@gmail.com'));
  assert.ok(html.includes('until you ask us to remove them'));
});
test('public metadata escapes configured text and uses the canonical site origin', () => {
  const html = renderPage('<!-- OPERATOR_LINE --><!-- SHARE_IMAGE --><!-- CANONICAL -->', {
    settings: { operatorName: '<script>bad</script>', contactEmail: '', retentionDays: null }, origin: 'https://dodona.example',
  });
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('https://dodona.example/assets/social-card.png'));
  assert.ok(html.includes('rel="canonical" href="https://dodona.example/"'));
});
test('production requires an HTTPS origin and a stable private form secret', () => {
  assert.throws(() => createApp({ production: true, store: null, origin: '', tokenSecret: '' }));
  assert.throws(() => createApp({ production: true, store: null, origin: 'http://dodona.example', tokenSecret: 'a'.repeat(32) }));
  assert.throws(() => createApp({ production: true, store: null, origin: 'https://dodona.example', tokenSecret: 'short' }));
});
test('proxy deployments rate-limit visitors independently while ignoring client-prepended identities', async t => {
  const f = await fixture({ trustedProxyCidrs: '127.0.0.1/32', rateLimit: 1 });
  t.after(() => f.cleanup());
  const token = await f.token();
  const submit = forwarded => fetch(f.origin + '/api/waitlist', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': forwarded }, body: JSON.stringify({ email: 'test@example.com', token }) });
  assert.equal((await submit('198.51.100.1')).status, 200);
  assert.equal((await submit('198.51.100.2')).status, 200);
  assert.equal((await submit('203.0.113.9,198.51.100.1')).status, 429);
});
test('privacy and health endpoints reveal no signup records or credentials', async t => {
  const f = await fixture();
  t.after(() => f.cleanup());
  const privacy = await fetch(f.origin + '/privacy');
  assert.equal(privacy.status, 200);
  const html = await privacy.text();
  assert.ok(html.includes('Test fixture operator'));
  assert.ok(!html.includes('test-only-service-role-key'));
  assert.deepEqual(await (await fetch(f.origin + '/healthz')).json(), { status: 'ok' });
  assert.deepEqual(await (await fetch(f.origin + '/readyz')).json(), { waitlistAvailable: true });
});

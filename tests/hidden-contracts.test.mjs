import test from 'node:test';
import assert from 'node:assert/strict';
import samples from '../data/sample-contracts.json' with { type: 'json' };
import { fixture } from './fixture.mjs';

const canonical = 'https://dodona.example';

test('contract values paths answer like an unknown path when the flag is off', async t => {
  const f = await fixture({ origin: canonical });
  t.after(() => f.cleanup());
  const unknown = await fetch(f.origin + '/no-such-page');
  const expected = { status: unknown.status, body: await unknown.text() };
  for (const path of ['/contracts', '/contracts/' + samples.contracts[0].id, '/api/contracts', '/api/contracts/' + samples.contracts[0].id]) {
    const response = await fetch(f.origin + path);
    assert.deepEqual({ status: response.status, body: await response.text() }, expected, path);
  }
});

test('llms.txt and the sitemap leave out contract values when the flag is off', async t => {
  const f = await fixture({ origin: canonical });
  t.after(() => f.cleanup());
  for (const path of ['/llms.txt', '/llms-full.txt', '/sitemap.xml']) {
    const body = await (await fetch(f.origin + path)).text();
    assert.ok(!body.includes('/contracts'), path);
  }
  assert.ok((await (await fetch(f.origin + '/llms.txt')).text()).includes(canonical + '/api/prices'));
});

test('llms.txt and the sitemap list contract values when the flag is on', async t => {
  const f = await fixture({ origin: canonical, contractValues: true });
  t.after(() => f.cleanup());
  assert.ok((await (await fetch(f.origin + '/llms.txt')).text()).includes(canonical + '/api/contracts'));
  assert.ok((await (await fetch(f.origin + '/sitemap.xml')).text()).includes(canonical + '/contracts'));
  assert.equal((await fetch(f.origin + '/contracts')).status, 200);
});

test('no public page links to the hidden contract values board', async t => {
  const f = await fixture({ origin: canonical });
  t.after(() => f.cleanup());
  for (const path of ['/', '/dashboard', '/audit', '/methodology', '/signup', '/contact', '/rfq']) {
    const response = await fetch(f.origin + path);
    assert.equal(response.status, 200, path);
    assert.ok(!(await response.text()).includes('href="/contracts'), path);
  }
});

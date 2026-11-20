import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outputRoot = join(repoRoot, '.vercel', 'output');
const functionRoot = join(outputRoot, 'functions', 'index.func');

test('Vercel bundle serves the app and excludes local state', async () => {
  execFileSync(process.execPath, ['scripts/build-vercel.mjs'], { cwd: repoRoot, stdio: 'inherit' });
  const config = JSON.parse(await readFile(join(outputRoot, 'config.json'), 'utf8'));
  const functionConfig = JSON.parse(await readFile(join(functionRoot, '.vc-config.json'), 'utf8'));
  assert.deepEqual(config, { version: 3, routes: [{ src: '/(.*)', dest: '/index' }] });
  assert.equal(functionConfig.runtime, 'nodejs24.x');
  assert.equal(functionConfig.handler, 'handler.mjs');
  assert.equal(functionConfig.launcherType, 'Nodejs');
  assert.equal(functionConfig.shouldAddHelpers, false);
  await assert.rejects(stat(join(functionRoot, 'app', '.env')));
  await assert.rejects(stat(join(functionRoot, 'app', 'data', 'demo.sqlite')));
  await assert.rejects(stat(join(functionRoot, 'app', 'data', 'audit.jsonl')));

  process.env.APP_ORIGIN = 'https://example.test';
  process.env.WAITLIST_FORM_SECRET = 'v'.repeat(32);
  process.env.AUDIT_LOG_FILE = 'off';
  process.env.DEMO_PLATFORM = '0';
  const { default: handler } = await import(pathToFileURL(join(functionRoot, 'handler.mjs')).href);
  const server = createServer((request, response) => handler(request, response));
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  const request = (path, headers = {}) => fetch(`http://127.0.0.1:${address.port}${path}`, { headers });
  try {
    const home = await request('/');
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Dodona/);
    assert.equal((await request('/styles.css')).status, 200);
    assert.equal((await request('/assets/fonts/open-sans-latin-wght-normal.woff2')).status, 200);
    const video = await request('/assets/media/dashboard-preview.mp4', { Range: 'bytes=0-15' });
    assert.equal(video.status, 206);
    assert.equal((await request('/openapi.json')).status, 200);
  } finally {
    await new Promise(resolveClose => server.close(resolveClose));
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from '../server.mjs';
import { listen, close } from './fixture.mjs';

const media = { mp4: 'video/mp4', webm: 'video/webm', jpg: 'image/jpeg' };

async function start(t) {
  const server = createApp({ store: null });
  const origin = await listen(server);
  t.after(() => close(server));
  return origin;
}

test('the home page shows the dashboard preview with both sources, a poster and a text alternative', async t => {
  const origin = await start(t);
  const response = await fetch(origin + '/');
  assert.match(response.headers.get('content-security-policy'), /media-src 'self'/);
  const html = await response.text();
  const video = html.match(/<video\b[^>]*>/)?.[0] || '';
  for (const word of ['autoplay', 'muted', 'loop', 'playsinline', 'preload="metadata"', 'poster="/assets/media/dashboard-preview.jpg"', 'aria-describedby="preview-desc"']) assert.ok(video.includes(word), word);
  assert.ok(html.includes('<source src="/assets/media/dashboard-preview.webm" type="video/webm">'));
  assert.ok(html.includes('<source src="/assets/media/dashboard-preview.mp4" type="video/mp4">'));
  assert.ok(html.includes('<script src="/home-media.js" defer></script>'));
  assert.equal(html.match(/href="#dashboard"/g)?.length, 2);
  assert.ok(html.includes('href="/sign-in">Try it with a sample account'));
});

test('preview media is served with its type, a long cache and byte ranges', async t => {
  const origin = await start(t);
  for (const [ext, type] of Object.entries(media)) {
    const response = await fetch(`${origin}/assets/media/dashboard-preview.${ext}`);
    assert.equal(response.status, 200, ext);
    assert.equal(response.headers.get('content-type'), type);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=2592000');
    assert.equal((await response.arrayBuffer()).byteLength, (await readFile(new URL(`../assets/media/dashboard-preview.${ext}`, import.meta.url))).length);
  }
  const size = (await readFile(new URL('../assets/media/dashboard-preview.mp4', import.meta.url))).length;
  const part = await fetch(origin + '/assets/media/dashboard-preview.mp4', { headers: { Range: 'bytes=0-99' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 0-99/${size}`);
  assert.equal((await part.arrayBuffer()).byteLength, 100);
  const tail = await fetch(origin + '/assets/media/dashboard-preview.mp4', { headers: { Range: 'bytes=-10' } });
  assert.equal(tail.headers.get('content-range'), `bytes ${size - 10}-${size - 1}/${size}`);
  await tail.arrayBuffer();
  const past = await fetch(origin + '/assets/media/dashboard-preview.mp4', { headers: { Range: `bytes=${size}-` } });
  assert.equal(past.status, 416);
  assert.equal(past.headers.get('content-range'), `bytes */${size}`);
  assert.equal((await fetch(origin + '/home-media.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await fetch(origin + '/assets/media/')).status, 404);
});

test('the preview files stay small enough for the home page', async () => {
  let total = 0;
  for (const ext of Object.keys(media)) total += (await readFile(new URL(`../assets/media/dashboard-preview.${ext}`, import.meta.url))).length;
  assert.ok(total < 3.5 * 1024 * 1024, `${total} bytes`);
});

// The home page explains who Dodona is for, between the cost examples and selling, and the nav links to it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { platformFixture } from './fixture.mjs';

test('home page serves the who-it-is-for section after Costs with both columns and the earnings note', async t => {
  const f = await platformFixture();
  t.after(() => f.cleanup());
  const response = await f.anonymous.get('/');
  assert.equal(response.status, 200);
  const html = response.data;
  const at = id => html.indexOf(`id="${id}"`);
  assert.ok(at('who-its-for') > at('example') && at('who-its-for') < at('flexibility'), 'sits between Costs and Selling');
  const section = html.slice(at('who-its-for'), at('flexibility'));
  for (const text of ['For teams that rent GPUs', 'For neoclouds', 'How Dodona earns', '10,752 GPU-hours', 'href="/offers"', 'href="/sign-in"']) {
    assert.ok(section.includes(text), text);
  }
  assert.equal(html.split('href="#example">Costs</a><a href="#who-its-for">').length - 1, 2, 'main nav and section nav both link it after Costs');
  assert.ok(!/\sstyle="|<script(?![^>]*\ssrc=)/.test(section), 'no inline style or script');
});

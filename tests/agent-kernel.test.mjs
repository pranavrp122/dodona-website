import test from 'node:test';
import assert from 'node:assert/strict';
import { createKernelClient, percentiles } from '../lib/kernel-client.mjs';
import { costMicrocents, TURN_SCHEMA } from '../lib/muse.mjs';
import { black76Delta, createAgentRuntime } from '../lib/agent-runtime.mjs';
import { openDatabase, get } from '../lib/db.mjs';
import { PAID_STATUSES } from '../lib/orders.mjs';
import { seedPlatform } from '../lib/seed.mjs';
import { fallbackHistory } from '../lib/prices.mjs';

const bin = process.env.KERNEL_BIN;
const skip = bin ? false : 'KERNEL_BIN is not set';
const quiet = { error() {} };

test('percentiles and model cost math', () => {
  assert.deepEqual(percentiles([]), { count: 0, p50: null, p90: null, p99: null, max: null });
  assert.equal(percentiles([5, 1, 3]).p50, 3);
  // 1000 uncached prompt tokens at $1.25 per million is 0.125 cents, 100 output tokens at $4.25 per million is 0.0425 cents
  assert.equal(costMicrocents('muse-spark-1.3', { prompt_tokens: 1000, completion_tokens: 100 }), 125000 + 42500);
  assert.equal(costMicrocents('muse-spark-1.3', { prompt_tokens: 1000, cached_tokens: 1000 }), 15000);
  assert.ok(TURN_SCHEMA.required.includes('syscalls'));
});

test('black-76 delta obeys put-call parity and a lock is fully exposed', () => {
  const args = { forward: 2.4, strike: 2.5, vol: 0.6, tEffYears: 0.05, tYears: 0.08, rate: 0.04 };
  const call = black76Delta({ ...args, type: 'call' });
  const put = black76Delta({ ...args, type: 'put' });
  assert.ok(call > 0 && call < 1 && put < 0 && put > -1);
  assert.ok(Math.abs(call - put - Math.exp(-args.rate * args.tYears)) < 1e-9);
  assert.equal(black76Delta({ ...args, type: 'lock' }), 1);
});

test('kernel client round trips spawn and ps over the pipe', { skip }, async t => {
  const kernel = createKernelClient({ bin, logger: quiet });
  t.after(() => kernel.close());
  const spawned = await kernel.call('spawn', { tenant: 'acme', name: 'a', limits: { max_premium_cents: 100 } });
  assert.equal(spawned.ok, true);
  assert.equal(spawned.pid, 1);
  const ps = await kernel.call('ps');
  assert.equal(ps.procs.length, 1);
  assert.equal(ps.procs[0].state, 'blocked');
  assert.ok(kernel.latency().count >= 2);
  const bad = await kernel.call('nope');
  assert.equal(bad.ok, false);
});

test('a scheduled turn books the order that fits and rejects the one that breaks a limit', { skip }, async t => {
  const db = openDatabase(':memory:');
  const history = fallbackHistory();
  const nowMs = Date.parse('2026-10-23T12:00:00Z');
  seedPlatform(db, { history, nowMs });
  const kernel = createKernelClient({ bin, logger: quiet });
  t.after(() => kernel.close());
  // a stand-in model: one absurdly large cap that must trip a limit, then a small at-the-money cap that fits
  const hold = { call: 'hold', kind: 'none', strike_cents: 0, gpu_hours: 0, limit_premium_cents: 0 };
  const replies = [{
    syscalls: [
      { call: 'order', kind: 'cap', strike_cents: 0, gpu_hours: 100000, limit_premium_cents: 0 },
      { call: 'order', kind: 'cap', strike_cents: 0, gpu_hours: 1000, limit_premium_cents: 0 },
    ],
    note: 'test turn',
  }];
  const muse = {
    model: 'fake', effort: 'minimal',
    async turn() {
      const parsed = replies.shift() ?? { syscalls: [hold], note: 'idle' };
      return { parsed, content: JSON.stringify(parsed), usage: { prompt_tokens: 500, cached_tokens: 0, completion_tokens: 40, reasoning_tokens: 10, microcents: 79500 }, ms: 1, model: 'fake', finish: 'stop' };
    },
    async summarize() { return { text: 'summary', usage: {}, ms: 1 }; },
  };
  const runtime = createAgentRuntime({ kernel, muse, boot: async () => db, prices: async () => history, now: () => nowMs, logger: quiet });
  const pid = await runtime.spawn('hedger');
  const [turn] = await runtime.run({ maxTurns: 1 });
  assert.equal(turn.pid, pid);
  assert.deepEqual(turn.accepted, [1]);
  assert.ok(['max_premium', 'max_gpu_hours'].includes(turn.rejected[0].reason));
  assert.equal(turn.orders.length, 1);
  // a paid order asks the neocloud for capacity straight away, so it is already past pending_payment
  assert.ok(PAID_STATUSES.includes(turn.orders[0].status));
  const row = get(db, 'SELECT * FROM orders WHERE ref = ?', turn.orders[0].ref);
  assert.equal(row.kind, 'cap');
  assert.equal(row.gpu, 'H100');
  assert.ok(row.paid_at);
  const { procs } = await runtime.ps();
  assert.equal(procs[0].orders, 1);
  assert.ok(procs[0].premium_spent_cents > 0);
  assert.equal(procs[0].microcents, 79500);
  // nothing is ready until the clock ticks, then the agent runs again and holds within its budget
  assert.deepEqual(await runtime.run({ maxTurns: 1 }), []);
  const tick = await runtime.tick({ days: 1 });
  assert.equal(tick.woken, 1);
  const [second] = await runtime.run({ maxTurns: 1 });
  assert.deepEqual(second.accepted, []);
  assert.ok(second.contextTokens <= 1400);
  const stats = await runtime.stats();
  assert.equal(stats.turns, 2);
  assert.equal(stats.totals.orders, 1);
  assert.ok(stats.pipeMs.count > 0);
});

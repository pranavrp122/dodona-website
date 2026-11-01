/** Runs the agent kernel end to end against the real model on an in-memory platform and prints every turn as a markdown table. */
import { openDatabase } from '../lib/db.mjs';
import { seedPlatform } from '../lib/seed.mjs';
import { fallbackHistory } from '../lib/prices.mjs';
import { createKernelClient } from '../lib/kernel-client.mjs';
import { createMuseClient } from '../lib/muse.mjs';
import { createAgentRuntime, PRESETS } from '../lib/agent-runtime.mjs';

// flags look like --rounds=3 --days=2 --model=muse-spark-1.3 --effort=minimal --concurrency=3
const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')));
const rounds = Number(args.rounds ?? 3);
const days = Number(args.days ?? 2);
const concurrency = Number(args.concurrency ?? 3);

const db = openDatabase(':memory:');
const history = fallbackHistory();
const nowMs = Date.now();
seedPlatform(db, { history, nowMs });
const kernel = createKernelClient();
const muse = createMuseClient({ model: args.model, effort: args.effort });
const runtime = createAgentRuntime({ kernel, muse, boot: async () => db, prices: async () => history, now: () => nowMs });

const cents = micro => (micro / 1000000).toFixed(3);
const short = s => String(s ?? '').replace(/\|/g, '/').slice(0, 70);
const callText = sc => (sc.call === 'hold' ? 'hold' : `${sc.kind} ${sc.strike_cents ?? '?'}c x${sc.gpu_hours ?? '?'}h = ${sc.premium_cents ?? '?'}c${sc.error ? ' !' + sc.error : ''}`);

console.log(`model ${muse.model} effort ${muse.effort} rounds ${rounds} days/round ${days} concurrency ${concurrency}\n`);
for (const preset of PRESETS) console.log(`spawned pid ${await runtime.spawn(preset.key)} ${preset.name} for ${preset.tenant}`);

const turns = [];
for (let round = 0; round < rounds; round++) {
  if (round) await runtime.tick({ days });
  const batch = await runtime.run({ maxTurns: PRESETS.length, concurrency });
  for (const t of batch) turns.push({ round, ...t });
}

console.log('\n| round | pid | agent | ctx tok | dropped | model ms | kernel us | prompt | cached | out | reason | cost c | syscalls | accepted | rejected | orders | note |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const t of turns) {
  const u = t.usage ?? {};
  console.log(`| ${t.round} | ${t.pid} | ${t.name} | ${t.contextTokens} | ${t.dropped} | ${t.modelMs} | ${Math.round(t.kernelNs / 1000)} | ${u.prompt_tokens ?? '-'} | ${u.cached_tokens ?? '-'} | ${u.completion_tokens ?? '-'} | ${u.reasoning_tokens ?? '-'} | ${cents(u.microcents ?? 0)} | ${t.syscalls.map(callText).join('; ') || 'none'} | ${t.accepted.join(',') || '-'} | ${t.rejected.map(r => r.reason).join(',') || '-'} | ${t.orders.map(o => o.ref ?? 'error').join(',') || '-'} | ${short(t.note)} |`);
}

const stats = await runtime.stats();
const { procs } = await runtime.ps();
console.log('\n| pid | agent | state | turns | ctx tok / budget | premium spent c | gpu hours | orders | model cost c |');
console.log('|---|---|---|---|---|---|---|---|---|');
for (const p of procs) console.log(`| ${p.pid} | ${p.name} | ${p.state} | ${p.turns} | ${p.last_context_tokens} / ${p.budget_tokens} | ${p.premium_spent_cents} | ${p.gpu_hours} | ${p.orders} | ${cents(p.microcents)} |`);
console.log(`\nmodel ms p50 ${stats.modelMs.p50} p90 ${stats.modelMs.p90} p99 ${stats.modelMs.p99} max ${stats.modelMs.max} over ${stats.modelMs.count} calls`);
console.log(`pipe round trip ms p50 ${stats.pipeMs.p50?.toFixed(3)} p99 ${stats.pipeMs.p99?.toFixed(3)} over ${stats.pipeMs.count} calls`);
console.log(`kernel avg ns: ${Object.entries(stats.kernel.ops).map(([op, s]) => `${op} ${s.avg_ns}`).join(', ')}`);
console.log(`totals: ${stats.totals.orders} orders, ${stats.totals.rejected} rejected, ${stats.totals.modelErrors} model errors, ${cents(stats.totals.microcents)} cents, ${stats.totals.prompt_tokens} prompt / ${stats.totals.cached_tokens} cached / ${stats.totals.completion_tokens} completion (${stats.totals.reasoning_tokens} reasoning) tokens`);
await kernel.close();

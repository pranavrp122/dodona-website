/** Scores every model and effort setting on the prompts the kernel really sends, so the cheapest trustworthy one can be chosen on numbers. */
import { mkdir, writeFile } from 'node:fs/promises';
import { openDatabase } from '../lib/db.mjs';
import { seedPlatform } from '../lib/seed.mjs';
import { fallbackHistory } from '../lib/prices.mjs';
import { createKernelClient, percentiles } from '../lib/kernel-client.mjs';
import { createMuseClient, TURN_SCHEMA } from '../lib/muse.mjs';
import { createAgentRuntime, PRESETS } from '../lib/agent-runtime.mjs';

// flags look like --models=a,b --efforts=minimal,low --reps=2 --max-tokens=1200 --concurrency=4 --no-schema
const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')));
const models = (args.models ?? 'muse-spark-1.3,muse-spark-1.3-contributor,muse-spark-1.2,muse-spark-1.2-contributor,muse-spark-1.1,muse-wonder-1.0').split(',');
const efforts = (args.efforts ?? 'minimal,low').split(',');
const reps = Number(args.reps ?? 2);
const maxTokens = Number(args['max-tokens'] ?? 1200);
const concurrency = Number(args.concurrency ?? 4);
const useSchema = !('no-schema' in args);

// the prompts come from the kernel itself: three fresh agents, then the same three after two clock ticks with history
async function collectPrompts() {
  const db = openDatabase(':memory:');
  const history = fallbackHistory();
  const nowMs = Date.now();
  seedPlatform(db, { history, nowMs });
  const kernel = createKernelClient({ logger: { error() {} } });
  const hold = { syscalls: [{ call: 'hold', kind: 'none', strike_cents: 0, gpu_hours: 0, limit_premium_cents: 0 }], note: 'eval warmup hold' };
  const muse = { model: 'none', effort: 'none', async turn() { return { parsed: hold, content: JSON.stringify(hold), usage: { prompt_tokens: 600, cached_tokens: 0, completion_tokens: 60, reasoning_tokens: 0, microcents: 0 }, ms: 0, model: 'none', finish: 'stop' }; }, async summarize() { return { text: '', usage: {}, ms: 0 }; } };
  const runtime = createAgentRuntime({ kernel, muse, boot: async () => db, prices: async () => history, now: () => nowMs, logger: { error() {} } });
  for (const preset of PRESETS) await runtime.spawn(preset.key);
  const prompts = [];
  const grab = async label => {
    for (;;) {
      const s = await kernel.call('schedule');
      if (!s.pid) break;
      prompts.push({ id: `${label}-${s.name}`, name: s.name, system: s.system, user: s.user, tokens: s.tokens });
      await kernel.call('submit', { pid: s.pid, syscalls: hold.syscalls, usage: {}, note: hold.note });
    }
  };
  await grab('fresh');
  await runtime.tick({ days: 2 });
  await runtime.run({ maxTurns: 3 });
  await runtime.tick({ days: 2 });
  await grab('turn3');
  await kernel.close();
  return prompts;
}

// a reply is schema valid when it parses and every syscall carries the five fields the kernel reads
function schemaValid(parsed) {
  if (!parsed || !Array.isArray(parsed.syscalls) || typeof parsed.note !== 'string') return false;
  const required = TURN_SCHEMA.properties.syscalls.items.required;
  return parsed.syscalls.every(sc => sc && typeof sc === 'object' && required.every(k => k in sc) && ['order', 'hold'].includes(sc.call));
}

const decisionOf = parsed => (!parsed ? 'none' : parsed.syscalls.some(sc => sc.call === 'order') ? parsed.syscalls.filter(sc => sc.call === 'order').map(sc => sc.kind).join('+') : 'hold');

async function pool(items, worker) {
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await worker(items[i]); }
  }));
  return results;
}

const prompts = await collectPrompts();
console.log(`${prompts.length} prompts from the kernel (${prompts.map(p => p.tokens).join(', ')} tokens), ${models.length} models x ${efforts.length} efforts x ${reps} reps, max tokens ${maxTokens}, schema ${useSchema ? 'on' : 'off'}\n`);

const jobs = [];
for (const model of models) for (const effort of efforts) for (const prompt of prompts) for (let rep = 0; rep < reps; rep++) jobs.push({ model, effort, prompt, rep });
const rows = await pool(jobs, async ({ model, effort, prompt, rep }) => {
  const muse = createMuseClient({ model, effort });
  const started = performance.now();
  try {
    const body = { model, messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }], max_completion_tokens: maxTokens, reasoning_effort: effort };
    if (useSchema) body.response_format = { type: 'json_schema', json_schema: { name: 'kernel_turn', strict: true, schema: TURN_SCHEMA } };
    const reply = await muse.chat(body);
    let parsed = null;
    try { parsed = JSON.parse(reply.content); } catch { parsed = null; }
    return { model, effort, prompt: prompt.id, rep, ms: reply.ms, finish: reply.finish, usage: reply.usage, parsedOk: parsed !== null, schemaOk: schemaValid(parsed), decision: decisionOf(parsed), note: parsed?.note ?? reply.content.slice(0, 80), error: null };
  } catch (error) {
    return { model, effort, prompt: prompt.id, rep, ms: Math.round(performance.now() - started), finish: null, usage: null, parsedOk: false, schemaOk: false, decision: 'error', note: '', error: `${error.status ?? ''} ${error.message}`.trim().slice(0, 120) };
  }
});

const pct = (n, d) => (d ? `${Math.round(100 * n / d)}%` : '-');
const cents = micro => (micro / 1000000).toFixed(3);
console.log('| model | effort | calls | errors | json ok | schema ok | cut off | ms p50 | ms p90 | ms p99 | prompt tok | reason tok | out tok | cost c / turn | decisions |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const model of models) for (const effort of efforts) {
  const group = rows.filter(r => r.model === model && r.effort === effort);
  const ok = group.filter(r => !r.error);
  const ms = percentiles(ok.map(r => r.ms));
  const avg = key => (ok.length ? Math.round(ok.reduce((s, r) => s + (r.usage?.[key] ?? 0), 0) / ok.length) : '-');
  const decisions = Object.entries(group.reduce((m, r) => ({ ...m, [r.decision]: (m[r.decision] ?? 0) + 1 }), {})).map(([k, v]) => `${k} ${v}`).join(', ');
  console.log(`| ${model} | ${effort} | ${group.length} | ${group.length - ok.length} | ${pct(group.filter(r => r.parsedOk).length, group.length)} | ${pct(group.filter(r => r.schemaOk).length, group.length)} | ${pct(ok.filter(r => r.finish === 'length').length, ok.length)} | ${ms.p50 ?? '-'} | ${ms.p90 ?? '-'} | ${ms.p99 ?? '-'} | ${avg('prompt_tokens')} | ${avg('reasoning_tokens')} | ${avg('completion_tokens')} | ${ok.length ? cents(ok.reduce((s, r) => s + r.usage.microcents, 0) / ok.length) : '-'} | ${decisions} |`);
}
const errors = rows.filter(r => r.error);
if (errors.length) {
  console.log('\nerrors:');
  for (const [key, count] of Object.entries(errors.reduce((m, r) => ({ ...m, [`${r.model} ${r.effort}: ${r.error}`]: (m[`${r.model} ${r.effort}: ${r.error}`] ?? 0) + 1 }), {}))) console.log(`- ${count}x ${key}`);
}
await mkdir('artifacts', { recursive: true });
const file = `artifacts/model-eval-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
await writeFile(file, JSON.stringify({ at: new Date().toISOString(), maxTokens, useSchema, reps, prompts: prompts.map(p => ({ id: p.id, tokens: p.tokens })), rows }, null, 2));
console.log(`\nraw results saved to ${file}`);

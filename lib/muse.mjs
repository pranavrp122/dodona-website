/** Meta Model API client for the kernel: one strict json chat completion per agent turn, the summarizer, and usage turned into cost. */
export const MUSE_BASE_URL = 'https://api.meta.ai/v1';
export const DEFAULT_MODEL = 'muse-spark-1.3';
export const DEFAULT_EFFORT = 'minimal';
const TIMEOUT_MS = 60000;

// dollars per million tokens from the meta model api price list, the contributor tier trades training rights for price
export const PRICES = Object.freeze({
  'muse-spark-1.3': { input: 1.25, cached: 0.15, output: 4.25 },
  'muse-spark-1.3-contributor': { input: 0.10, cached: 0.10, output: 0.20 },
  'muse-spark-1.2': { input: 1.25, cached: 0.15, output: 4.25 },
  'muse-spark-1.2-contributor': { input: 0.10, cached: 0.10, output: 0.20 },
  'muse-spark-1.1': { input: 1.25, cached: 0.15, output: 4.25 },
  'muse-wonder-1.0': { input: 1.25, cached: 0.15, output: 4.25 },
});

// the only reply shape the kernel accepts, strict so the model cannot invent a field or skip one
export const TURN_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['syscalls', 'note'],
  properties: {
    syscalls: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['call', 'kind', 'strike_cents', 'gpu_hours', 'limit_premium_cents'],
        properties: {
          call: { type: 'string', enum: ['order', 'hold'] },
          kind: { type: 'string', enum: ['cap', 'floor', 'lock', 'none'] },
          strike_cents: { type: 'integer' },
          gpu_hours: { type: 'integer' },
          limit_premium_cents: { type: 'integer' },
        },
      },
    },
    note: { type: 'string' },
  },
});

/** One dollar is one hundred million microcents, so a token priced in dollars per million costs that price times one hundred microcents. */
export function costMicrocents(model, { prompt_tokens = 0, cached_tokens = 0, completion_tokens = 0 } = {}) {
  const price = PRICES[model] || PRICES[DEFAULT_MODEL];
  const uncached = Math.max(0, prompt_tokens - cached_tokens);
  return Math.round(uncached * price.input * 100 + cached_tokens * price.cached * 100 + completion_tokens * price.output * 100);
}

export class MuseError extends Error {
  constructor(status, message) { super(message); this.status = status; this.code = 'model_error'; }
}

/** The api's usage block flattened, with the hidden reasoning count and the cost in microcents. */
export function normalizeUsage(model, usage = {}) {
  const shaped = {
    prompt_tokens: usage.prompt_tokens ?? 0,
    cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    completion_tokens: usage.completion_tokens ?? 0,
    reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
  };
  return { ...shaped, microcents: costMicrocents(model, shaped) };
}

export function createMuseClient({
  apiKey = process.env.MODEL_API_KEY, baseUrl = MUSE_BASE_URL, model = process.env.KERNEL_MODEL || DEFAULT_MODEL,
  effort = process.env.KERNEL_EFFORT || DEFAULT_EFFORT, gcModel = process.env.KERNEL_GC_MODEL || model, fetchImpl = fetch, timeoutMs = TIMEOUT_MS,
} = {}) {
  if (!apiKey) throw new MuseError(503, 'MODEL_API_KEY is not set.');
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

  async function chat(body) {
    const started = performance.now();
    const response = await fetchImpl(`${baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const ms = Math.round(performance.now() - started);
    if (!response.ok) throw new MuseError(response.status, `The model api answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const data = await response.json();
    const choice = data.choices?.[0];
    return { content: choice?.message?.content ?? '', finish: choice?.finish_reason ?? null, usage: normalizeUsage(body.model, data.usage), ms, model: body.model };
  }

  /** One agent turn: the kernel's system and user frames in, a strict json reply out. */
  async function turn({ system, user, model: turnModel = model, effort: turnEffort = effort, maxTokens = 1200 }) {
    const reply = await chat({
      model: turnModel,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_completion_tokens: maxTokens,
      reasoning_effort: turnEffort,
      response_format: { type: 'json_schema', json_schema: { name: 'kernel_turn', strict: true, schema: TURN_SCHEMA } },
    });
    let parsed = null;
    try { parsed = JSON.parse(reply.content); } catch { parsed = null; }
    return { ...reply, parsed };
  }

  /** The garbage collector: folds evicted history into a short working set the kernel keeps for the agent. */
  async function summarize({ workingSet, evicted, model: gc = gcModel, maxChars = 600 }) {
    const system = `you compress an agent's trading history into at most ${maxChars} characters of plain text. keep positions, limits hit and lessons. drop everything else.`;
    const user = `current memory:\n${workingSet || 'none'}\n\nolder events to fold in:\n${evicted.join('\n')}`;
    const reply = await chat({ model: gc, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_completion_tokens: 300, reasoning_effort: 'minimal' });
    return { ...reply, text: reply.content.slice(0, maxChars) };
  }

  return { turn, summarize, chat, model, effort, gcModel };
}

/** Demo console routes for the agent kernel: spawn preset agents, advance their clocks, run scheduler turns and read the process table. */
import { route, ANY } from './route.mjs';
import { PlatformError, onlyKeys, number, oneOf } from './validate.mjs';
import { createKernelClient } from './kernel-client.mjs';
import { createMuseClient } from './muse.mjs';
import { createAgentRuntime, PRESETS } from './agent-runtime.mjs';

const presetView = p => ({ key: p.key, tenant: p.tenant, name: p.name, weight: p.weight, goal: p.goal, mandate: p.mandate, limits: p.limits });

/** Every /api/kernel route; the runtime starts on first use so a server without a kernel or key still boots. */
export function kernelRoutes(deps, { runtime: injected = null } = {}) {
  let runtime = injected;
  const live = () => {
    if (runtime) return runtime;
    try {
      runtime = createAgentRuntime({ kernel: createKernelClient({ logger: deps.logger }), muse: createMuseClient(), boot: deps.boot, prices: deps.prices, now: deps.now, logger: deps.logger });
    } catch (error) {
      throw new PlatformError(503, 'kernel_unavailable', error.message);
    }
    return runtime;
  };
  // kernel and model failures become 5xx platform errors with their own codes instead of a generic server error
  const wrap = handler => async args => {
    try { return await handler(args); }
    catch (error) {
      if (error instanceof PlatformError) throw error;
      if (error.code === 'model_error') throw new PlatformError(502, 'model_error', error.message);
      if (String(error.code || '').startsWith('kernel_')) throw new PlatformError(503, error.code, error.message);
      throw error;
    }
  };
  return [
    route('GET', '/api/kernel/presets', () => ({ body: { presets: PRESETS.map(presetView) } }), { roles: ANY }),
    route('GET', '/api/kernel/ps', wrap(async () => ({ body: await live().ps() })), { roles: ANY }),
    route('GET', '/api/kernel/stats', wrap(async () => ({ body: await live().stats() })), { roles: ANY }),
    route('GET', '/api/kernel/turns', wrap(async () => ({ body: { turns: live().turns() } })), { roles: ANY }),
    route('GET', '/api/kernel/replay', wrap(async ({ url }) => ({ body: await live().replay(Math.min(500, Number(url.searchParams.get('limit')) || 100)) })), { roles: ANY }),
    route('POST', '/api/kernel/spawn', wrap(async ({ body }) => {
      onlyKeys(body, ['preset']);
      const key = oneOf(body.preset, PRESETS.map(p => p.key), 'Preset');
      return { status: 201, body: { pid: await live().spawn(key) } };
    }), { roles: ANY, body: true }),
    route('POST', '/api/kernel/tick', wrap(async ({ body }) => {
      onlyKeys(body, ['days']);
      const days = body.days === undefined ? 1 : number(body.days, 'Days', { min: 0, max: 30 });
      return { body: await live().tick({ days }) };
    }), { roles: ANY, body: true }),
    route('POST', '/api/kernel/run', wrap(async ({ body }) => {
      onlyKeys(body, ['turns', 'concurrency']);
      const maxTurns = body.turns === undefined ? 6 : number(body.turns, 'Turns', { min: 1, max: 32, integer: true });
      const concurrency = body.concurrency === undefined ? 3 : number(body.concurrency, 'Concurrency', { min: 1, max: 8, integer: true });
      return { body: { turns: await live().run({ maxTurns, concurrency }) } };
    }), { roles: ANY, body: true }),
    route('POST', '/api/kernel/kill', wrap(async ({ body }) => {
      onlyKeys(body, ['pid']);
      await live().kill(number(body.pid, 'Pid', { min: 1, integer: true }));
      return { status: 204 };
    }), { roles: ANY, body: true }),
    route('POST', '/api/kernel/autopilot', wrap(async ({ body }) => {
      onlyKeys(body, ['on', 'intervalMs']);
      if (body.on) live().startAutopilot({ intervalMs: body.intervalMs === undefined ? 15000 : number(body.intervalMs, 'Interval', { min: 3000, max: 120000, integer: true }) });
      else live().stopAutopilot();
      return { body: { autopilot: Boolean(body.on) } };
    }), { roles: ANY, body: true }),
  ];
}

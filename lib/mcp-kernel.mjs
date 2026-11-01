/** MCP tools for the hosted brain mode: an outside agent hands over a goal and limits, and the kernel runs a process for it. */
import { z } from 'zod';
import { runtimeFor } from './kernel-routes.mjs';

const GPUS = ['H100', 'H200', 'B200', 'A100', 'RTX 5090'];
const REGIONS = ['US East', 'US West', 'Europe'];
const HOST_TENANT = 'demo@dodona.markets';

export const intentInput = z.object({
  goal: z.string().min(10).max(600).describe('What the agent should achieve, in plain language. It becomes the process goal the model sees every turn.'),
  gpu: z.enum(GPUS).default('H100'),
  region: z.enum(REGIONS).default('US East'),
  leadDays: z.number().int().min(3).max(300).default(14).describe('How many days ahead the protected window starts.'),
  windowDays: z.number().int().min(1).max(60).default(7),
  maxPremiumUsd: z.number().min(1).max(100000).default(1000).describe('Hard cap on total premium the kernel will ever let this agent spend.'),
  maxGpuHours: z.number().int().min(8).max(100000).default(2000),
  maxOrdersPerTurn: z.number().int().min(1).max(4).default(1),
  weight: z.number().int().min(1).max(5).default(1).describe('Scheduler weight; a heavier agent runs more often within its tenant.'),
}).strict();

// a turn trimmed to what a calling agent needs to know
const turnView = t => ({
  at: t.at, pid: t.pid, name: t.name, note: t.note, contextTokens: t.contextTokens, dropped: t.dropped, modelMs: t.modelMs,
  costMicrocents: t.usage?.microcents ?? 0, syscalls: t.syscalls, accepted: t.accepted, rejected: t.rejected, orders: t.orders,
});

/** Registers submit_intent, run_agents and agent_status on an MCP server; `guard` is the shared error wrapper from mcp.mjs. */
export function registerKernelTools(server, { boot, prices, now, logger, guard }) {
  const runtime = () => runtimeFor({ boot, prices, now, logger });

  server.registerTool('submit_intent', {
    title: 'Hand a trading goal to the agent kernel',
    description: 'Hosted brain mode. The kernel spawns a process for your goal under the demo buyer account, schedules it fairly against other agents, pages its history into a fixed token budget, and risk-gates every order it attempts against the limits you set. Nothing runs until run_agents is called. Demo only: mock payments, no real compute.',
    inputSchema: intentInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, guard(async args => {
    const preset = {
      key: 'intent', tenant: HOST_TENANT, name: `intent-${now().toString(36).slice(-5)}`, weight: args.weight, budgetTokens: 1400, goal: args.goal,
      mandate: { gpu: args.gpu, region: args.region, config: 'SXM-IB', leadDays: args.leadDays, windowDays: args.windowDays },
      limits: {
        max_premium_cents: Math.round(args.maxPremiumUsd * 100), max_gpu_hours: args.maxGpuHours, max_abs_delta_bps: args.maxGpuHours * 10000,
        strike_band_bps: 2000, max_slippage_bps: 300, max_orders_per_turn: args.maxOrdersPerTurn,
      },
    };
    const pid = await runtime().spawn(preset);
    return { status: 'scheduled', pid, name: preset.name, mode: 'hosted_brain', limits: preset.limits, next: 'Call run_agents to let the kernel run a round, then agent_status with this pid.' };
  }));

  server.registerTool('run_agents', {
    title: 'Run one scheduler round',
    description: 'Advances the demo clock by `days`, wakes every agent with the new market and any settlement events, then runs up to `turns` scheduler turns through the model. Costs real model tokens. Demo only.',
    inputSchema: z.object({ days: z.number().min(0).max(30).default(1), turns: z.number().int().min(1).max(12).default(4) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, guard(async ({ days, turns }) => {
    const live = runtime();
    const ticked = await live.tick({ days });
    const ran = await live.run({ maxTurns: turns });
    return { ticked, turns: ran.map(turnView) };
  }));

  server.registerTool('agent_status', {
    title: 'Read one agent from the process table',
    description: 'The kernel process table row for a pid (state, context tokens against budget, exposure, cost) and its last five turns.',
    inputSchema: z.object({ pid: z.number().int().min(1) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, guard(async ({ pid }) => {
    const live = runtime();
    const { procs } = await live.ps();
    const row = procs.find(p => p.pid === pid);
    if (!row) throw Object.assign(new Error('No agent with that pid.'), { status: 404, code: 'not_found' });
    return { process: row, turns: live.turns().filter(t => t.pid === pid).slice(0, 5).map(turnView) };
  }));
}

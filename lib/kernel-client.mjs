/** The C++ agent kernel as a child process: one json object per line each way over stdio, replies matched to requests by id. */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const CALL_TIMEOUT_MS = 5000;
const SAMPLE_LIMIT = 5000;

/** p50, p90, p99 and max of a list of numbers, or nulls when the list is empty. */
export function percentiles(samples) {
  if (!samples.length) return { count: 0, p50: null, p90: null, p99: null, max: null };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = q => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
  return { count: sorted.length, p50: at(0.5), p90: at(0.9), p99: at(0.99), max: sorted.at(-1) };
}

export class KernelError extends Error {
  constructor(message, code = 'kernel_error') { super(message); this.code = code; }
}

/** Starts the kernel lazily on the first call and starts it again if it ever exits. */
export function createKernelClient({ bin = process.env.KERNEL_BIN, logger = console, spawnImpl = spawn, timeoutMs = CALL_TIMEOUT_MS } = {}) {
  if (!bin) throw new KernelError('KERNEL_BIN is not set. Build the kernel and point KERNEL_BIN at build/kernel.exe.', 'kernel_unavailable');
  let child = null;
  let nextId = 1;
  const pending = new Map();
  const samples = [];

  // every caller still waiting gets the same failure so nothing hangs when the process dies
  function fail(error) {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  }

  function start() {
    child = spawnImpl(bin, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    createInterface({ input: child.stdout }).on('line', line => {
      let reply;
      try { reply = JSON.parse(line); } catch { logger.error('[kernel] Dropped an unreadable reply.'); return; }
      const entry = pending.get(reply.id);
      if (!entry) return;
      pending.delete(reply.id);
      clearTimeout(entry.timer);
      // the round trip of the pipe plus the kernel itself, kept for the latency table
      samples.push(performance.now() - entry.started);
      if (samples.length > SAMPLE_LIMIT) samples.shift();
      entry.resolve(reply);
    });
    child.stderr.on('data', chunk => logger.error(`[kernel] ${String(chunk).trim()}`));
    child.on('error', error => { child = null; fail(new KernelError(`The kernel could not start: ${error.message}`, 'kernel_unavailable')); });
    child.on('exit', code => { child = null; fail(new KernelError(`The kernel exited with code ${code}.`, 'kernel_exited')); });
  }

  /** Sends one operation and resolves with the kernel's reply object. */
  function call(op, fields = {}) {
    if (!child) start();
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new KernelError(`The kernel did not answer ${op} in time.`, 'kernel_timeout')); }, timeoutMs);
      pending.set(id, { resolve, reject, timer, started: performance.now() });
      child.stdin.write(JSON.stringify({ id, op, ...fields }) + '\n', error => {
        if (!error) return;
        clearTimeout(timer);
        pending.delete(id);
        reject(new KernelError(`Could not write to the kernel: ${error.message}`, 'kernel_write'));
      });
    });
  }

  async function close() {
    if (!child) return;
    const current = child;
    child = null;
    current.stdin.end();
    await new Promise(resolve => current.once('exit', resolve));
  }

  return { call, close, latency: () => percentiles(samples), get alive() { return child !== null; } };
}

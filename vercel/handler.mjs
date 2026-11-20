import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app/server.mjs';

function runtimeOrigin() {
  if (process.env.APP_ORIGIN) return process.env.APP_ORIGIN;
  if (process.env.VERCEL_ENV === 'preview' && process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return '';
}

function configureEphemeralState() {
  if (!process.env.AUDIT_LOG_FILE) process.env.AUDIT_LOG_FILE = join(tmpdir(), 'dodona-audit.jsonl');
  if (process.env.DEMO_PLATFORM === '1' && !process.env.DEMO_DB_FILE) {
    process.env.DEMO_DB_FILE = join(tmpdir(), 'dodona-demo.sqlite');
  }
}

let app;
function getApp() {
  if (!app) {
    configureEphemeralState();
    app = createApp({
      origin: runtimeOrigin(),
      production: true,
      contractValues: process.env.SHOW_CONTRACT_VALUES === '1',
    });
  }
  return app;
}

export default function handler(request, response) {
  return getApp().emit('request', request, response);
}

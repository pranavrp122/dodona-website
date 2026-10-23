/** Demo platform database: node:sqlite with WAL, small row helpers and transactions. Separate from Supabase on purpose. */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { applySchema } from './schema.mjs';

export const DEFAULT_DB_FILE = fileURLToPath(new URL('../data/demo.sqlite', import.meta.url));
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const depth = new WeakMap();

/** Opens (and creates) the demo database. `:memory:` gives a private in-memory database for tests. */
export function openDatabase(file = process.env.DEMO_DB_FILE || DEFAULT_DB_FILE) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  applySchema(db);
  return db;
}

/** Runs fn inside a transaction (a savepoint when nested); rolls back on any error. */
export function transaction(db, fn) {
  const level = depth.get(db) || 0;
  const name = `sp${level}`;
  db.exec(level ? `SAVEPOINT ${name}` : 'BEGIN IMMEDIATE');
  depth.set(db, level + 1);
  try {
    const result = fn();
    db.exec(level ? `RELEASE ${name}` : 'COMMIT');
    return result;
  } catch (error) {
    db.exec(level ? `ROLLBACK TO ${name}; RELEASE ${name}` : 'ROLLBACK');
    throw error;
  } finally {
    depth.set(db, level);
  }
}

// Table and column names below come from this codebase only, never from requests.
export function insert(db, table, row, at = new Date().toISOString()) {
  const full = { created_at: at, updated_at: at, ...row };
  const keys = Object.keys(full);
  db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map(k => full[k] ?? null));
  return full;
}

export function update(db, table, where, fields, at = new Date().toISOString()) {
  const full = { ...fields, updated_at: at };
  const keys = Object.keys(full);
  const whereKeys = Object.keys(where);
  const sql = `UPDATE ${table} SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE ${whereKeys.map(k => `${k} = ?`).join(' AND ')}`;
  return db.prepare(sql).run(...keys.map(k => full[k] ?? null), ...whereKeys.map(k => where[k])).changes;
}

export const all = (db, sql, ...params) => db.prepare(sql).all(...params);
export const get = (db, sql, ...params) => db.prepare(sql).get(...params);

export const newId = prefix => `${prefix}_${randomBytes(8).toString('hex')}`;

/** A short human order reference such as DOD-KMRTQX (letters only, so it never looks like a card or phone number). */
export function newRef(prefix = 'DOD') {
  const bytes = randomBytes(6);
  return `${prefix}-${[...bytes].map(b => REF_ALPHABET[b % REF_ALPHABET.length]).join('')}`;
}

export const nextSeq = (db, table) => get(db, `SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM ${table}`).n;

export function parseJson(text, fallback = null) {
  if (text == null) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

export function getMeta(db, key) {
  return get(db, 'SELECT value FROM meta WHERE key = ?', key)?.value ?? null;
}

export function setMeta(db, key, value, at = new Date().toISOString()) {
  db.prepare('INSERT INTO meta (key, value, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(key, String(value), at, at);
}

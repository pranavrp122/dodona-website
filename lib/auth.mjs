/** Demo accounts and sessions: scrypt password hashes with per-user salts, timing-safe compare, and an HttpOnly session cookie. */
import { scrypt as scryptCallback, scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { insert, update, get, newId, transaction } from './db.mjs';
import { createNeocloud, neocloudView } from './neocloud.mjs';
import { sendEmail } from './outbox.mjs';
import * as v from './validate.mjs';

const scrypt = promisify(scryptCallback);
const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 });
export const COOKIE = 'dodona_session';
export const SESSION_MS = 7 * 24 * 3600 * 1000;
export const ROLES = Object.freeze(['buyer', 'lender', 'provider', 'admin']);
export const SIGN_UP_ROLES = Object.freeze(['buyer', 'lender', 'provider']);
export const HOMES = Object.freeze({ buyer: '/dashboard', lender: '/dashboard', provider: '/provider', admin: '/admin' });

const encode = (salt, hash) => `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${hash.toString('hex')}`;
const options = { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem };

export async function hashPassword(password) {
  const salt = randomBytes(16);
  return encode(salt, await scrypt(password, salt, SCRYPT.keylen, options));
}

export function hashPasswordSync(password) {
  const salt = randomBytes(16);
  return encode(salt, scryptSync(password, salt, SCRYPT.keylen, options));
}

let dummyHash;
/** Compares in constant time; an unknown account still pays for one scrypt run so timing does not reveal it. */
export async function verifyPassword(password, stored) {
  const parts = (stored || (dummyHash ??= hashPasswordSync(randomBytes(8).toString('hex')))).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltHex, hashHex] = parts;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return timingSafeEqual(actual, expected) && Boolean(stored);
}

const tokenHash = token => createHash('sha256').update(token).digest('hex');

export function createSession(db, accountId, nowMs) {
  const token = randomBytes(32).toString('hex');
  const at = new Date(nowMs).toISOString();
  insert(db, 'sessions', { token_hash: tokenHash(token), account_id: accountId, expires_at: new Date(nowMs + SESSION_MS).toISOString() }, at);
  update(db, 'accounts', { id: accountId }, { last_active_at: at }, at);
  return token;
}

export function readCookie(request) {
  for (const part of (request.headers.cookie || '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) {
      const value = rest.join('=');
      return /^[a-f0-9]{64}$/.test(value) ? value : null;
    }
  }
  return null;
}

/** The signed-in account for this request, or null. Expired sessions are deleted on sight. */
export function sessionAccount(db, request, nowMs) {
  const token = readCookie(request);
  if (!token) return null;
  const session = get(db, 'SELECT account_id, expires_at FROM sessions WHERE token_hash = ?', tokenHash(token));
  if (!session) return null;
  if (Date.parse(session.expires_at) <= nowMs) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
    return null;
  }
  const account = get(db, 'SELECT * FROM accounts WHERE id = ?', session.account_id);
  if (account && (!account.last_active_at || nowMs - Date.parse(account.last_active_at) > 60000)) {
    const at = new Date(nowMs).toISOString();
    update(db, 'accounts', { id: account.id }, { last_active_at: at }, at);
  }
  return account || null;
}

export function deleteSession(db, request) {
  const token = readCookie(request);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
}

export const sessionCookie = (token, secure) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`;
export const clearCookie = secure => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;

/** Inserts an account (and a fresh mock neocloud for a provider) with a precomputed hash. */
export function createAccount(db, { email, passwordHash, company, role, kyb = 'pending', stage = 'demo', phone = '', seedKey = null, capacity, neocloudId, at }) {
  if (get(db, 'SELECT 1 AS x FROM accounts WHERE email = ?', email)) throw v.conflict('An account with this email already exists. Sign in instead.', 'email_taken');
  return transaction(db, () => {
    const id = newId('acc');
    insert(db, 'accounts', { id, email, password_hash: passwordHash, company, role, kyb, stage, phone, demo_now: at, scenario: 'market', seed_key: seedKey }, at);
    if (role === 'provider') {
      const nc = neocloudId ?? createNeocloud(db, { name: company, capacity, ownerAccountId: id, at });
      if (neocloudId) update(db, 'neoclouds', { id: nc }, { owner_account_id: id }, at);
      update(db, 'accounts', { id }, { neocloud_id: nc }, at);
    }
    sendEmail(db, { accountId: id, template: 'welcome', at });
    return get(db, 'SELECT * FROM accounts WHERE id = ?', id);
  });
}

export function parseSignUp(body, roles = SIGN_UP_ROLES) {
  return {
    email: v.email(body.email), password: v.password(body.password),
    company: v.text(body.company, 'Company', { max: 80 }), role: v.oneOf(body.role, roles, 'Role'),
  };
}

export async function signUp(db, body, nowMs) {
  v.onlyKeys(body, ['email', 'password', 'company', 'role']);
  const input = parseSignUp(body);
  const passwordHash = await hashPassword(input.password);
  return createAccount(db, { ...input, passwordHash, at: new Date(nowMs).toISOString() });
}

export async function signIn(db, body) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const account = email && email.length <= 254 && password.length <= 128 ? get(db, 'SELECT * FROM accounts WHERE email = ?', email) : null;
  const ok = await verifyPassword(password, account?.password_hash);
  if (!ok || !account) throw new v.PlatformError(401, 'bad_credentials', 'That email and password do not match a demo account.');
  return account;
}

/** The account as the browser sees it: never the password hash. */
export function accountView(db, row) {
  const neocloud = row.neocloud_id ? neocloudView(get(db, 'SELECT * FROM neoclouds WHERE id = ?', row.neocloud_id)) : null;
  return {
    id: row.id, email: row.email, company: row.company, role: row.role, kyb: row.kyb, stage: row.stage, phone: row.phone,
    demoNow: row.demo_now, scenario: row.scenario, neocloud: neocloud && { id: neocloud.id, name: neocloud.name },
    autoConfirm: neocloud ? neocloud.autoConfirm : null, home: HOMES[row.role], lastActiveAt: row.last_active_at, createdAt: row.created_at,
  };
}

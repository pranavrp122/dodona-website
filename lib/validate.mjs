/** Demo platform request validation and the error type every platform route throws. */

export class PlatformError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export const invalid = (message, code = 'invalid') => new PlatformError(400, code, message);
export const notFound = (message = 'Not found.') => new PlatformError(404, 'not_found', message);
export const conflict = (message, code = 'conflict') => new PlatformError(409, code, message);
export const forbidden = (message = 'This account cannot do that.') => new PlatformError(403, 'forbidden', message);
export const signedOut = () => new PlatformError(401, 'signed_out', 'Sign in to continue.');

const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/;
const CONTROL = /[\x00-\x1f\x7f]/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export function email(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const [local = '', domain = ''] = text.split('@');
  const ok = text.length <= 254 && local.length <= 64 && EMAIL.test(text) && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..') &&
    domain.split('.').every(label => label && label.length <= 63 && !label.startsWith('-') && !label.endsWith('-'));
  if (!ok) throw invalid('Enter a valid email address.', 'invalid_email');
  return text;
}

export function password(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) throw invalid('Use a password of 8 to 128 characters.', 'invalid_password');
  return value;
}

export function text(value, name, { min = 1, max = 120, optional = false } = {}) {
  if (value == null && optional) return null;
  if (typeof value !== 'string') throw invalid(`${name} is required.`);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max || CONTROL.test(trimmed)) throw invalid(`${name} must be ${min} to ${max} characters.`);
  return trimmed;
}

export function oneOf(value, allowed, name) {
  if (!allowed.includes(value)) throw invalid(`${name} must be one of ${allowed.join(', ')}.`);
  return value;
}

export function number(value, name, { min = -Infinity, max = Infinity, integer = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw invalid(`${name} must be ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}.`);
  }
  return value;
}

export function isoTime(value, name) {
  if (typeof value !== 'string' || !ISO.test(value) || !Number.isFinite(Date.parse(value))) throw invalid(`${name} must be an ISO date and time, for example 2026-11-02T09:00:00Z.`);
  return new Date(Date.parse(value)).toISOString();
}

/** Rejects keys the route does not know, so typos fail loudly instead of being ignored. */
export function onlyKeys(body, allowed) {
  const extra = Object.keys(body).filter(key => !allowed.includes(key));
  if (extra.length) throw invalid(`Unknown field ${extra[0]}.`);
  return body;
}

export const roundCents = value => Math.round(value * 100) / 100;
export const round4 = value => Math.round(value * 10000) / 10000;

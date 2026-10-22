// Shared rules and browser client for the signup, contact and quote-request forms.
// The server imports validateForm from this file, so both sides apply the same checks.

export const ROLES = Object.freeze(['buyer', 'provider', 'lender', 'other']);
export const RFQ_GPUS = Object.freeze(['H100', 'H200', 'B200', 'A100']);
export const RFQ_TYPES = Object.freeze(['cap', 'lock', 'floor']);
const MAX_GPU_COUNT = 100000;
const MAX_STRIKE = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const EMAIL_PATTERN = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/;
const WEBSITE_PATTERN = /^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,63}(:\d{1,5})?(\/\S*)?$/i;
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

class FieldError extends Error {
  constructor(field, message) { super(message); this.field = field; }
}

function text(body, field, { max, required = false, label }) {
  const raw = body[field];
  if (raw != null && typeof raw !== 'string') throw new FieldError(field, `${label} must be text.`);
  const value = (raw ?? '').trim();
  if (required && !value) throw new FieldError(field, `Enter ${label.toLowerCase()}.`);
  if (value.length > max) throw new FieldError(field, `Keep ${label.toLowerCase()} to ${max} characters or fewer.`);
  if (CONTROL_CHARS.test(value)) throw new FieldError(field, `Remove unusual characters from ${label.toLowerCase()}.`);
  return value;
}

function email(body) {
  const value = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const [local = '', domain = ''] = value.split('@');
  const valid = value.length <= 254 && local.length > 0 && local.length <= 64 && EMAIL_PATTERN.test(value) &&
    !local.startsWith('.') && !local.endsWith('.') && !local.includes('..') &&
    domain.split('.').every(part => part && part.length <= 63 && !part.startsWith('-') && !part.endsWith('-'));
  if (!valid) throw new FieldError('email', 'Enter a valid email address.');
  return value;
}

function choice(body, field, options, message) {
  if (typeof body[field] !== 'string' || !options.includes(body[field])) throw new FieldError(field, message);
  return body[field];
}

function honeypot(body) {
  if (body.nickname != null && body.nickname !== '') throw new FieldError(null, 'We couldn’t accept this submission.');
}

function date(body, field, label) {
  const raw = typeof body[field] === 'string' ? body[field].trim() : '';
  const value = DATE_PATTERN.test(raw) ? new Date(raw.length === 10 ? `${raw}T00:00:00Z` : raw) : null;
  if (!value || Number.isNaN(value.getTime())) throw new FieldError(field, `Enter a valid ${label} date.`);
  return value;
}

function number(body, field, { label, integer = false, min, max, required = true }) {
  const raw = typeof body[field] === 'number' ? String(body[field]) : typeof body[field] === 'string' ? body[field].trim() : '';
  if (!raw && !required) return null;
  const value = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max) {
    throw new FieldError(field, `Enter ${label} between ${min} and ${max.toLocaleString('en-US')}.`);
  }
  return value;
}

const validators = {
  signup(body) {
    honeypot(body);
    const value = {
      email: email(body),
      company: text(body, 'company', { max: 120, required: true, label: 'Your company' }),
      role: choice(body, 'role', ROLES, 'Choose your role.'),
      useCase: text(body, 'useCase', { max: 280, label: 'What you want to do' }),
      website: text(body, 'website', { max: 200, label: 'Website' }),
    };
    if (value.website && !WEBSITE_PATTERN.test(value.website)) throw new FieldError('website', 'Enter a website like example.com.');
    if (body.business !== true) throw new FieldError('business', 'Business accounts only: confirm you are signing up for a business.');
    return value;
  },
  contact(body) {
    honeypot(body);
    return {
      name: text(body, 'name', { max: 80, required: true, label: 'Your name' }),
      email: email(body),
      company: text(body, 'company', { max: 120, label: 'Company' }),
      message: text(body, 'message', { max: 2000, required: true, label: 'A message' }),
    };
  },
  rfq(body, now) {
    honeypot(body);
    const value = {
      email: email(body),
      company: text(body, 'company', { max: 120, required: true, label: 'Your company' }),
      gpu: choice(body, 'gpu', RFQ_GPUS, 'Choose a GPU.'),
      count: number(body, 'count', { label: 'a GPU count', integer: true, min: 1, max: MAX_GPU_COUNT }),
      start: date(body, 'start', 'start'),
      end: date(body, 'end', 'end'),
      type: choice(body, 'type', RFQ_TYPES, 'Choose a contract type.'),
      strike: number(body, 'strike', { label: 'a price per GPU-hour', min: 0.01, max: MAX_STRIKE, required: false }),
      notes: text(body, 'notes', { max: 500, label: 'Notes' }),
    };
    // One day of slack so a visitor west of UTC can still pick today.
    if (value.start.getTime() < now - DAY_MS) throw new FieldError('start', 'Pick a start date that has not passed.');
    if (value.end <= value.start) throw new FieldError('end', 'Pick an end date after the start date.');
    return { ...value, start: value.start.toISOString(), end: value.end.toISOString() };
  },
};

export const FORM_KINDS = Object.freeze(Object.keys(validators));

// Returns { ok: true, value } or { ok: false, field, message }.
export function validateForm(kind, body, now = Date.now()) {
  if (!validators[kind]) return { ok: false, field: null, message: 'Unknown form.' };
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, field: null, message: 'Please submit a valid form.' };
  try { return { ok: true, value: validators[kind](body, now) }; }
  catch (error) {
    if (error instanceof FieldError) return { ok: false, field: error.field, message: error.message };
    throw error;
  }
}

// ---- Browser client ----

const TOKEN_MIN_AGE_MS = 1600;
const REQUEST_TIMEOUT_MS = 12000;

function readValues(form) {
  const values = {};
  for (const element of form.elements) {
    if (!element.name) continue;
    values[element.name] = element.type === 'checkbox' ? element.checked : element.value;
  }
  return values;
}

function prefillFromQuery(form) {
  const params = new URLSearchParams(location.search);
  for (const element of form.elements) {
    if (element.name && element.name !== 'nickname' && params.has(element.name) && element.type !== 'checkbox') {
      element.value = params.get(element.name).slice(0, 200);
    }
  }
}

function initForm(form) {
  const kind = form.dataset.form;
  const button = form.querySelector('button[type=submit]');
  const message = form.querySelector('.form-message');
  const idleLabel = button.textContent;
  let token = null;
  let readyAt = 0;
  let sending = false;

  const announce = (textValue, state) => { message.textContent = textValue; message.dataset.state = state; };

  function clearErrors() {
    for (const element of form.querySelectorAll('[aria-invalid=true]')) element.removeAttribute('aria-invalid');
    for (const error of form.querySelectorAll('.field-error')) { error.hidden = true; error.textContent = ''; }
  }

  function showFieldError(field, textValue) {
    const named = field && form.elements.namedItem(field);
    // Radio groups come back as a list; mark the first option.
    const element = named && (named.setAttribute ? named : named[0]);
    const error = field && document.getElementById(`${field}-error`);
    if (!element || !error) return;
    element.setAttribute('aria-invalid', 'true');
    error.textContent = textValue;
    error.hidden = false;
    element.focus();
  }

  async function fetchToken() {
    try {
      const response = await fetch(`/api/forms/status?form=${encodeURIComponent(kind)}`, { cache: 'no-store', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const data = await response.json();
      token = response.ok && typeof data.token === 'string' ? data.token : null;
    } catch { token = null; }
    readyAt = performance.now() + TOKEN_MIN_AGE_MS;
    return token;
  }

  function finish(event, status, values) {
    form.dispatchEvent(new CustomEvent(event, { detail: { status, values } }));
  }

  async function post(body) {
    await new Promise(resolve => setTimeout(resolve, Math.max(0, readyAt - performance.now())));
    const response = await fetch(form.getAttribute('action'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, token }), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { response, data: await response.json().catch(() => ({})) };
  }

  form.addEventListener('input', event => {
    if (event.target.getAttribute?.('aria-invalid') !== 'true') return;
    event.target.removeAttribute('aria-invalid');
    const error = document.getElementById(`${event.target.name}-error`);
    if (error) error.hidden = true;
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (sending) return;
    clearErrors();
    const values = readValues(form);
    const check = validateForm(kind, values);
    if (!check.ok) {
      showFieldError(check.field, check.message);
      announce(check.message, 'error');
      return;
    }
    sending = true;
    button.disabled = true;
    form.setAttribute('aria-busy', 'true');
    button.textContent = 'Sending…';
    announce('Sending…', 'loading');
    try {
      let { response, data } = await post(values);
      if (data.code === 'FORM_EXPIRED' || data.code === 'FORM_TOO_FAST') {
        await fetchToken();
        ({ response, data } = await post(values));
      }
      if (response.ok) {
        announce(form.dataset.success, 'success');
        if (kind !== 'signup') form.reset();
        finish('dodona:saved', data.status, values);
      } else if (response.status === 503) {
        announce(form.dataset.unavailable || data.message, 'unavailable');
        finish('dodona:unavailable', 'unavailable', values);
      } else {
        showFieldError(data.field, data.message);
        announce(data.message || 'We couldn’t send this. Please try again.', 'error');
      }
    } catch {
      announce('We couldn’t reach Dodona. Check your connection and try again.', 'error');
    } finally {
      sending = false;
      button.disabled = false;
      form.removeAttribute('aria-busy');
      button.textContent = idleLabel;
    }
  });

  if ('prefill' in form.dataset) prefillFromQuery(form);
  fetchToken();
}

if (typeof document !== 'undefined') {
  for (const form of document.querySelectorAll('form[data-form]')) initForm(form);
}

/** Sign-in page: sign in, create a demo account with any email, one-click fill for the seeded logins, redirect to the console the role belongs to. */
import { api, loadAccount, signOut } from '/platform-shell.js';

const DEMO_PASSWORD = 'demo-dodona-2026';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const $ = id => document.getElementById(id);

// Only the three console paths are followed after sign-in.
const safeHome = home => (['/dashboard', '/provider', '/admin'].includes(home) ? home : '/dashboard');

function setError(formId, errId, message, field) {
  $(errId).textContent = message || '';
  $(formId).querySelectorAll('[aria-invalid]').forEach(el => el.removeAttribute('aria-invalid'));
  if (field) { $(field).setAttribute('aria-invalid', 'true'); $(field).focus(); }
}

async function submit({ form, button, err, body, path, check }) {
  const problem = check();
  if (problem) { setError(form, err, problem[1], problem[0]); return; }
  setError(form, err, '');
  $(button).disabled = true;
  $(button).setAttribute('aria-busy', 'true');
  try {
    const result = await api(path, { method: 'POST', body: body() });
    location.assign(safeHome(result.home || result.account?.home));
  } catch (error) {
    setError(form, err, error.status === 429 ? 'Too many tries from this address. Wait a few minutes and try again.' : error.message);
    $(button).disabled = false;
    $(button).removeAttribute('aria-busy');
  }
}

function wireSignIn() {
  $('si-form').addEventListener('submit', event => {
    event.preventDefault();
    submit({
      form: 'si-form', button: 'si-submit', err: 'si-err', path: '/api/auth/sign-in',
      body: () => ({ email: $('si-email').value.trim(), password: $('si-pass').value }),
      check: () => (!EMAIL.test($('si-email').value.trim()) ? ['si-email', 'Enter an email address.']
        : $('si-pass').value.length < 8 ? ['si-pass', 'Enter the password, at least 8 characters.'] : null),
    });
  });
  document.querySelectorAll('[data-fill]').forEach(button => button.addEventListener('click', () => {
    $('si-email').value = button.dataset.fill;
    $('si-pass').value = DEMO_PASSWORD;
    setError('si-form', 'si-err', '');
    $('si-submit').focus();
  }));
}

function wireSignUp() {
  $('su-form').addEventListener('submit', event => {
    event.preventDefault();
    submit({
      form: 'su-form', button: 'su-submit', err: 'su-err', path: '/api/auth/sign-up',
      body: () => ({ email: $('su-email').value.trim(), company: $('su-company').value.trim(), role: $('su-role').value, password: $('su-pass').value }),
      check: () => {
        if (!EMAIL.test($('su-email').value.trim())) return ['su-email', 'Enter an email address. Any address works; it is never verified.'];
        if (!$('su-company').value.trim()) return ['su-company', 'Enter a company name.'];
        const length = $('su-pass').value.length;
        return length < 8 || length > 128 ? ['su-pass', 'Use a password of 8 to 128 characters.'] : null;
      },
    });
  });
}

async function showSignedIn() {
  let account = null;
  try { account = await loadAccount(); } catch { return; }
  if (account?.off) {
    $('si-forms').hidden = true;
    $('si-lede').textContent = 'The demo platform is off on this server.';
    return;
  }
  if (!account) return;
  $('si-signed').hidden = false;
  $('si-signed-who').textContent = `${account.email} (${account.company})`;
  $('si-signed-go').href = safeHome(account.home);
  $('si-signed-out').addEventListener('click', signOut);
}

document.documentElement.classList.remove('no-js');
wireSignIn();
wireSignUp();
if (location.hash === '#create') $('su-email').focus();
showSignedIn().finally(() => { document.body.dataset.ready = '1'; });

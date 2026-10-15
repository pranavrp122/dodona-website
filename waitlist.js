(() => {
  const form = document.getElementById('waitlist-form');
  const email = document.getElementById('email');
  const emailError = document.getElementById('email-error');
  const button = document.getElementById('submit-button');
  const label = document.getElementById('submit-label');
  const icon = document.getElementById('submit-icon');
  const message = document.getElementById('form-message');
  const retry = document.getElementById('availability-retry');
  const arrow = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 19 19 5M5 5h14v14"/></svg>';
  let token = null;
  let readyAt = 0;
  let sending = false;
  let checking = false;
  let retryTimer;

  function announce(text, state) {
    message.textContent = text;
    message.dataset.state = state;
  }

  function setBusy(busy) {
    sending = busy;
    button.disabled = busy || !token;
    form.setAttribute('aria-busy', String(busy));
    button.setAttribute('aria-busy', String(busy));
    label.textContent = busy ? 'Joining…' : token ? 'Join early access' : 'Signups temporarily unavailable';
    icon.innerHTML = busy ? '' : arrow;
    icon.className = busy ? 'spinner' : '';
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      if (document.hidden) scheduleRetry();
      else checkAvailability(true);
    }, 30000);
  }

  function markUnavailable(text) {
    token = null;
    button.disabled = true;
    label.textContent = 'Signups temporarily unavailable';
    retry.hidden = false;
    announce(text, 'unavailable');
    scheduleRetry();
  }

  async function checkAvailability(quiet = false) {
    if (checking || sending) return false;
    const recovering = !retry.hidden;
    checking = true;
    clearTimeout(retryTimer);
    retry.disabled = true;
    retry.textContent = 'Checking…';
    if (!quiet) announce('Checking signup availability…', 'checking');
    try {
      const response = await fetch('/api/waitlist/status', { signal: AbortSignal.timeout(12000), cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || data.available !== true || typeof data.token !== 'string') throw new Error('unavailable');
      token = data.token;
      readyAt = performance.now() + 1500;
      button.disabled = false;
      retry.hidden = true;
      label.textContent = 'Join early access';
      announce(recovering ? 'Signups are back. Your details are still here.' : 'We’ll email you with launch updates.', 'ready');
      return true;
    } catch {
      markUnavailable('Signups are unavailable. Check again shortly. This check does not submit your details.');
      return false;
    } finally {
      checking = false;
      retry.disabled = false;
      retry.textContent = 'Check again';
    }
  }

  retry.addEventListener('click', () => checkAvailability());
  email.addEventListener('input', () => { email.removeAttribute('aria-invalid'); emailError.hidden = true; });
  document.querySelectorAll('[data-interest]').forEach(link => {
    link.addEventListener('click', () => { document.getElementById('interest').value = link.dataset.interest; });
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (sending || !token) return;
    email.value = email.value.trim();
    if (!email.validity.valid || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value)) {
      email.setAttribute('aria-invalid', 'true');
      emailError.hidden = false;
      email.focus();
      announce('Please check your email address.', 'error');
      return;
    }
    const body = {
      email: email.value,
      interest: document.getElementById('interest').value,
      useCase: document.getElementById('use-case').value,
      website: document.getElementById('website').value,
      token,
    };
    setBusy(true);
    announce('Saving your signup…', 'loading');
    let refreshSession = false;
    try {
      // Let a fresh token reach the server's minimum age without making someone
      // with prefilled details manually retry a legitimate, quick submission.
      await new Promise(resolve => setTimeout(resolve, Math.max(0, readyAt - performance.now())));
      const response = await fetch('/api/waitlist', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(12000),
      });
      const data = await response.json();
      if (response.ok && data.status === 'saved') {
        form.reset();
        email.removeAttribute('aria-invalid');
        emailError.hidden = true;
        announce('You’re on the list. We’ll email when there’s news.', 'success');
      } else if (data.code === 'FORM_EXPIRED') {
        token = null;
        refreshSession = true;
      } else if (response.status === 503) {
        markUnavailable('We couldn’t confirm your signup. Your details are still here. Check again when the service returns; retrying won’t add a duplicate.');
      } else {
        announce(data.message || 'We couldn’t confirm your signup. Please try again.', 'error');
        if (data.field === 'email') { email.setAttribute('aria-invalid', 'true'); emailError.hidden = false; email.focus(); }
      }
    } catch {
      announce('We couldn’t confirm your signup. Please try again; retrying won’t add a duplicate.', 'error');
    } finally {
      setBusy(false);
      if (refreshSession && await checkAvailability()) announce('Your form session has been refreshed. Please try again.', 'error');
    }
  });

  window.addEventListener('online', () => { if (!token) checkAvailability(true); });
  window.addEventListener('focus', () => { if (!token) checkAvailability(true); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !token) checkAvailability(true); });
  window.addEventListener('pageshow', event => { if (event.persisted) checkAvailability(true); });
  checkAvailability();
})();

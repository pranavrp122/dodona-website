import { demoPrices, priceDemoRequest } from './demo-model.js';

(() => {
  const form = document.getElementById('paper-order-form');
  if (!form) return;
  const fields = document.getElementById('paper-fields');
  const review = document.getElementById('paper-review');
  const receiptPanel = document.getElementById('paper-receipt');
  const message = document.getElementById('paper-message');
  const consent = document.getElementById('paper-confirm');
  const input = name => form.elements.namedItem(name);
  const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
  const date = iso => new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(iso)) + ' UTC';
  let state = 'details';
  let quote = null;
  let receipt = null;

  function showMessage(text, error = false) {
    message.textContent = text;
    message.classList.toggle('paper-error', error);
  }
  function step(value) {
    state = value;
    fields.hidden = value !== 'details';
    fields.disabled = value !== 'details';
    review.hidden = value !== 'review';
    receiptPanel.hidden = value !== 'receipt';
    consent.disabled = value !== 'review';
    document.querySelectorAll('[data-paper-step]').forEach(item => {
      if (item.dataset.paperStep === value) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    });
  }
  function updatePrices() {
    let prices;
    try { prices = demoPrices(Number(input('gpuHours').value)); } catch { /* Invalid input has no price yet. */ }
    document.querySelectorAll('[data-paper-price]').forEach(element => { element.textContent = prices ? money(prices[element.dataset.paperPrice]) : '—'; });
  }
  function fillDetails(request) {
    const values = {
      compute: `${request.gpuCount} × ${request.gpuType} · ${request.gpuHours} total GPU-hours`,
      region: request.region,
      starts: date(request.usageStartsAt), ends: date(request.usageEndsAt),
    };
    document.querySelectorAll('[data-paper-detail]').forEach(element => { element.textContent = values[element.dataset.paperDetail]; });
  }
  function reset() {
    form.reset();
    quote = null;
    receipt = null;
    const starts = new Date(Date.now() + 24 * 60 * 60 * 1000);
    starts.setUTCHours(12, 0, 0, 0);
    input('usageStartsAt').value = starts.toISOString().slice(0, 16);
    input('usageEndsAt').value = new Date(starts.getTime() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 16);
    step('details');
    updatePrices();
    showMessage('Try the example or change the details. Nothing is sent or saved.');
  }
  function prepare() {
    fields.querySelectorAll('[aria-invalid]').forEach(element => element.removeAttribute('aria-invalid'));
    const invalid = fields.querySelector(':invalid');
    if (invalid) {
      invalid.setAttribute('aria-invalid', 'true');
      showMessage('Check the highlighted field. GPU count is 1–8, hours are 1–10,000, and all fields are required.', true);
      invalid.focus();
      return;
    }
    const utc = value => value + (value.length === 16 ? ':00Z' : 'Z');
    const request = {
      gpuType: input('gpuType').value, gpuCount: Number(input('gpuCount').value), gpuHours: Number(input('gpuHours').value),
      region: input('region').value.trim(), usageStartsAt: utc(input('usageStartsAt').value), usageEndsAt: utc(input('usageEndsAt').value),
    };
    try {
      const issuedAt = Date.now();
      quote = { request, prices: priceDemoRequest(request, issuedAt), issuedAt, expiresAt: issuedAt + 15 * 60 * 1000 };
      fillDetails(request);
      consent.checked = false;
      step('review');
      showMessage('Review the details and fees. This paper quote is valid for up to 15 minutes.');
      document.getElementById('paper-review-title').focus();
    } catch (error) { showMessage(error.message, true); }
  }
  function place() {
    if (!quote) return;
    if (Date.now() >= quote.expiresAt || Date.parse(quote.request.usageStartsAt) <= Date.now()) {
      quote = null;
      step('details');
      showMessage('The paper quote expired. Review the details again for a fresh quote.', true);
      input('gpuCount').focus();
      return;
    }
    if (!consent.checked) {
      showMessage('Confirm that you understand this is a paper order first.', true);
      consent.focus();
      return;
    }
    // Browser-only state. No API, storage, payment, or inventory call is made.
    receipt = {
      mode: 'demo', source: 'browser_paper_order', status: 'simulated',
      receiptId: 'PAPER-' + (typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')), request: quote.request, prices: quote.prices,
      paymentCharged: false, capacityHeld: false, realReservationCreated: false, persisted: false,
    };
    document.getElementById('paper-receipt-id').textContent = receipt.receiptId;
    step('receipt');
    showMessage('Paper order placed. No payment taken, no compute reserved, and nothing saved.');
    document.getElementById('paper-receipt-title').focus();
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (state === 'details') prepare();
    else if (state === 'review') place();
  });
  fields.addEventListener('input', event => {
    event.target.removeAttribute('aria-invalid');
    quote = null;
    updatePrices();
  });
  document.getElementById('paper-edit').addEventListener('click', () => {
    quote = null;
    step('details');
    showMessage('Change the details, then review a new paper quote.');
    input('gpuCount').focus();
  });
  document.getElementById('paper-again').addEventListener('click', () => { reset(); input('gpuCount').focus(); });
  document.getElementById('paper-download').addEventListener('click', () => {
    if (!receipt) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(receipt, null, 2) + '\n'], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = receipt.receiptId + '.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  reset();
  document.getElementById('paper-review-button').disabled = false;
})();

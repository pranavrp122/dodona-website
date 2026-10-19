/** Contract page: refreshes the value from the API and runs the demo list-for-sale and offer forms. */
import { contractSummary, valueChart, termSheet, demoConfirmation } from '/contracts-view.js';

const byId = id => document.getElementById(id);
const id = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');

document.addEventListener('submit', event => {
  const form = event.target.closest('.c-form');
  if (!form) return;
  event.preventDefault();
  const input = form.elements.cents;
  const message = form.querySelector('.c-confirm');
  const asked = Number(input.value);
  if (!input.value.trim() || !Number.isFinite(asked) || asked < 1 || asked > 200) {
    input.setAttribute('aria-invalid', 'true');
    message.dataset.state = 'error';
    message.textContent = 'Enter a price between 1 and 200 cents on the dollar.';
    return;
  }
  input.removeAttribute('aria-invalid');
  message.dataset.state = 'ok';
  message.textContent = demoConfirmation(form.dataset.kind, asked, Number(form.dataset.remainingCost), Number(form.dataset.valueCents));
});

try {
  const response = await fetch(`/api/contracts/${encodeURIComponent(id)}`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Contract request failed with ${response.status}.`);
  const detail = await response.json();
  byId('c-summary').innerHTML = contractSummary(detail);
  byId('c-chart').innerHTML = valueChart(detail.history);
  byId('c-terms').innerHTML = termSheet(detail);
  const form = document.querySelector('.c-form');
  if (form) {
    form.dataset.remainingCost = detail.contract.valuation.remainingCost.toFixed(2);
    form.dataset.valueCents = (detail.contract.valuation.centsOnDollar ?? 100).toFixed(1);
  }
  document.body.dataset.values = 'refreshed';
} catch {
  document.body.dataset.values = 'server';
}

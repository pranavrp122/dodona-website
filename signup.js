// Starts the demo session after signup and opens the dashboard, even when storage is not connected.
const REDIRECT_DELAY_MS = 900;
const DEMO_FALLBACK_DELAY_MS = 2200;
const form = document.getElementById('signup-form');

function openDashboard(values, delay) {
  const session = {
    email: values.email.trim().toLowerCase(),
    company: values.company.trim(),
    role: values.role,
    kyb: 'pending',
    createdAt: new Date().toISOString(),
  };
  try { sessionStorage.setItem('dodonaDemoSession', JSON.stringify(session)); }
  catch { /* Private browsing can block storage; the dashboard then offers its demo account. */ }
  setTimeout(() => location.assign('/dashboard'), delay);
}

if (form) {
  form.addEventListener('dodona:saved', event => openDashboard(event.detail.values, REDIRECT_DELAY_MS));
  form.addEventListener('dodona:unavailable', event => openDashboard(event.detail.values, DEMO_FALLBACK_DELAY_MS));
}

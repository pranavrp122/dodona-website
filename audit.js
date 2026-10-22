/** Audit trail page: refreshes the log every 30 seconds, filters by kind, and re-hashes the chain in the browser. */
const REFRESH_MS = 30000;
const GENESIS = '0'.repeat(64);
// Same labels as KIND_LABELS in lib/audit.mjs.
const LABELS = { quote: 'Quote', booking_created: 'Booking', exercise_confirmed: 'Exercise', listing_created: 'Listing', offer_sent: 'Offer', signup: 'Signup', rfq: 'RFQ', mark: 'Mark', system: 'System' };
const rows = document.getElementById('a-rows');
const filters = document.getElementById('a-filters');
const updated = document.getElementById('a-updated');
const button = document.getElementById('a-verify');
const result = document.getElementById('a-result');
let kind = new URL(location.href).searchParams.get('kind') || '';

// Same rule as lib/audit.mjs: sorted keys, no whitespace.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

const element = (tag, attributes = {}, text = '') => {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  if (text) node.textContent = text;
  return node;
};

function hashCell(hash, linked) {
  const cell = element('td');
  if (hash === GENESIS) { cell.append(element('code', { class: 'a-hash' }, 'genesis')); return cell; }
  const code = element('code', {}, hash.slice(0, 10));
  const wrapper = linked ? element('a', { class: 'a-hash', href: `#e-${hash}`, title: hash }) : element('span', { class: 'a-hash', title: hash });
  wrapper.append(code);
  cell.append(wrapper);
  return cell;
}

function renderRows(entries) {
  const fragment = document.createDocumentFragment();
  if (!entries.length) {
    const row = element('tr');
    row.append(element('td', { colspan: '6', class: 'a-empty' }, 'No entries yet.'));
    fragment.append(row);
  }
  for (const entry of entries) {
    const row = element('tr', { id: `e-${entry.hash}` });
    const time = element('td');
    time.append(element('time', { datetime: entry.ts }, `${entry.ts.slice(0, 19).replace('T', ' ')} UTC`));
    const kindCell = element('td');
    kindCell.append(element('span', { class: 'a-kind' }, LABELS[entry.kind] || entry.kind));
    row.append(time, kindCell, element('td', { class: 'a-ref' }, entry.ref || '—'), element('td', {}, entry.summary), hashCell(entry.hash, false), hashCell(entry.prevHash, true));
    fragment.append(row);
  }
  rows.replaceChildren(fragment);
}

async function fetchEntries(params) {
  const response = await fetch(`/api/audit?${new URLSearchParams(params)}`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function refresh() {
  try {
    const feed = await fetchEntries(kind ? { limit: 50, kind } : { limit: 50 });
    renderRows(feed.entries);
    updated.textContent = `Newest first · updated ${new Date(feed.asOf).toLocaleTimeString()} · server check: ${feed.chainOk ? 'chain intact' : 'chain broken'}`;
  } catch {
    updated.textContent = 'Could not refresh the log. Showing the last loaded entries.';
  }
}

function selectKind(next) {
  kind = next;
  for (const link of filters.querySelectorAll('a[data-kind]')) {
    const active = link.dataset.kind === kind;
    link.classList.toggle('is-active', active);
    if (active) link.setAttribute('aria-current', 'true'); else link.removeAttribute('aria-current');
  }
  history.replaceState(null, '', kind ? `/audit?kind=${encodeURIComponent(kind)}` : '/audit');
  refresh();
}

async function verifyChain() {
  button.disabled = true;
  result.className = 'a-result';
  result.textContent = 'Re-hashing…';
  try {
    const feed = await fetchEntries({ limit: 1000 });
    const entries = [...feed.entries].reverse();
    let firstBad = null;
    for (let index = 0; index < entries.length && !firstBad; index++) {
      const entry = entries[index];
      const { id, ts, kind: entryKind, ref, summary, data } = entry;
      const hash = await sha256(entry.prevHash + '\n' + canonicalJson({ id, ts, kind: entryKind, ref, summary, data }));
      if (hash !== entry.hash || (index > 0 && entry.prevHash !== entries[index - 1].hash)) firstBad = entry;
    }
    if (firstBad) {
      result.classList.add('is-bad');
      result.textContent = `Chain broken at ${firstBad.ts.slice(0, 19).replace('T', ' ')} UTC · ${firstBad.kind} · ${firstBad.hash.slice(0, 10)}`;
    } else {
      result.classList.add('is-ok');
      result.textContent = `Chain intact · ${entries.length} entries`;
    }
  } catch {
    result.classList.add('is-bad');
    result.textContent = 'Could not verify: the log did not load.';
  } finally {
    button.disabled = false;
  }
}

filters.addEventListener('click', event => {
  const link = event.target.closest('a[data-kind]');
  if (!link) return;
  event.preventDefault();
  selectKind(link.dataset.kind);
});
if (globalThis.crypto?.subtle) {
  button.hidden = false;
  button.addEventListener('click', verifyChain);
} else {
  result.textContent = 'Browser verification needs a secure (HTTPS) connection.';
}
setInterval(refresh, REFRESH_MS);

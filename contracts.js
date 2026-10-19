/** Contract values board: refreshes values from the API and filters the board by region from the map. */
import { pricesLine, kpis, regionMap, regionFilters, boardRows, fleetRows } from '/contracts-view.js';

const REGIONS = ['US East', 'US West', 'Europe'];
const byId = id => document.getElementById(id);
const fromUrl = () => {
  const requested = new URLSearchParams(location.search).get('region');
  return REGIONS.includes(requested) ? requested : null;
};
let region = fromUrl();

function applyRegion() {
  const rows = [...document.querySelectorAll('.c-row')];
  rows.forEach(row => { row.hidden = Boolean(region) && row.dataset.region !== region; });
  document.querySelectorAll('[data-region-filter]').forEach(control => {
    const current = (control.dataset.regionFilter || null) === region;
    control.classList.toggle('is-active', current);
    if (control.classList.contains('c-filter')) {
      if (current) control.setAttribute('aria-current', 'true');
      else control.removeAttribute('aria-current');
    }
  });
  byId('c-map').querySelector('svg')?.classList.toggle('has-active', Boolean(region));
  const shown = rows.filter(row => !row.hidden).length;
  byId('c-count').textContent = region ? `Showing ${shown} of ${rows.length} contracts in ${region}` : `Showing all ${rows.length} contracts`;
}

function render(board) {
  byId('c-prices').innerHTML = pricesLine(board.prices, board.methodVersion);
  byId('c-kpis').innerHTML = kpis(board);
  byId('c-map').innerHTML = regionMap(board, region);
  byId('c-filters').innerHTML = regionFilters(region);
  byId('c-rows').innerHTML = boardRows(board, region);
  byId('c-fleets').innerHTML = fleetRows(board);
}

document.addEventListener('click', event => {
  const control = event.target.closest('[data-region-filter]');
  if (!control) return;
  event.preventDefault();
  const picked = control.dataset.regionFilter || null;
  region = picked === region && control.classList.contains('map-pin') ? null : picked;
  history.replaceState(null, '', region ? `/contracts?region=${encodeURIComponent(region)}` : '/contracts');
  applyRegion();
});

applyRegion();
try {
  const response = await fetch('/api/contracts', { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Board request failed with ${response.status}.`);
  render(await response.json());
  applyRegion();
  document.body.dataset.values = 'refreshed';
} catch {
  document.body.dataset.values = 'server';
  byId('c-count').textContent += '. Showing the values from page load.';
}

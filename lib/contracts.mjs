/** Contract values area: builds board and contract JSON from sample data and the price index, and renders its pages. */
import { readFile } from 'node:fs/promises';
import samples from '../data/sample-contracts.json' with { type: 'json' };
import { valueContract, valuationHistory, fleetMark, METHOD_VERSION } from './valuation.mjs';
import { renderPage } from './site.mjs';
import * as view from '../contracts-view.js';

export const REGIONS = Object.freeze(['US East', 'US West', 'Europe']);
const ID_PATTERN = /^[a-z0-9-]{1,80}$/;
const templateUrl = name => new URL('../' + name, import.meta.url);

export const todayUtc = (now = Date.now) => new Date(now()).toISOString().slice(0, 10);
const priceMeta = ({ asOf, source, live }) => ({ asOf, source, live });

// Cost-weighted cents on the dollar: total (cost + value) over total cost.
function weightedCents(valued) {
  const cost = valued.reduce((sum, c) => sum + c.valuation.remainingCost, 0);
  const worth = valued.reduce((sum, c) => sum + c.valuation.remainingCost + c.valuation.value, 0);
  return cost > 0 ? worth / cost * 100 : null;
}

const withValuation = (contract, prices, today) => ({ ...contract, valuation: valueContract(contract, prices.data[contract.gpu], { today }) });

export function buildBoard(prices, { today }) {
  const contracts = samples.contracts.map(contract => withValuation(contract, prices, today));
  const regions = REGIONS.map(region => {
    const inRegion = contracts.filter(c => c.region === region);
    return {
      region,
      contracts: inRegion.length,
      remainingHours: inRegion.reduce((sum, c) => sum + c.valuation.remainingHours, 0),
      centsOnDollar: weightedCents(inRegion),
    };
  });
  return {
    methodVersion: METHOD_VERSION,
    note: samples.note,
    today,
    prices: priceMeta(prices),
    kpis: {
      contractsTracked: contracts.length,
      remainingHours: contracts.reduce((sum, c) => sum + c.valuation.remainingHours, 0),
      centsOnDollar: weightedCents(contracts),
    },
    regions,
    contracts,
    fleets: samples.fleets.map(fleet => ({ ...fleet, mark: fleetMark(fleet, prices.data[fleet.gpu], { today }) })),
  };
}

export function buildContractDetail(id, prices, { today }) {
  const contract = samples.contracts.find(c => c.id === id);
  if (!contract) return null;
  return {
    methodVersion: METHOD_VERSION,
    today,
    prices: priceMeta(prices),
    contract: withValuation(contract, prices, today),
    history: valuationHistory(contract, prices.data[contract.gpu]),
  };
}

const jsonDocument = (value, status = 200) => ({
  status, type: 'application/json; charset=utf-8', body: JSON.stringify(value), cacheControl: status === 200 ? 'public, max-age=300' : 'no-store',
});
const notFound = () => jsonDocument({ message: 'Not found.' }, 404);

async function htmlDocument(name, replacements, { settings, origin, path }) {
  let html = await readFile(templateUrl(name), 'utf8');
  for (const [marker, content] of Object.entries(replacements)) html = html.replaceAll(`<!-- ${marker} -->`, content);
  return { status: 200, type: 'text/html; charset=utf-8', body: renderPage(html, { settings, origin, path }), cacheControl: 'no-cache' };
}

// Returns a response description for contract routes, or null when the path is not one of them.
export async function contractsDocument(url, { prices, now = Date.now, settings, origin = '' }) {
  const path = url.pathname;
  const detailMatch = path.match(/^\/(api\/)?contracts\/([^/]+)$/);
  if (path !== '/api/contracts' && path !== '/contracts' && !detailMatch) return null;
  if (detailMatch && !ID_PATTERN.test(detailMatch[2])) return notFound();
  const history = await prices();
  const today = todayUtc(now);

  if (path === '/api/contracts') return jsonDocument(buildBoard(history, { today }));
  if (path === '/contracts') {
    const requested = url.searchParams.get('region');
    const region = REGIONS.includes(requested) ? requested : null;
    const board = buildBoard(history, { today });
    return htmlDocument('contracts.html', {
      C_PRICES: view.pricesLine(board.prices, board.methodVersion),
      C_KPIS: view.kpis(board),
      C_MAP: view.regionMap(board, region),
      C_FILTERS: view.regionFilters(region),
      C_ROWS: view.boardRows(board, region),
      C_FLEETS: view.fleetRows(board),
    }, { settings, origin, path: '/contracts' });
  }
  const detail = buildContractDetail(detailMatch[2], history, { today });
  if (!detail) return notFound();
  if (detailMatch[1]) return jsonDocument(detail);
  return htmlDocument('contract.html', {
    C_TITLE: view.escapeHtml(detail.contract.label),
    C_ACTIONS: view.contractActions(detail),
    C_SUMMARY: view.contractSummary(detail),
    C_CHART: view.valueChart(detail.history),
    C_TERMS: view.termSheet(detail),
  }, { settings, origin, path: '/contracts/' + detail.contract.id });
}

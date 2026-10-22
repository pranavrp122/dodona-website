/** Market strip: index tiles with sparklines, the Kalshi-implied monthly table and futures status, from /api/market. */
(() => {
  const REFRESH_MS = 5 * 60 * 1000;
  const SVG = 'http://www.w3.org/2000/svg';
  const W = 120;
  const H = 32;
  const PAD = 3;
  const root = document.getElementById('market-strip');
  if (!root) return;
  const tiles = root.querySelector('[data-mk="tiles"]');
  const implied = root.querySelector('[data-mk="implied"]');
  const futures = root.querySelector('[data-mk="futures"]');
  const asOf = root.querySelector('[data-mk="asof"]');

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };
  const svgEl = (tag, attrs) => {
    const node = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  };
  const money = value => '$' + value.toFixed(2);
  const pct = value => value == null ? 'n/a' : (value > 0 ? '+' : value < 0 ? '−' : '') + Math.abs(value * 100).toFixed(1) + '%';
  const arrow = value => value > 0 ? '▲ ' : value < 0 ? '▼ ' : '';
  const shortDate = iso => new Date(iso.slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const monthLabel = month => new Date(month + '-01T00:00:00Z').toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

  function sparkline(gpu, tile, readout) {
    const values = tile.spark;
    const dates = tile.sparkDates;
    const low = Math.min(...values);
    const high = Math.max(...values);
    const x = i => PAD + i * (W - 2 * PAD) / Math.max(1, values.length - 1);
    const y = v => high === low ? H / 2 : H - PAD - (v - low) / (high - low) * (H - 2 * PAD);
    const svg = svgEl('svg', {
      viewBox: `0 0 ${W} ${H}`, class: 'mk-spark', role: 'img', preserveAspectRatio: 'none',
      'aria-label': `${gpu}, last ${values.length} index days: from ${money(values[0])} to ${money(values.at(-1))}, low ${money(low)}, high ${money(high)}`,
    });
    svg.append(svgEl('path', { class: 'mk-spark-line', d: values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join('') }));
    const hover = svgEl('circle', { class: 'mk-spark-hover', cx: 0, cy: 0, r: 2.6, visibility: 'hidden' });
    svg.append(svgEl('circle', { class: 'mk-spark-last', cx: x(values.length - 1), cy: y(values.at(-1)), r: 2.6 }), hover);
    svg.addEventListener('pointermove', event => {
      const box = svg.getBoundingClientRect();
      const i = Math.max(0, Math.min(values.length - 1, Math.round((event.clientX - box.left) / box.width * (values.length - 1))));
      hover.setAttribute('cx', x(i));
      hover.setAttribute('cy', y(values[i]));
      hover.setAttribute('visibility', 'visible');
      readout.textContent = `${shortDate(dates[i])} · ${money(values[i])}`;
    });
    svg.addEventListener('pointerleave', () => {
      hover.setAttribute('visibility', 'hidden');
      readout.textContent = readout.dataset.rest;
    });
    return svg;
  }

  function renderTiles(index) {
    const entries = Object.entries(index);
    if (!entries.length) return tiles.replaceChildren(el('p', 'mk-fallback', 'Index data is unavailable right now.'));
    tiles.replaceChildren(...entries.map(([gpu, tile]) => {
      const card = el('article', 'mk-tile');
      const head = el('div', 'mk-tile-head');
      head.append(el('h3', 'mk-gpu', gpu), el('span', 'mk-vol', `${Math.round(tile.vol * 100)}% vol`));
      const price = el('p', 'mk-price');
      price.append(money(tile.last), el('small', null, '/GPU-h'));
      const changes = el('p', 'mk-changes');
      changes.append(...[['1D', tile.change1d], ['30D', tile.change30d]].map(([label, value]) => el('span', 'mk-chg', `${label} ${arrow(value)}${pct(value)}`)));
      const readout = el('p', 'mk-readout', `Last ${tile.spark.length} index days to ${shortDate(tile.asOf)}`);
      readout.dataset.rest = readout.textContent;
      card.append(head, price, changes, sparkline(gpu, tile, readout), readout);
      return card;
    }));
  }

  function impliedTable(data, gpus, months) {
    const table = el('table', 'mk-table');
    const thead = el('thead');
    const headRow = el('tr');
    for (const text of ['Month', ...gpus.map(gpu => `${gpu} median`)]) {
      const th = el('th', null, text);
      th.scope = 'col';
      headRow.append(th);
    }
    thead.append(headRow);
    const tbody = el('tbody');
    for (const month of months) {
      const tr = el('tr');
      const th = el('th', null, monthLabel(month));
      th.scope = 'row';
      tr.append(th, ...gpus.map(gpu => {
        const row = data[gpu].find(r => r.month === month);
        const text = !row ? '–' : row.implied != null ? money(row.implied) : (row.note || '–').split(',')[0];
        const td = el('td', row && row.implied == null ? 'mk-bound' : null, text);
        if (row) td.title = `${row.strikesUsed} of ${row.strikesListed} strikes had tight quotes`;
        return td;
      }));
      tbody.append(tr);
    }
    table.append(thead, tbody);
    const wrap = el('div', 'mk-table-wrap');
    wrap.append(table);
    return wrap;
  }

  function renderImplied(data) {
    const gpus = ['B200', 'H100'].filter(gpu => Array.isArray(data[gpu]));
    const months = [...new Set(gpus.flatMap(gpu => data[gpu].map(row => row.month)))].sort();
    const body = data.error ? el('p', 'mk-implied-error', `Market-implied prices are unavailable right now: ${data.error}`)
      : months.length ? impliedTable(data, gpus, months)
        : el('p', 'mk-implied-error', 'No Kalshi ladder has enough tight quotes to read a price today.');
    const note = el('p', 'mk-implied-note', `${data.label}. Median of the monthly average settle, read where the "above $X" prices cross 50%.`);
    implied.replaceChildren(el('h3', 'mk-sub', 'What Kalshi prices imply'), body, note);
    implied.hidden = false;
  }

  function renderFutures(list) {
    const line = el('p', 'mk-futures-line');
    line.append(el('strong', null, 'Compute futures: '));
    list.forEach((item, i) => {
      if (i) line.append(' · ');
      const link = el('a', null, item.venue);
      link.href = item.source;
      link.rel = 'noopener noreferrer';
      line.append(link, ` ${item.status.charAt(0).toLowerCase()}${item.status.slice(1)}`);
    });
    futures.replaceChildren(line);
    futures.hidden = false;
  }

  async function load() {
    try {
      const response = await fetch('/api/market', { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(String(response.status));
      const data = await response.json();
      renderTiles(data.index || {});
      renderImplied(data.implied || { error: 'no data', label: '' });
      renderFutures(data.futures || []);
      asOf.textContent = `Ornn daily index · demonstration only; not licensed for commercial valuation · as of ${shortDate(data.asOf)}${data.live ? '' : ' (saved copy)'}`;
    } catch {
      if (!tiles.querySelector('.mk-tile')) tiles.replaceChildren(el('p', 'mk-fallback', 'Market data could not load. It retries every 5 minutes.'));
    }
  }

  load();
  setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
})();

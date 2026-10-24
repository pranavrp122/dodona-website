/** Market strip: index tiles with sparklines and futures status from /api/market; the Kalshi view only where the section has data-implied="true". */
(() => {
  const REFRESH_MS = 5 * 60 * 1000;
  const TRADE_DATE_RETRY_MS = 15 * 1000;
  const SVG = 'http://www.w3.org/2000/svg';
  const W = 120;
  const H = 32;
  const PAD = 3;
  const root = document.getElementById('market-strip');
  if (!root) return;
  // The Kalshi view is shown only where the page opts in (the signed-in demo dashboard), never on public pages.
  const withImplied = root.dataset.implied === 'true';

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
  const marker = (node, name) => { node.dataset.mk = name; return node; };

  // Uses the server-rendered strip when present; otherwise builds it, so a page can include an empty section.
  function ensureStructure() {
    if (!root.querySelector('[data-mk="tiles"]')) {
      const titles = el('div');
      const title = el('h2', 'mk-title', 'GPU rental prices');
      title.id = 'mk-title';
      titles.append(el('p', 'eyebrow', 'Market today'), title);
      const head = el('div', 'mk-head');
      head.append(titles, marker(el('p', 'mk-asof', 'Ornn daily index · demonstration only; not licensed for commercial valuation'), 'asof'));
      const futuresBox = marker(el('div', 'mk-futures'), 'futures');
      futuresBox.hidden = true;
      const lower = el('div', 'mk-lower');
      lower.append(futuresBox);
      const wrap = el('div', 'wrap');
      wrap.append(head, marker(el('div', 'mk-tiles'), 'tiles'), lower);
      root.classList.add('mk-sec');
      root.setAttribute('aria-labelledby', 'mk-title');
      root.replaceChildren(wrap);
    }
    if (withImplied && !root.querySelector('[data-mk="implied"]')) {
      const box = marker(el('div', 'mk-implied'), 'implied');
      box.hidden = true;
      root.querySelector('.mk-lower').prepend(box);
    }
    return {
      tiles: root.querySelector('[data-mk="tiles"]'),
      implied: withImplied ? root.querySelector('[data-mk="implied"]') : null,
      futures: root.querySelector('[data-mk="futures"]'),
      asOf: root.querySelector('[data-mk="asof"]'),
    };
  }

  function sparkline(gpu, tile, readout) {
    const values = tile.spark;
    const dates = tile.sparkDates;
    const low = Math.min(...values);
    const high = Math.max(...values);
    const x = i => PAD + i * (W - 2 * PAD) / Math.max(1, values.length - 1);
    const y = v => high === low ? H / 2 : H - PAD - (v - low) / (high - low) * (H - 2 * PAD);
    const svg = svgEl('svg', {
      viewBox: `0 0 ${W} ${H}`, class: 'mk-spark', role: 'img', preserveAspectRatio: 'none',
      'aria-label': `${gpu} over the last ${values.length} index days went from ${money(values[0])} to ${money(values.at(-1))}, with a low of ${money(low)} and a high of ${money(high)}`,
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

  function renderTiles(container, index) {
    const entries = Object.entries(index);
    if (!entries.length) return container.replaceChildren(el('p', 'mk-fallback', 'Index data is unavailable right now.'));
    container.replaceChildren(...entries.map(([gpu, tile]) => {
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

  function bracketText(row) {
    if (row.bracketLow != null && row.bracketHigh != null) return `${money(row.bracketLow)} to ${money(row.bracketHigh)}`;
    if (row.bracketLow != null) return `at least ${money(row.bracketLow)}`;
    if (row.bracketHigh != null) return `at most ${money(row.bracketHigh)}`;
    return 'no quotes';
  }

  function lastTradeText(row, pending) {
    if (row.lastTradeMedian == null) return '–';
    const when = row.lastTradeAt ? `traded ${shortDate(row.lastTradeAt)}` : pending ? 'date loading' : 'date unknown';
    return `${money(row.lastTradeMedian)} · ${when}`;
  }

  function impliedTable(gpu, rows, pending) {
    const table = el('table', 'mk-table');
    table.append(el('caption', 'mk-caption', gpu));
    const headRow = el('tr');
    for (const text of ['Month', 'Bid/ask bracket', 'Median, tight quotes', 'Last-trade median']) {
      const th = el('th', null, text);
      th.scope = 'col';
      headRow.append(th);
    }
    const thead = el('thead');
    thead.append(headRow);
    const tbody = el('tbody');
    for (const row of rows) {
      const th = el('th', null, monthLabel(row.month));
      th.scope = 'row';
      const median = el('td', row.implied == null ? 'mk-bound' : null, row.implied == null ? 'not computable' : money(row.implied));
      median.title = `${row.strikesTight} of ${row.strikesListed} strikes had a bid-ask spread of 20 cents or less`;
      const tr = el('tr');
      tr.append(th, el('td', null, bracketText(row)), median, el('td', 'mk-bound', lastTradeText(row, pending)));
      tbody.append(tr);
    }
    table.append(thead, tbody);
    const wrap = el('div', 'mk-table-wrap');
    wrap.append(table);
    return wrap;
  }

  function renderImplied(box, data) {
    const pending = data.tradeDates === 'pending';
    const gpus = ['B200', 'H100'].filter(gpu => Array.isArray(data[gpu]) && data[gpu].length);
    const body = data.error ? [el('p', 'mk-implied-error', `Market-implied prices are unavailable right now. ${data.error}`)]
      : gpus.length ? gpus.map(gpu => impliedTable(gpu, data[gpu], pending))
        : [el('p', 'mk-implied-error', 'No Kalshi ladder says anything about the median today.')];
    const label = el('p', 'mk-implied-note', data.label);
    const note = el('p', 'mk-implied-note', `${data.note} The bracket comes from bids and asks at 50 cents; the medians read where "above $X" prices cross 50%; where no median can be computed, the bracket is the read. Not used in any value or quote.`);
    box.replaceChildren(el('h3', 'mk-sub', 'What Kalshi prices imply for the monthly average'), ...body, label, note);
    box.hidden = false;
  }

  function renderFutures(container, list) {
    const line = el('p', 'mk-futures-line');
    line.append(el('strong', null, 'Compute futures: '));
    list.forEach((item, i) => {
      if (i) line.append(' · ');
      const link = el('a', null, item.venue);
      link.href = item.source;
      link.rel = 'noopener noreferrer';
      line.append(link, ` ${item.status.charAt(0).toLowerCase()}${item.status.slice(1)}`);
    });
    container.replaceChildren(line);
    container.hidden = false;
  }

  let parts = null;
  let retryTimer = null;

  async function load() {
    parts = parts || ensureStructure();
    try {
      const response = await fetch(withImplied ? '/api/market?implied=1' : '/api/market', { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(String(response.status));
      const data = await response.json();
      renderTiles(parts.tiles, data.index || {});
      if (parts.implied && data.implied) {
        renderImplied(parts.implied, data.implied);
        clearTimeout(retryTimer);
        // Trade dates fill in on the server shortly after the first request; ask once more for them.
        if (data.implied.tradeDates === 'pending') retryTimer = setTimeout(load, TRADE_DATE_RETRY_MS);
      }
      renderFutures(parts.futures, data.futures || []);
      parts.asOf.textContent = `Ornn daily index · demonstration only; not licensed for commercial valuation · as of ${shortDate(data.asOf)}${data.live ? '' : ' (saved copy)'}`;
    } catch {
      if (!parts.tiles.querySelector('.mk-tile')) parts.tiles.replaceChildren(el('p', 'mk-fallback', 'Market data could not load. It retries every 5 minutes.'));
    }
  }

  load();
  setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
})();

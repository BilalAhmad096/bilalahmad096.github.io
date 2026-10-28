// js/market-explorer.js
//
// The Market Explorer on /tools/: pick a market, type a ticker or a company
// name, and see what the exchange lists for it. The ranking lives in
// lib/market-search.js; this file only wires it to the page.
//
// Each market's list is fetched the first time its tab opens. The address
// keeps the market and the chosen company (?market=us&symbol=KO), so a result
// can be shared.

import { buildIndex, companyLinks, search } from './lib/market-search.js';

const MARKETS = {
  india: { label: 'India', exchange: 'NSE', file: '/data/markets/india.json', example: 'RELIANCE or Infosys' },
  us: { label: 'United States', exchange: 'NYSE', file: '/data/markets/us.json', example: 'KO or Coca-Cola' }
};

const root = document.getElementById('market-explorer');
if (root) start(root);

function start(root) {
  const tabs = [...root.querySelectorAll('[role="tab"]')];
  const input = root.querySelector('#market-query');
  const status = root.querySelector('#market-status');
  const results = root.querySelector('#market-results');
  const detail = root.querySelector('#market-detail');

  const loaded = new Map();
  let market = 'india';
  let shown = [];

  function load(key) {
    if (!loaded.has(key)) {
      const promise = fetch(MARKETS[key].file, { cache: 'no-cache' })
        .then(r => {
          if (!r.ok) throw new Error(String(r.status));
          return r.json();
        })
        .then(data => ({ data, index: buildIndex(data.companies || []) }));
      // A failed load is forgotten, so opening the tab again retries it.
      promise.catch(() => loaded.delete(key));
      loaded.set(key, promise);
    }
    return loaded.get(key);
  }

  function setAddress(symbol) {
    const params = new URLSearchParams();
    if (market !== 'india') params.set('market', market);
    if (symbol) params.set('symbol', symbol);
    const qs = params.toString();
    history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}`);
  }

  async function selectMarket(key, { focus = false, symbol = null } = {}) {
    market = key;
    tabs.forEach(tab => {
      const on = tab.dataset.market === key;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
    });
    input.placeholder = `Ticker or company name, e.g. ${MARKETS[key].example}`;
    results.replaceChildren();
    detail.hidden = true;
    status.textContent = `Loading ${MARKETS[key].exchange} listings…`;
    if (focus) input.focus();

    try {
      const { data, index } = await load(key);
      if (market !== key) return;
      const when = data.updated
        ? new Date(`${data.updated}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
        : null;
      status.textContent = `${index.length.toLocaleString('en-GB')} ${data.exchange || MARKETS[key].exchange} companies`
        + (when ? ` · updated ${when}` : '');
      if (symbol) {
        const match = index.find(e => e.company.s === symbol.toUpperCase());
        if (match) { input.value = match.company.s; showDetail(match.company, data); return; }
      }
      render();
    } catch {
      if (market === key) status.textContent = `The ${MARKETS[key].exchange} listings could not be loaded. Please try again shortly.`;
    }
  }

  async function render() {
    const entry = await loaded.get(market)?.catch(() => null);
    if (!entry) return;
    const q = input.value;
    shown = search(entry.index, q, 20);
    results.replaceChildren(...shown.map(company => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'market-result';
      const sym = document.createElement('span');
      sym.className = 'market-result__symbol';
      sym.textContent = company.s;
      const name = document.createElement('span');
      name.className = 'market-result__name';
      name.textContent = company.n;
      button.append(sym, name);
      button.addEventListener('click', () => showDetail(company, entry.data));
      li.append(button);
      return li;
    }));
    if (q.trim() && !shown.length) {
      const li = document.createElement('li');
      li.className = 'market-empty';
      li.textContent = `No ${MARKETS[market].exchange} company matches “${q.trim()}”.`;
      results.append(li);
    }
  }

  function row(dl, term, value) {
    if (value === undefined || value === null || value === '') return;
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.append(dt, dd);
  }

  function showDetail(company, data) {
    results.replaceChildren();
    detail.replaceChildren();

    const head = document.createElement('div');
    head.className = 'market-detail__head';
    const title = document.createElement('h3');
    title.className = 'market-detail__name';
    title.textContent = company.n;
    const badge = document.createElement('span');
    badge.className = 'market-detail__symbol';
    badge.textContent = `${data.exchange || MARKETS[market].exchange}: ${company.s}`;
    head.append(title, badge);

    const dl = document.createElement('dl');
    dl.className = 'market-detail__facts';
    row(dl, 'Exchange', market === 'india' ? 'National Stock Exchange of India' : 'New York Stock Exchange');
    row(dl, 'Ticker', company.s);
    row(dl, 'Industry', company.ind);
    row(dl, 'Security', company.sec);
    row(dl, 'ISIN', company.isin);
    row(dl, 'Series', company.series);
    if (company.listed) {
      row(dl, 'Listed on', new Date(`${company.listed}T00:00:00Z`)
        .toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }));
    }
    if (company.face) row(dl, 'Face value', `₹${company.face}`);
    if (company.cik) row(dl, 'SEC CIK', String(company.cik));

    const links = document.createElement('ul');
    links.className = 'market-detail__links';
    for (const { label, href } of companyLinks(market, company)) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = label;
      li.append(a);
      links.append(li);
    }

    const note = document.createElement('p');
    note.className = 'market-detail__note';
    note.textContent = 'Shariah (halal) screening for this company is coming soon.';

    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'market-detail__back';
    back.textContent = 'New search';
    back.addEventListener('click', () => {
      input.value = '';
      detail.hidden = true;
      setAddress(null);
      input.focus();
    });

    detail.append(head, dl, links, note, back);
    detail.hidden = false;
    setAddress(company.s);
  }

  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => {
      if (tab.dataset.market === market) return;
      input.value = '';
      setAddress(null);
      selectMarket(tab.dataset.market, { focus: true });
    });
    tab.addEventListener('keydown', event => {
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      const next = tabs[(i + step + tabs.length) % tabs.length];
      next.focus();
      next.click();
    });
  });

  input.addEventListener('input', () => {
    if (!detail.hidden) setAddress(null);
    detail.hidden = true;
    render();
  });
  root.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault();
    const entry = await loaded.get(market)?.catch(() => null);
    if (entry && shown[0]) showDetail(shown[0], entry.data);
  });

  const params = new URLSearchParams(location.search);
  const wanted = MARKETS[params.get('market')] ? params.get('market') : 'india';
  selectMarket(wanted, { symbol: params.get('symbol') });
}

// js/market-explorer.js
//
// The Market Explorer on /tools/: pick a market, type a ticker or a company
// name, and see what the exchange lists for it. The ranking lives in
// lib/market-search.js; this file only wires it to the page.
//
// Each market's list is fetched the first time its tab opens. The address
// keeps the market and the chosen company (?market=us&symbol=KO), so a result
// can be shared. A US company's figures from its SEC filings are fetched the
// first time a US company is opened.

import { financialSections, formatDay } from './lib/financials.js';
import { buildIndex, companyLinks, search } from './lib/market-search.js';

const US_FINANCIALS = '/data/markets/us-financials.json';

const MARKETS = {
  india: { label: 'India', exchange: 'NSE', file: '/data/markets/india.json', example: 'RELIANCE or Infosys' },
  us: { label: 'United States', exchange: 'NYSE and Nasdaq', file: '/data/markets/us.json', example: 'AAPL or Coca-Cola' }
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
  let financials = null;

  function loadFinancials() {
    if (!financials) {
      financials = fetch(US_FINANCIALS, { cache: 'no-cache' })
        .then(r => {
          if (!r.ok) throw new Error(String(r.status));
          return r.json();
        });
      financials.catch(() => { financials = null; });
    }
    return financials;
  }

  // The figures fill in below the facts once they arrive. A card the visitor
  // has already left is not touched.
  async function showFinancials(company, mount) {
    mount.replaceChildren(heading('Financials'), message('Loading figures from SEC filings…'));
    let data;
    try {
      data = await loadFinancials();
    } catch {
      if (mount.isConnected) mount.replaceChildren(heading('Financials'), message('The financial figures could not be loaded. Please try again shortly.'));
      return;
    }
    if (!mount.isConnected) return;
    const sections = financialSections(company.cik, data.companies?.[company.cik]);
    if (!sections.length) {
      mount.replaceChildren(heading('Financials'),
        message('No figures in US dollars were found in this company\u2019s recent SEC filings. Companies that report in another currency are not covered yet.'));
      return;
    }
    const parts = [heading('Financials')];
    // Each statement folds away; the first and the ratios start open, so the
    // card leads with what most visitors look for.
    for (const [i, section] of sections.entries()) {
      const box = document.createElement('details');
      box.className = 'market-fin__section';
      box.open = i === 0 || section.title === 'Ratios and growth';
      const h = document.createElement('summary');
      h.className = 'market-fin__title';
      h.textContent = section.title;
      const period = document.createElement('p');
      period.className = 'market-fin__period';
      period.textContent = section.period;
      if (section.filing) {
        const a = document.createElement('a');
        a.href = section.filing;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = 'filing';
        period.append(' · ', a);
      }
      const dl = document.createElement('dl');
      dl.className = 'market-fin__rows';
      for (const [term, value] of section.rows) row(dl, term, value);
      box.append(h, period, dl);
      parts.push(box);
    }
    parts.push(message(`From the company\u2019s SEC filings, in US dollars. Updated weekly; last checked ${formatDay(data.updated)}.`, 'market-fin__source'));
    mount.replaceChildren(...parts);
  }

  function heading(text) {
    const h = document.createElement('h4');
    h.className = 'market-fin__heading';
    h.textContent = text;
    return h;
  }

  function message(text, className = 'market-fin__message') {
    const p = document.createElement('p');
    p.className = className;
    p.textContent = text;
    return p;
  }

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
      status.textContent = `${index.length.toLocaleString('en-GB')} ${MARKETS[key].exchange} companies`
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
      // Two exchanges share the US tab, so each result says which it is on.
      if (company.x) {
        const exch = document.createElement('span');
        exch.className = 'market-result__exchange';
        exch.textContent = company.x;
        button.append(exch);
      }
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
    badge.textContent = `${company.x || (market === 'india' ? 'NSE' : 'NYSE')}: ${company.s}`;
    head.append(title, badge);

    const dl = document.createElement('dl');
    dl.className = 'market-detail__facts';
    row(dl, 'Exchange', market === 'india' ? 'National Stock Exchange of India'
      : company.x === 'Nasdaq' ? `Nasdaq${company.tier ? ` (${company.tier})` : ''}` : 'New York Stock Exchange');
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

    const parts = [head, dl, links];
    if (market === 'us' && company.cik) {
      const fin = document.createElement('div');
      fin.className = 'market-fin';
      parts.push(fin);
      showFinancials(company, fin);
    }
    detail.append(...parts, note, back);
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

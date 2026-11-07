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

import { financialSections, formatDay, formatPercent } from './lib/financials.js';
import { buildIndex, companyLinks, search } from './lib/market-search.js';
import { apiBaseFor, formatChange, formatPrice, formatQuoteTime, valuation, valuationRows } from './lib/quote.js';
import { CODE_STATUS, METHOD, STATUS_TEXT, screenCompany } from './lib/shariah-screen.js';

const US_FINANCIALS = '/data/markets/us-financials.json';
// A price shown on an open card is asked for again this often.
const QUOTE_REFRESH_MS = 60_000;

const MARKETS = {
  india: { label: 'India', exchange: 'NSE', file: '/data/markets/india.json', example: 'RELIANCE or Infosys' },
  us: {
    label: 'United States', exchange: 'NYSE and Nasdaq', file: '/data/markets/us.json', example: 'AAPL or Coca-Cola',
    // Each company's industry and Shariah status, for the result chips.
    screening: '/data/markets/us-screening.json'
  }
};

const root = document.getElementById('market-explorer');
if (root) start(root);

function start(root) {
  const tabs = [...root.querySelectorAll('[role="tab"]')];
  const input = root.querySelector('#market-query');
  const status = root.querySelector('#market-status');
  const results = root.querySelector('#market-results');
  const detail = root.querySelector('#market-detail');

  const apiBase = apiBaseFor(location.hostname, root.dataset.apiBase);
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
  async function showFinancials(company, mount, screen) {
    mount.replaceChildren(heading('Financials'), message('Loading figures from SEC filings…'));
    let data;
    try {
      data = await loadFinancials();
    } catch {
      if (mount.isConnected) mount.replaceChildren(heading('Financials'), message('The financial figures could not be loaded. Please try again shortly.'));
      if (screen.panel.isConnected) screen.panel.replaceChildren(message('The Shariah screen could not be run because the figures did not load.'));
      return;
    }
    if (!mount.isConnected) return;
    screen.entry = data.companies?.[company.cik];
    screen.ready = true;
    screen.rescreen();
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

  // The latest price, then market cap and P/E against the SEC figures. It is
  // asked for again each minute while the card stays open and the tab is
  // visible, and stops once the visitor moves on.
  async function showQuote(company, mount, screen) {
    const shareClasses = screen.shareClasses;
    const draw = (quote, entry) => {
      // The price also settles Usmani's condition that a share cost more than
      // the liquid amount it represents, so the screen is run again with it.
      screen.price = quote.price;
      screen.rescreen();
      const price = document.createElement('p');
      price.className = 'market-quote__price';
      price.textContent = formatPrice(quote.price);
      const change = formatChange(quote.change, quote.changePercent);
      if (change) {
        const span = document.createElement('span');
        span.className = `market-quote__change market-quote__change--${quote.change > 0 ? 'up' : quote.change < 0 ? 'down' : 'flat'}`;
        span.textContent = change;
        price.append(' ', span);
      }
      const when = message(`${formatQuoteTime(quote.time) || 'Latest'} · price from ${quote.source}`, 'market-quote__time');
      const parts = [price, when];
      const rows = valuationRows(valuation(quote.price, entry, { shareClasses }));
      if (rows.length) {
        const dl = document.createElement('dl');
        dl.className = 'market-quote__rows';
        for (const [term, value] of rows) row(dl, term, value);
        parts.push(dl);
      }
      mount.replaceChildren(...parts);
    };

    const fetchQuote = () => fetch(`${apiBase}/v1/quote?symbol=${encodeURIComponent(company.s)}`)
      .then(r => r.json().then(body => ({ ok: r.ok, body })));

    let shown = false;
    const tick = async () => {
      try {
        const [{ ok, body }, figures] = await Promise.all([fetchQuote(), loadFinancials().catch(() => null)]);
        if (!mount.isConnected) return;
        if (ok && body.quote) {
          draw(body.quote, figures?.companies?.[company.cik]);
          shown = true;
        } else if (!shown) {
          // The Worker's own wording for the cases it knows; anything else
          // (an older Worker without prices, say) gets a plain line.
          const known = ['quote_not_found', 'quotes_busy', 'quotes_not_configured'].includes(body?.code);
          mount.replaceChildren(message(known ? body.message : 'Live prices are not available right now.', 'market-quote__time'));
        }
      } catch {
        if (mount.isConnected && !shown) mount.replaceChildren(message('The price could not be loaded.', 'market-quote__time'));
      }
    };

    mount.replaceChildren(message('Loading the latest price…', 'market-quote__time'));
    await tick();
    const timer = setInterval(() => {
      if (!mount.isConnected) { clearInterval(timer); return; }
      if (document.visibilityState === 'visible') tick();
    }, QUOTE_REFRESH_MS);
  }

  // The verdict, then the working: each check with its figure and limit.
  function showShariah(panel, result) {
    const text = STATUS_TEXT[result.status];
    panel.className = `market-shariah market-shariah--${result.status}`;
    const label = message(text.label, 'market-shariah__label');
    let summary;
    if (result.business.verdict === 'fail') summary = `Main business: ${result.business.reason.toLowerCase()}, which is not permissible.`;
    else if (result.status === 'noncompliant') summary = 'Fails the financial screen marked below.';
    else if (result.status === 'review') summary = `${result.business.reason}. The ratios pass, but the business needs a closer look.`;
    else if (result.status === 'notScreenable') summary = 'This company files no balance sheet with the SEC, so the financial tests cannot be run at all. '
      + 'Most of these are funds, trusts and foreign filers rather than companies with gaps in their figures.';
    else if (result.status === 'insufficient') summary = 'Some figures this screen needs were not found in the company\u2019s filings.';
    else summary = 'Passes the business screen and every test below.';

    const list = document.createElement('ul');
    list.className = 'market-shariah__checks';
    const item = (pass, labelText, value) => {
      const li = document.createElement('li');
      li.className = `market-shariah__check market-shariah__check--${pass === true ? 'pass' : pass === false ? 'fail' : 'unknown'}`;
      const mark = document.createElement('span');
      mark.className = 'market-shariah__mark';
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = pass === true ? '✓' : pass === false ? '✗' : '?';
      const sr = document.createElement('span');
      sr.className = 'visually-hidden';
      sr.textContent = pass === true ? 'Passes: ' : pass === false ? 'Fails: ' : 'Unknown: ';
      const body = document.createElement('span');
      body.textContent = `${labelText}: ${value}`;
      li.append(mark, sr, body);
      return li;
    };
    const b = result.business;
    list.append(item(
      b.verdict === 'pass' ? true : b.verdict === 'fail' ? false : null,
      'Business activity',
      b.verdict === 'pass' ? 'permissible industry' : b.reason
    ));
    for (const c of result.checks) {
      const li = item(c.pass, c.label, checkValue(c));
      if (c.note) {
        const note = document.createElement('span');
        note.className = 'market-shariah__note';
        note.textContent = c.note;
        li.append(note);
      }
      list.append(li);
    }

    const parts = [label, message(summary, 'market-shariah__text'), list];
    if (result.purification !== null && result.status !== 'noncompliant') {
      parts.push(message(`Purification: about ${formatPercent(result.purification)} of dividends, the share of revenue earned as interest, would be given to charity.`, 'market-shariah__text'));
    }
    // Usmani's second condition is a duty on the shareholder, not a test of
    // the company, so it belongs with the verdict rather than in the list.
    if (result.status === 'compliant' || result.status === 'review') {
      parts.push(message('His conditions also ask the shareholder to object to any interest dealing rather than consent to it, '
        + 'preferably by raising it at the annual general meeting.', 'market-shariah__text'));
    }
    parts.push(message(`${METHOD.name}${result.asOf ? `, from the balance sheet of ${formatDay(result.asOf)}` : ''}. `
      + 'Thresholds are the ones his Shariah board applies at Meezan Bank; his own conditions fix no percentage. '
      + 'The industry code shows only a company\u2019s main business, and standards differ between scholars. '
      + 'This is general information, not a fatwa or investment advice.', 'market-shariah__caveat'));
    panel.replaceChildren(...parts);
  }

  // What a check reads as on the card: a share of assets against its limit, a
  // floor it has to reach, or the price set against the liquid assets a share
  // represents.
  function checkValue(c) {
    if (c.kind === 'price') {
      return c.perShare <= 0
        ? `${formatPrice(c.price)} a share, with no net liquid assets to exceed`
        : `${formatPrice(c.price)} a share against ${formatPrice(c.perShare)} of net liquid assets`;
    }
    if (c.ratio === null) return 'not available';
    return `${formatPercent(c.ratio)} (${c.kind === 'min' ? 'minimum' : 'limit'} ${formatPercent(c.limit)})`;
  }

  // The SEC writes industries in capitals: "SERVICES-PREPACKAGED SOFTWARE".
  function titleCase(text) {
    const small = new Set(['and', 'or', 'of', 'the', 'for', 'in', 'to', 'nec']);
    return text.toLowerCase().replace(/[a-z][a-z.']*/g, (w, i) => {
      if (w === 'nec') return 'NEC';
      return i > 0 && small.has(w) ? w : w[0].toUpperCase() + w.slice(1);
    });
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
        .then(async data => {
          // Without the screening file the tab still works, just unlabelled.
          const extra = MARKETS[key].screening;
          data.screening = extra
            ? await fetch(extra, { cache: 'no-cache' }).then(r => (r.ok ? r.json() : {})).then(j => j.companies || {}).catch(() => ({}))
            : {};
          return { data, index: buildIndex(data.companies || []) };
        });
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
      const code = company.cik && entry.data.screening?.[company.cik]?.s;
      const chip = code && STATUS_TEXT[CODE_STATUS[code]]?.chip;
      if (chip) {
        const tag = document.createElement('span');
        tag.className = `market-chip market-chip--${CODE_STATUS[code]}`;
        tag.textContent = chip;
        tag.title = STATUS_TEXT[CODE_STATUS[code]].label;
        button.append(tag);
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
    const usIndustry = market === 'us' && company.cik ? data.screening?.[company.cik] : null;
    if (usIndustry?.d) row(dl, 'Industry', `${titleCase(usIndustry.d)} (SIC ${usIndustry.sic})`);
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

    // India's screening is still to come; a US company is screened from its
    // SEC figures once they load.
    const note = document.createElement('div');
    if (market === 'us') {
      note.className = 'market-shariah';
      note.append(message(company.cik ? 'Running the Shariah screen…' : 'This company has no SEC record, so it cannot be screened.', 'market-shariah__text'));
    } else {
      note.className = 'market-detail__note';
      note.textContent = 'Shariah (halal) screening for this company is coming soon.';
    }

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

    // One screen per card, shared by the figures and the price: the filings
    // settle most of it, and the price adds Usmani's last condition when it
    // arrives. Either can land first, so each stores what it has and asks for
    // the screen to be drawn again.
    const screen = {
      entry: null,
      ready: false,
      price: null,
      sic: data.screening?.[company.cik]?.sic,
      shareClasses: company.cik ? data.companies.filter(c => c.cik === company.cik).length || 1 : 1,
      panel: note,
      rescreen() {
        if (!this.ready || !this.panel.isConnected) return;
        showShariah(this.panel, screenCompany(this.entry, this.sic, { price: this.price, shareClasses: this.shareClasses }));
      }
    };

    const quote = document.createElement('div');
    quote.className = 'market-quote';
    if (market === 'us') showQuote(company, quote, screen);
    const parts = market === 'us' ? [head, quote, note, dl, links] : [head, dl, links];
    if (market === 'us' && company.cik) {
      const fin = document.createElement('div');
      fin.className = 'market-fin';
      parts.push(fin);
      showFinancials(company, fin, screen);
    }
    detail.append(...parts, ...(market === 'us' ? [] : [note]), back);
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

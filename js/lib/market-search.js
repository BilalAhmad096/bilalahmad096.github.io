// js/lib/market-search.js
//
// The search behind the Market Explorer on /tools/. No DOM and no fetch: it
// ranks the companies in data/markets/*.json against what a visitor typed, so
// it runs identically in the page and under node --test.
//
// A ticker is matched as typed; a name is matched word by word, ignoring case,
// punctuation and the legal suffixes ("Ltd", "Inc.") that every name carries.

const LEGAL_WORDS = new Set([
  'limited', 'ltd', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company',
  'plc', 'llc', 'lp', 'sa', 'nv', 'ag', 'the', 'and', 'of', 'india', 'pvt', 'private'
]);

export function normalise(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function symbolKey(text) {
  return String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Built once per market, so a keystroke only compares strings.
export function buildIndex(companies) {
  return companies.map(company => {
    const name = normalise(company.n);
    return {
      company,
      symbol: symbolKey(company.s),
      name,
      words: name.split(' ').filter(Boolean),
      isin: String(company.isin || '').toUpperCase()
    };
  });
}

// Lower is better; Infinity is no match.
function rank(entry, query, qSymbol, qWords) {
  if (qSymbol && entry.symbol === qSymbol) return 0;
  if (entry.isin && entry.isin === query.toUpperCase().trim()) return 0;
  if (query.length >= 2 && entry.name === normalise(query)) return 1;
  if (qSymbol && entry.symbol.startsWith(qSymbol)) return 2 + (entry.symbol.length - qSymbol.length) / 100;

  if (qWords.length) {
    // Every typed word must start some word of the name.
    const all = qWords.every(q => entry.words.some(w => w.startsWith(q)));
    if (all) {
      const first = entry.words[0]?.startsWith(qWords[0]) ? 0 : 1;
      return 3 + first + entry.words.length / 100;
    }
    const joined = qWords.join(' ');
    if (joined.length >= 3 && entry.name.includes(joined)) return 5;
  }
  if (qSymbol.length >= 2 && entry.symbol.includes(qSymbol)) return 6;
  return Infinity;
}

export function search(index, query, limit = 20) {
  const q = String(query || '').trim();
  if (!q) return [];
  const qSymbol = symbolKey(q);
  const all = normalise(q).split(' ').filter(Boolean);
  // Legal words are dropped unless they are all the visitor typed.
  const meaningful = all.filter(w => !LEGAL_WORDS.has(w));
  const qWords = meaningful.length ? meaningful : all;

  const hits = [];
  for (const entry of index) {
    const r = rank(entry, q, qSymbol, qWords);
    if (r !== Infinity) hits.push({ r, entry });
  }
  hits.sort((a, b) => a.r - b.r || a.entry.symbol.localeCompare(b.entry.symbol));
  return hits.slice(0, limit).map(h => h.entry.company);
}

// Where a visitor can read more about a company: quotes, charts, filings.
export function companyLinks(market, company) {
  const s = encodeURIComponent(company.s);
  if (market === 'india') {
    return [
      { label: 'NSE quote', href: `https://www.nseindia.com/get-quotes/equity?symbol=${s}` },
      { label: 'Google Finance', href: `https://www.google.com/finance/quote/${s}:NSE` },
      { label: 'TradingView chart', href: `https://www.tradingview.com/symbols/NSE-${s}/` },
      { label: 'Screener financials', href: `https://www.screener.in/company/${s}/` }
    ];
  }
  // Yahoo writes a share class with "-" (BRK-B); the others take "." (BRK.B).
  const yahoo = encodeURIComponent(company.s.replace('.', '-'));
  // Rows built before Nasdaq was added carry no exchange; they were all NYSE.
  const nasdaq = company.x === 'Nasdaq';
  const links = [
    nasdaq
      ? { label: 'Nasdaq quote', href: `https://www.nasdaq.com/market-activity/stocks/${encodeURIComponent(company.s.toLowerCase())}` }
      : { label: 'NYSE quote', href: `https://www.nyse.com/quote/XNYS:${s}` },
    { label: 'Google Finance', href: `https://www.google.com/finance/quote/${s}:${nasdaq ? 'NASDAQ' : 'NYSE'}` },
    { label: 'TradingView chart', href: `https://www.tradingview.com/symbols/${nasdaq ? 'NASDAQ' : 'NYSE'}-${s}/` },
    { label: 'Yahoo Finance', href: `https://finance.yahoo.com/quote/${yahoo}/` }
  ];
  if (company.cik) {
    links.push({
      label: 'SEC filings',
      href: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${String(company.cik).padStart(10, '0')}`
    });
  }
  return links;
}

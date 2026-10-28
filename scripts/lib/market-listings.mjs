// The pure half of the market listings build: turning each exchange's public
// file into the rows the Market Explorer searches. No fetch and no filesystem,
// so every rule can be tested against a sample of the real formats.
//
// India comes from NSE's equity list (EQUITY_L.csv), with industry joined in
// from the Nifty Total Market constituents where a company is in that index.
// The United States comes from Nasdaq Trader's directory of securities listed
// on exchanges other than Nasdaq (otherlisted.txt), kept to NYSE, with the
// SEC's CIK joined in so a company can link to its filings.

// A CSV line splitter that honours quoted fields, which NSE uses for company
// names carrying commas.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field); field = "";
      if (row.some(v => v.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(v => v.trim() !== "")) rows.push(row);
  return rows;
}

// Rows as objects keyed by trimmed, upper-cased headers: NSE pads its headers
// with spaces (" SERIES", " ISIN NUMBER").
function records(text, separator = ",") {
  const rows = separator === ","
    ? parseCsv(text)
    : text.split(/\r?\n/).filter(line => line.trim()).map(line => line.split(separator));
  const [header, ...body] = rows;
  if (!header) return [];
  const keys = header.map(h => h.trim().toUpperCase());
  return body.map(cells => Object.fromEntries(keys.map((k, i) => [k, (cells[i] ?? "").trim()])));
}

const MONTHS = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };

// "08-OCT-2008" -> "2008-10-08"; anything else -> null.
export function nseDate(value) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(value.trim());
  if (!m || !MONTHS[m[2].toUpperCase()]) return null;
  return `${m[3]}-${MONTHS[m[2].toUpperCase()]}-${m[1].padStart(2, "0")}`;
}

// Nifty Total Market constituents -> Map(symbol -> industry).
export function parseNseIndustries(csv) {
  const map = new Map();
  for (const r of records(csv)) {
    if (r.SYMBOL && r.INDUSTRY) map.set(r.SYMBOL.toUpperCase(), r.INDUSTRY);
  }
  return map;
}

// Any Nifty index constituents file -> the symbols and ISINs it lists. Both
// are kept so a company that renames its symbol between the index's review and
// NSE's equity list is still matched by its ISIN.
export function parseIndexMembers(csv) {
  const symbols = new Set();
  const isins = new Set();
  for (const r of records(csv)) {
    if (r.SYMBOL) symbols.add(r.SYMBOL.toUpperCase());
    if (r["ISIN CODE"]) isins.add(r["ISIN CODE"].toUpperCase());
  }
  return { symbols, isins };
}

function inIndex(members, symbol, isin) {
  return members.symbols.has(symbol) || (!!isin && members.isins.has(isin.toUpperCase()));
}

// The Shariah screen this site reports: NSE's Nifty 500 Shariah index, whose
// constituents are the Nifty 500 companies that pass screening by TASIS.
export const SHARIAH_SOURCE = {
  index: "Nifty 500 Shariah",
  universe: "Nifty 500",
  screenedBy: "Taqwaa Advisory and Shariah Investment Solutions (TASIS)"
};

// A pair of lists that cannot be what NSE publishes is refused, so a broken
// download never marks the market non-compliant. The Shariah index is a
// subset of the Nifty 500, a few hundred companies.
export function checkShariahLists(universe, compliant) {
  const n = compliant.symbols.size;
  if (universe.symbols.size < 400) throw new Error(`Nifty 500 list has only ${universe.symbols.size} companies`);
  if (n < 50 || n >= universe.symbols.size) throw new Error(`Nifty 500 Shariah list has ${n} companies`);
  const outside = [...compliant.symbols].filter(sym => !universe.symbols.has(sym)).length;
  if (outside > n * 0.1) throw new Error(`${outside} of ${n} Shariah companies are not in the Nifty 500 list`);
}

// "c": in the Shariah index. "x": in the Nifty 500 it screens but left out of
// it. No status: outside the Nifty 500, so not screened.
export function shariahStatus(lists, symbol, isin) {
  if (!lists) return null;
  if (inIndex(lists.compliant, symbol, isin)) return "c";
  if (inIndex(lists.universe, symbol, isin)) return "x";
  return null;
}

// EQUITY_L.csv -> rows for India. Every series NSE lists in the file is a
// company's equity (EQ, BE, BZ, SM, ST ...), so none is dropped.
export function parseNseEquities(csv, industries = new Map(), shariah = null) {
  const out = [];
  for (const r of records(csv)) {
    const symbol = (r.SYMBOL || "").toUpperCase();
    const name = r["NAME OF COMPANY"];
    if (!symbol || !name) continue;
    const row = { s: symbol, n: name };
    if (r["ISIN NUMBER"]) row.isin = r["ISIN NUMBER"];
    if (r.SERIES) row.series = r.SERIES;
    const listed = nseDate(r["DATE OF LISTING"] || "");
    if (listed) row.listed = listed;
    const face = Number(r["FACE VALUE"]);
    if (Number.isFinite(face) && face > 0) row.face = face;
    const industry = industries.get(symbol);
    if (industry) row.ind = industry;
    const sh = shariahStatus(shariah, symbol, row.isin);
    if (sh) row.sh = sh;
    out.push(row);
  }
  return sortRows(out);
}

// Security names in the Nasdaq Trader file describe the instrument. These mark
// one that is not a company's shares. A partnership's common, partnership or
// depositary units are its shares, and an ADR's "Depositary Shares each
// representing ... ordinary shares" is too; a depositary share of a preferred
// is caught by "Preferred".
const NOT_SHARES = /\b(warrants?|rights?|(?<!(?:common|partnership|depositary) )units?|preferred|preference|notes? due|debentures?|subordinated)\b/i;

// What follows the company in a security name, longest first.
const SHARE_SUFFIX = /,?\s+(?:(?:New|Sponsored|Sponosred|Unsponsored|Series [A-Z0-9]+|Class [A-Z0-9]+)\s+)*(?:Common Stock|Common Shares|Ordinary Shares|American Depositary Shares|American Depository Shares|ADS|Shares of Beneficial Interest|Common Units|Limited Partnership Units|Depositary Units|ADR|Shares)\b.*$/i;

// "Agilent Technologies, Inc. Common Stock" -> "Agilent Technologies, Inc."
export function companyName(security) {
  const name = security.replace(SHARE_SUFFIX, "").trim();
  return name || security.trim();
}

// Nasdaq Trader's "ACT Symbol" uses "." for a share class (BRK.B); its "$" and
// "=" mark preferreds and units.
export function isShareSymbol(symbol) {
  return /^[A-Z][A-Z0-9]*(\.[A-Z])?$/.test(symbol);
}

// otherlisted.txt -> rows for NYSE ("N"). ETFs, test issues and anything that
// is not a company's shares are left out.
export function parseNyseListings(text, ciks = new Map()) {
  const out = [];
  for (const r of records(text, "|")) {
    const symbol = (r["ACT SYMBOL"] || "").toUpperCase();
    const security = r["SECURITY NAME"] || "";
    if (r.EXCHANGE !== "N" || r.ETF === "Y" || r["TEST ISSUE"] === "Y") continue;
    if (!isShareSymbol(symbol) || NOT_SHARES.test(security)) continue;
    const row = { s: symbol, n: companyName(security), sec: security };
    const cik = ciks.get(symbol);
    if (cik) row.cik = cik;
    out.push(row);
  }
  return sortRows(out);
}

// SEC company_tickers_exchange.json -> Map(symbol -> CIK). The SEC writes a
// share class with "-" (BRK-B) where Nasdaq Trader writes "." (BRK.B).
export function parseSecCiks(json) {
  const data = typeof json === "string" ? JSON.parse(json) : json;
  const fields = data.fields || [];
  const iCik = fields.indexOf("cik");
  const iTicker = fields.indexOf("ticker");
  const map = new Map();
  for (const row of data.data || []) {
    const ticker = String(row[iTicker] || "").toUpperCase().replace("-", ".");
    if (ticker && row[iCik] && !map.has(ticker)) map.set(ticker, Number(row[iCik]));
  }
  return map;
}

function sortRows(rows) {
  const seen = new Set();
  return rows
    .filter(r => (seen.has(r.s) ? false : seen.add(r.s)))
    .sort((a, b) => a.s.localeCompare(b.s));
}

// When an enriching source could not be read this week, each company keeps
// what the last good file said for those fields rather than losing them.
export function carryOver(rows, storedRows, fields) {
  const before = new Map((storedRows || []).map(r => [r.s, r]));
  return rows.map(row => {
    const old = before.get(row.s);
    if (!old) return row;
    const next = { ...row };
    for (const f of fields) if (next[f] === undefined && old[f] !== undefined) next[f] = old[f];
    return next;
  });
}

// The file one market is written to. Rows are sorted and the date is a day,
// so a week with no new listings rewrites nothing. Extra fields (the Shariah
// source) are written between the header and the companies.
export function serialiseMarket({ market, exchange, source, updated, companies, ...extra }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(updated)) throw new Error(`bad updated date: ${updated}`);
  return JSON.stringify({ market, exchange, source, updated, ...extra, count: companies.length, companies }) + "\n";
}

// True when two serialised files say the same thing, whatever their date.
export function sameCompanies(a, b) {
  try {
    const strip = ({ updated, ...rest }) => JSON.stringify(rest);
    return strip(JSON.parse(a)) === strip(JSON.parse(b));
  } catch {
    return false;
  }
}

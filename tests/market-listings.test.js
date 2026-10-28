// tests/market-listings.test.js
//
// The Market Explorer on /tools/: the parsers that turn each exchange's public
// file into rows, and the search that ranks those rows. The samples below copy
// the real files' formats, quirks included: NSE's space-padded headers and
// quoted names, and Nasdaq Trader's pipes, preferreds and trailer line.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  SHARIAH_SOURCE,
  carryOver,
  checkShariahLists,
  companyName,
  nseDate,
  parseCsv,
  parseNseEquities,
  parseNseIndustries,
  parseIndexMembers,
  parseNyseListings,
  parseSecCiks,
  sameCompanies,
  serialiseMarket
} from '../scripts/lib/market-listings.mjs';
import { buildIndex, companyLinks, normalise, search, shariahVerdict } from '../js/lib/market-search.js';

const EQUITY_L = [
  'SYMBOL,NAME OF COMPANY, SERIES, DATE OF LISTING, PAID UP VALUE, MARKET LOT, ISIN NUMBER, FACE VALUE',
  'RELIANCE,Reliance Industries Limited,EQ,29-NOV-1995,10,1,INE002A01018,10',
  'TCS,Tata Consultancy Services Limited,EQ,25-AUG-2004,1,1,INE467B01029,1',
  'M&M,Mahindra & Mahindra Limited,EQ,08-NOV-1995,5,1,INE101A01026,5',
  '"SBIN","State Bank of India","EQ","01-MAR-1995","1","1","INE062A01020","1"',
  'ACME,"Acme, Widgets Limited",BE,03-JAN-2020,10,1,INE000Z01011,10',
  'INFY,Infosys Limited,EQ,08-FEB-1995,5,1,INE009A01021,5',
  ''
].join('\r\n');

const NIFTY_TOTAL = [
  'Company Name,Industry,Symbol,Series,ISIN Code',
  'Reliance Industries Ltd.,Oil Gas & Consumable Fuels,RELIANCE,EQ,INE002A01018',
  'Infosys Ltd.,Information Technology,INFY,EQ,INE009A01021'
].join('\n');

const OTHERLISTED = [
  'ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol',
  'A|Agilent Technologies, Inc. Common Stock|N|A|N|100|N|A',
  'BRK.B|Berkshire Hathaway Inc. Class B Common Stock|N|BRK.B|N|100|N|BRK.B',
  'BABA|Alibaba Group Holding Limited American Depositary Shares each representing eight Ordinary share|N|BABA|N|100|N|BABA',
  'ET|Energy Transfer LP Common Units representing limited partner interests|N|ET|N|100|N|ET',
  'KO|Coca-Cola Company (The) Common Stock|N|KO|N|100|N|KO',
  'BAC$K|Bank of America Corporation Depositary Shares, each representing 1/1,000th Series GG Preferred|N|BACpK|N|100|N|BAC-K',
  'XYZ.WS|Example Corp Warrants|N|XYZ.WS|N|100|N|XYZ=',
  'SPY|SPDR S&P 500 ETF Trust|P|SPY|Y|100|N|SPY',
  'GLD|SPDR Gold Trust|N|GLD|Y|100|N|GLD',
  'ZXZZT|NYSE Test Issue Common Stock|N|ZXZZT|N|100|Y|ZXZZT',
  'BEP|Brookfield Renewable Partners L.P. Limited Partnership Units|N|BEP|N|100|N|BEP',
  'IBM|International Business Machines Corporation Common Stock|N|IBM|N|100|N|IBM',
  'File Creation Time: 1027202619:01||||||'
].join('\r\n');

const SEC_TICKERS = {
  fields: ['cik', 'name', 'ticker', 'exchange'],
  data: [
    [1090872, 'AGILENT TECHNOLOGIES, INC.', 'A', 'NYSE'],
    [1067983, 'BERKSHIRE HATHAWAY INC', 'BRK-B', 'NYSE'],
    [21344, 'COCA COLA CO', 'KO', 'NYSE']
  ]
};

test('CSV parsing honours quotes, escaped quotes and CRLF', () => {
  assert.deepEqual(parseCsv('a,"b, c","d ""e"""\r\n1,2,3\r\n'), [['a', 'b, c', 'd "e"'], ['1', '2', '3']]);
});

test('NSE dates read as ISO days', () => {
  assert.equal(nseDate('29-NOV-1995'), '1995-11-29');
  assert.equal(nseDate('8-Oct-2008'), '2008-10-08');
  assert.equal(nseDate(''), null);
  assert.equal(nseDate('2008-10-08'), null);
});

test('NSE equities: every row kept, sorted, with industries joined', () => {
  const rows = parseNseEquities(EQUITY_L, parseNseIndustries(NIFTY_TOTAL));
  assert.deepEqual(rows.map(r => r.s), ['ACME', 'INFY', 'M&M', 'RELIANCE', 'SBIN', 'TCS']);
  const reliance = rows.find(r => r.s === 'RELIANCE');
  assert.deepEqual(reliance, {
    s: 'RELIANCE', n: 'Reliance Industries Limited', isin: 'INE002A01018', series: 'EQ',
    listed: '1995-11-29', face: 10, ind: 'Oil Gas & Consumable Fuels'
  });
  assert.equal(rows.find(r => r.s === 'ACME').n, 'Acme, Widgets Limited');
  assert.equal(rows.find(r => r.s === 'SBIN').n, 'State Bank of India');
  assert.equal(rows.find(r => r.s === 'TCS').ind, undefined);
});

test('NYSE listings keep companies’ shares and drop ETFs, preferreds, warrants, tests and other exchanges', () => {
  const rows = parseNyseListings(OTHERLISTED, parseSecCiks(SEC_TICKERS));
  assert.deepEqual(rows.map(r => r.s), ['A', 'BABA', 'BEP', 'BRK.B', 'ET', 'IBM', 'KO']);
  assert.equal(rows.find(r => r.s === 'BRK.B').cik, 1067983);
  assert.equal(rows.find(r => r.s === 'KO').cik, 21344);
  assert.equal(rows.find(r => r.s === 'IBM').cik, undefined);
});

test('company names drop the share description', () => {
  assert.equal(companyName('Agilent Technologies, Inc. Common Stock'), 'Agilent Technologies, Inc.');
  assert.equal(companyName('Berkshire Hathaway Inc. Class B Common Stock'), 'Berkshire Hathaway Inc.');
  assert.equal(companyName('Alibaba Group Holding Limited American Depositary Shares each representing eight Ordinary share'),
    'Alibaba Group Holding Limited');
  assert.equal(companyName('Energy Transfer LP Common Units representing limited partner interests'), 'Energy Transfer LP');
  assert.equal(companyName('Common Stock'), 'Common Stock');
  assert.equal(companyName('Brookfield Renewable Partners L.P. Limited Partnership Units'), 'Brookfield Renewable Partners L.P.');
  assert.equal(companyName('Braskem SA ADR'), 'Braskem SA');
  assert.equal(companyName('Banco Santander, S.A. Sponsored ADR (Spain)'), 'Banco Santander, S.A.');
});

// Nifty 500 and Nifty 500 Shariah in the constituents format. TCS appears in
// the Shariah list under its ISIN with an older symbol, as after a rename.
const indexCsv = rows => ['Company Name,Industry,Symbol,Series,ISIN Code', ...rows].join('\n');
const NIFTY500 = indexCsv([
  'Reliance Industries Ltd.,Oil Gas & Consumable Fuels,RELIANCE,EQ,INE002A01018',
  'Infosys Ltd.,Information Technology,INFY,EQ,INE009A01021',
  'Tata Consultancy Services Ltd.,Information Technology,TCS,EQ,INE467B01029',
  'State Bank of India,Financial Services,SBIN,EQ,INE062A01020'
]);
const NIFTY500_SHARIAH = indexCsv([
  'Infosys Ltd.,Information Technology,INFY,EQ,INE009A01021',
  'Tata Consultancy Services Ltd.,Information Technology,TCSOLD,EQ,INE467B01029'
]);
const lists = { universe: parseIndexMembers(NIFTY500), compliant: parseIndexMembers(NIFTY500_SHARIAH) };

test('Shariah status: in the index, screened out, or outside the Nifty 500', () => {
  const rows = parseNseEquities(EQUITY_L, new Map(), lists);
  const sh = Object.fromEntries(rows.map(r => [r.s, r.sh ?? null]));
  assert.deepEqual(sh, { ACME: null, INFY: 'c', 'M&M': null, RELIANCE: 'x', SBIN: 'x', TCS: 'c' });
  assert.ok(parseNseEquities(EQUITY_L).every(r => r.sh === undefined));
});

test('Shariah lists that cannot be NSE\u2019s are refused', () => {
  const many = n => ({ symbols: new Set(Array.from({ length: n }, (_, i) => `S${i}`)), isins: new Set() });
  assert.doesNotThrow(() => checkShariahLists(many(500), many(200)));
  assert.throws(() => checkShariahLists(many(500), many(0)), /Shariah list/);
  assert.throws(() => checkShariahLists(many(500), many(500)), /Shariah list/);
  assert.throws(() => checkShariahLists(many(20), many(10)), /Nifty 500 list/);
  const strangers = { symbols: new Set(Array.from({ length: 100 }, (_, i) => `X${i}`)), isins: new Set() };
  assert.throws(() => checkShariahLists(many(500), strangers), /not in the Nifty 500/);
});

test('a failed join keeps last week\u2019s values', () => {
  const stored = [{ s: 'INFY', n: 'Infosys', sh: 'c', ind: 'IT' }, { s: 'GONE', n: 'Delisted', sh: 'x' }];
  const rows = carryOver([{ s: 'INFY', n: 'Infosys' }, { s: 'NEW', n: 'New Co' }], stored, ['sh']);
  assert.deepEqual(rows, [{ s: 'INFY', n: 'Infosys', sh: 'c' }, { s: 'NEW', n: 'New Co' }]);
});

test('the page words each Shariah status, and holds back where none exists', () => {
  const data = { shariah: SHARIAH_SOURCE };
  assert.equal(shariahVerdict({ sh: 'c' }, data).kind, 'compliant');
  assert.match(shariahVerdict({ sh: 'c' }, data).text, /Nifty 500 Shariah.*TASIS/);
  assert.equal(shariahVerdict({ sh: 'x' }, data).label, 'Not Shariah compliant');
  assert.equal(shariahVerdict({}, data).kind, 'unscreened');
  assert.equal(shariahVerdict({ sh: 'c' }, {}).kind, 'pending');
});

test('a file only counts as changed when its companies change', () => {
  const companies = [{ s: 'A', n: 'Agilent' }];
  const a = serialiseMarket({ market: 'us', exchange: 'NYSE', source: 'x', updated: '2026-10-01', companies });
  const b = serialiseMarket({ market: 'us', exchange: 'NYSE', source: 'x', updated: '2026-10-08', companies });
  const c = serialiseMarket({ market: 'us', exchange: 'NYSE', source: 'x', updated: '2026-10-08', companies: [] });
  assert.ok(sameCompanies(a, b));
  assert.ok(!sameCompanies(a, c));
  const d = serialiseMarket({ market: 'us', exchange: 'NYSE', source: 'x', updated: '2026-10-08', shariah: SHARIAH_SOURCE, companies });
  assert.ok(!sameCompanies(a, d));
  assert.deepEqual(JSON.parse(d).shariah, SHARIAH_SOURCE);
  assert.equal(JSON.parse(a).count, 1);
  assert.throws(() => serialiseMarket({ market: 'us', exchange: 'NYSE', source: 'x', updated: 'today', companies }));
});

const india = buildIndex(parseNseEquities(EQUITY_L, parseNseIndustries(NIFTY_TOTAL)));
const us = buildIndex(parseNyseListings(OTHERLISTED, parseSecCiks(SEC_TICKERS)));
const symbols = (index, q) => search(index, q).map(c => c.s);

test('search: an exact ticker comes first, in any case', () => {
  assert.equal(symbols(india, 'tcs')[0], 'TCS');
  assert.equal(symbols(us, 'a')[0], 'A');
  assert.equal(symbols(us, 'brk.b')[0], 'BRK.B');
  assert.equal(symbols(us, 'BRKB')[0], 'BRK.B');
  assert.equal(symbols(india, 'm&m')[0], 'M&M');
});

test('search: names match word by word, ignoring legal suffixes', () => {
  assert.deepEqual(symbols(india, 'tata consultancy'), ['TCS']);
  assert.deepEqual(symbols(india, 'infosys ltd'), ['INFY']);
  assert.equal(symbols(india, 'state bank')[0], 'SBIN');
  assert.equal(symbols(india, 'mahindra')[0], 'M&M');
  assert.equal(symbols(us, 'coca cola')[0], 'KO');
  assert.equal(symbols(us, 'Coca-Cola')[0], 'KO');
  assert.equal(symbols(us, 'berkshire')[0], 'BRK.B');
});

test('search: ISIN finds the company; nothing matches nonsense or an empty box', () => {
  assert.deepEqual(symbols(india, 'INE467B01029'), ['TCS']);
  assert.deepEqual(symbols(india, 'qqqqzz'), []);
  assert.deepEqual(symbols(india, '   '), []);
});

test('normalise folds case, accents and punctuation', () => {
  assert.equal(normalise('Nestlé  India Ltd.'), 'nestle india ltd');
  assert.equal(normalise('M&M'), 'm and m');
});

test('links point at the right exchange and escape the symbol', () => {
  const nse = companyLinks('india', { s: 'M&M' });
  assert.ok(nse.every(l => l.href.startsWith('https://')));
  assert.ok(nse.some(l => l.href === 'https://www.nseindia.com/get-quotes/equity?symbol=M%26M'));
  const nyse = companyLinks('us', { s: 'BRK.B', cik: 1067983 });
  assert.ok(nyse.some(l => l.href === 'https://finance.yahoo.com/quote/BRK-B/'));
  assert.ok(nyse.some(l => l.href.endsWith('CIK=0001067983')));
  assert.ok(!companyLinks('us', { s: 'IBM' }).some(l => l.label === 'SEC filings'));
});

test('the tools page carries the explorer, and the updates page links to it', () => {
  const tools = readFileSync(new URL('../tools/index.html', import.meta.url), 'utf8');
  assert.match(tools, /<body class="page-tools">/);
  assert.match(tools, /id="market-explorer"/);
  assert.match(tools, /data-market="india"/);
  assert.match(tools, /data-market="us"/);
  assert.match(tools, /<link rel="canonical" href="https:\/\/mintorian\.com\/tools\/" \/>/);
  const updates = readFileSync(new URL('../updates/index.html', import.meta.url), 'utf8');
  assert.match(updates, /<a href="\/tools\/">/);
});

// The data files are written by the Market listings workflow; once present
// they must hold what the page expects.
for (const market of ['india', 'us']) {
  const file = new URL(`../data/markets/${market}.json`, import.meta.url);
  test(`data/markets/${market}.json, if built, is well formed`, { skip: !existsSync(file) && 'not built yet' }, () => {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(data.market, market);
    assert.match(data.updated, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(data.count, data.companies.length);
    assert.ok(data.count > 1000, `only ${data.count} companies`);
    for (const c of data.companies) assert.ok(c.s && c.n, JSON.stringify(c));
  });
}

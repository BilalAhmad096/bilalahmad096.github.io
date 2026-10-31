// tests/us-financials.test.js
//
// US company figures from SEC filings: which periods are asked for, how each
// company's latest balance sheet and annual results are picked out of the
// frames, how debt is added up, and how the card words them.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  annualPeriods,
  assembleFinancials,
  frameKey,
  frameUrl,
  framesToFetch,
  instantPeriods,
  readFrame,
  sameFinancials,
  serialiseFinancials
} from '../scripts/lib/us-financials.mjs';
import {
  filingUrl, financialRatios, financialSections, formatCount, formatPercent, formatPerShare, formatUsd, freeCashFlow,
  growth, shortTermDebt, totalDebt
} from '../js/lib/financials.js';

test('quarters are asked for only once they have ended, newest first', () => {
  assert.deepEqual(instantPeriods('2026-10-31', 3), ['CY2026Q3I', 'CY2026Q2I', 'CY2026Q1I']);
  assert.deepEqual(instantPeriods('2026-09-30', 2), ['CY2026Q2I', 'CY2026Q1I']);
  assert.deepEqual(instantPeriods('2026-01-15', 2), ['CY2025Q4I', 'CY2025Q3I']);
  assert.deepEqual(annualPeriods('2026-10-31'), ['CY2025', 'CY2024', 'CY2023']);
});

test('frame URLs follow the SEC’s layout, and every field is asked for in every period', () => {
  assert.equal(frameUrl(['us-gaap', 'Assets'], 'USD', 'CY2026Q2I'),
    'https://data.sec.gov/api/xbrl/frames/us-gaap/Assets/USD/CY2026Q2I.json');
  const list = framesToFetch('2026-10-31');
  assert.ok(list.some(f => f.tag[1] === 'Assets' && f.period === 'CY2026Q3I'));
  assert.ok(list.some(f => f.tag[1] === 'NetIncomeLoss' && f.period === 'CY2024'));
  assert.ok(list.some(f => f.tag[0] === 'dei' && f.unit === 'shares'));
  assert.ok(list.some(f => f.tag[1] === 'EarningsPerShareDiluted' && f.unit === 'USD-per-shares' && f.period === 'CY2025'));
  assert.ok(list.some(f => f.tag[1] === 'NetCashProvidedByUsedInOperatingActivities' && f.unit === 'USD'));
  assert.equal(new Set(list.map(f => frameKey(f.tag, f.unit, f.period))).size, list.length);
});

test('frames are kept to listed companies and to numbers', () => {
  const frame = readFrame({ data: [
    { cik: 320193, val: 5, end: '2026-06-27', accn: 'a' },
    { cik: 999, val: 7, end: '2026-06-30', accn: 'b' },
    { cik: 789019, val: 'x', end: '2026-06-30', accn: 'c' }
  ] }, new Set([320193, 789019]));
  assert.deepEqual([...frame.keys()], [320193]);
  assert.deepEqual(readFrame(null, new Set([1])), new Map());
});

// A tiny set of frames for two companies across two quarters and one year.
const APPLE = 320193;
const SMALL = 1111;
function frames(entries) {
  const map = new Map();
  for (const [tax, tag, unit, period, cik, val, end, extra = {}] of entries) {
    const key = frameKey([tax, tag], unit, period);
    if (!map.has(key)) map.set(key, new Map());
    map.get(key).set(cik, { val, end, accn: `acc-${period}`, ...extra });
  }
  return map;
}
const FRAMES = frames([
  // Apple: Q3 has assets, so Q3 is its balance sheet; its Q2 debt is ignored.
  ['us-gaap', 'Assets', 'USD', 'CY2026Q3I', APPLE, 350e9, '2026-09-26'],
  ['us-gaap', 'Liabilities', 'USD', 'CY2026Q3I', APPLE, 280e9, '2026-09-26'],
  ['us-gaap', 'CashAndCashEquivalentsAtCarryingValue', 'USD', 'CY2026Q3I', APPLE, 30e9, '2026-09-26'],
  ['us-gaap', 'LongTermDebt', 'USD', 'CY2026Q2I', APPLE, 99e9, '2026-06-27'],
  ['us-gaap', 'Assets', 'USD', 'CY2026Q2I', APPLE, 340e9, '2026-06-27'],
  ['dei', 'EntityCommonStockSharesOutstanding', 'shares', 'CY2026Q3I', APPLE, 14.8e9, '2026-10-17'],
  ['us-gaap', 'NetIncomeLoss', 'USD', 'CY2025', APPLE, 100.4e9, '2025-09-27', { start: '2024-09-29' }],
  ['us-gaap', 'Revenues', 'USD', 'CY2025', APPLE, 400.2e9, '2025-09-27', { start: '2024-09-29' }],
  ['us-gaap', 'EarningsPerShareDiluted', 'USD-per-shares', 'CY2025', APPLE, 6.0812345, '2025-09-27', { start: '2024-09-29' }],
  ['us-gaap', 'NetIncomeLoss', 'USD', 'CY2024', APPLE, 93.7e9, '2024-09-28', { start: '2023-10-01' }],
  ['us-gaap', 'Revenues', 'USD', 'CY2024', APPLE, 391e9, '2024-09-28', { start: '2023-10-01' }],
  ['us-gaap', 'EarningsPerShareDiluted', 'USD-per-shares', 'CY2024', APPLE, 6.08, '2024-09-28', { start: '2023-10-01' }],
  // A small company that has not filed Q3 yet, and reports revenue under the
  // second-choice tag.
  ['us-gaap', 'Assets', 'USD', 'CY2026Q2I', SMALL, 12.3e6, '2026-06-30'],
  ['us-gaap', 'LongTermDebtNoncurrent', 'USD', 'CY2026Q2I', SMALL, 4e6, '2026-06-30'],
  ['us-gaap', 'DebtCurrent', 'USD', 'CY2026Q2I', SMALL, 1e6, '2026-06-30'],
  ['us-gaap', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'USD', 'CY2024', SMALL, 8e6, '2024-12-31', { start: '2024-01-01' }]
]);

test('each statement comes from one period: the newest its anchor appears in', () => {
  const out = assembleFinancials(new Set([APPLE, SMALL, 42]), FRAMES, '2026-10-31');
  assert.deepEqual(Object.keys(out).map(Number), [SMALL, APPLE]);
  assert.deepEqual(out[APPLE].bs, {
    end: '2026-09-26', accn: 'acc-CY2026Q3I', v: { assets: 350e9, liabilities: 280e9, cash: 30e9 }
  });
  assert.equal(out[APPLE].fy.start, '2024-09-29');
  assert.deepEqual(out[APPLE].fy.v, { revenue: 400.2e9, netIncome: 100.4e9, epsDiluted: 6.0812 });
  assert.deepEqual(out[APPLE].fy.prev, { end: '2024-09-28', v: { revenue: 391e9, netIncome: 93.7e9, epsDiluted: 6.08 } });
  assert.deepEqual(out[APPLE].shares, { end: '2026-10-17', val: 14.8e9 });
  assert.equal(out[SMALL].bs.end, '2026-06-30');
  assert.deepEqual(out[SMALL].fy.v, { revenue: 8e6 });
  assert.equal(out[SMALL].fy.prev, undefined);
  assert.equal(out[42], undefined);
});

test('total debt adds the reported pieces without counting any twice', () => {
  assert.equal(totalDebt({ longTermDebt: 100, longTermDebtCurrent: 10, shortTermBorrowings: 5, commercialPaper: 2 }), 107);
  assert.equal(totalDebt({ longTermDebtNoncurrent: 90, debtCurrent: 20, shortTermBorrowings: 5 }), 110);
  assert.equal(totalDebt({ longTermDebtNoncurrent: 90, longTermDebtCurrent: 10, shortTermBorrowings: 5 }), 105);
  assert.equal(totalDebt({ borrowings: 50 }), 50);
  // Short-term pieces alone are not a total: they may be a small part of it.
  assert.equal(totalDebt({ debtCurrent: 7 }), null);
  assert.equal(totalDebt({ shortTermBorrowings: 72e9 }), null);
  assert.equal(shortTermDebt({ shortTermBorrowings: 3, commercialPaper: 1 }), 4);
  assert.equal(shortTermDebt({ debtCurrent: 7, shortTermBorrowings: 3 }), 7);
  assert.equal(shortTermDebt({ assets: 1 }), null);
  assert.equal(totalDebt({ assets: 10 }), null);
  assert.equal(totalDebt({ longTermDebt: 0 }), 0);
});

test('ratios and growth are only given when both sides are known', () => {
  const entry = {
    fy: { v: { revenue: 200, costOfRevenue: 120, operatingIncome: 40, netIncome: 30, operatingCashFlow: 50, capitalExpenditure: 20 },
      prev: { v: { revenue: 160, netIncome: -5 } } },
    bs: { v: { assets: 1000, equity: 150, longTermDebt: 250, currentAssets: 300, currentLiabilities: 200 } }
  };
  const r = financialRatios(entry);
  assert.equal(r.grossMargin, 0.4);
  assert.equal(r.operatingMargin, 0.2);
  assert.equal(r.netMargin, 0.15);
  assert.equal(r.returnOnEquity, 0.2);
  assert.equal(r.debtToAssets, 0.25);
  assert.equal(r.currentRatio, 1.5);
  assert.equal(r.revenueGrowth, 0.25);
  assert.equal(r.netIncomeGrowth, null); // from a loss
  assert.equal(r.epsGrowth, null);
  assert.equal(financialRatios({ bs: { v: { equity: -5 } }, fy: { v: { netIncome: 3 } } }).returnOnEquity, null);
  assert.equal(freeCashFlow(entry.fy.v), 30);
  assert.equal(freeCashFlow({ operatingCashFlow: 5 }), null);
  assert.equal(growth(110, 100).toFixed(2), '0.10');
  assert.equal(growth(110, 0), null);
});

test('money and counts are written short', () => {
  assert.equal(formatUsd(350e9), '$350B');
  assert.equal(formatUsd(1.234e12), '$1.23T');
  assert.equal(formatUsd(45.6e6), '$45.6M');
  assert.equal(formatUsd(-2.5e9), '−$2.50B');
  assert.equal(formatUsd(999), '$999');
  assert.equal(formatUsd(undefined), null);
  assert.equal(formatCount(14.8e9), '14.80B');
  assert.equal(formatPerShare(6.0812), '$6.08');
  assert.equal(formatPerShare(-0.456), '−$0.46');
  assert.equal(formatPercent(0.2534), '25.3%');
  assert.equal(formatPercent(0.12, { signed: true }), '+12.0%');
  assert.equal(formatPercent(-0.045, { signed: true }), '−4.5%');
  assert.equal(formatPercent(null), null);
});

test('the card shows what was reported, links each filing, and omits the rest', () => {
  const out = assembleFinancials(new Set([APPLE]), FRAMES, '2026-10-31');
  const sections = financialSections(APPLE, out[APPLE]);
  assert.deepEqual(sections.map(s => s.title), ['Income statement', 'Balance sheet', 'Per share', 'Ratios and growth']);
  const balance = sections[1];
  // Node's ICU writes September as "Sep" or "Sept" depending on its version.
  assert.match(balance.period, /^As of 26 Sept? 2026$/);
  assert.deepEqual(balance.rows, [['Total assets', '$350B'], ['Cash and equivalents', '$30.0B'], ['Total liabilities', '$280B']]);
  assert.equal(balance.filing, 'https://www.sec.gov/Archives/edgar/data/320193/accCY2026Q3I/');
  assert.deepEqual(sections[2].rows, [['Earnings per share (diluted)', '$6.08'], ['Shares outstanding', '14.80B']]);
  assert.deepEqual(sections[3].rows, [['Net margin', '25.1%'], ['Revenue growth', '+2.4%'], ['Net income growth', '+7.2%'], ['EPS growth', '+0.0%']]);
  assert.equal(filingUrl(320193, '0000320193-26-000105'), 'https://www.sec.gov/Archives/edgar/data/320193/000032019326000105/');
  assert.deepEqual(financialSections(APPLE, undefined), []);
  const bank = financialSections(19617, { bs: { end: '2026-06-30', accn: 'x', v: { assets: 5e12, shortTermBorrowings: 72.4e9 } } });
  assert.deepEqual(bank.map(s => s.title), ['Balance sheet']);
  assert.deepEqual(bank[0].rows, [['Total assets', '$5.00T'], ['Short-term debt', '$72.4B']]);
});

test('a file only counts as changed when its figures change', () => {
  const companies = { 1: { bs: { end: '2026-06-30', accn: 'a', v: { assets: 1 } } } };
  const a = serialiseFinancials({ updated: '2026-10-01', companies });
  const b = serialiseFinancials({ updated: '2026-10-08', companies });
  assert.ok(sameFinancials(a, b));
  assert.ok(!sameFinancials(a, serialiseFinancials({ updated: '2026-10-08', companies: {} })));
  assert.equal(JSON.parse(a).count, 1);
});

const built = new URL('../data/markets/us-financials.json', import.meta.url);
test('data/markets/us-financials.json, if built, covers the big US companies', { skip: !existsSync(built) && 'not built yet' }, () => {
  const data = JSON.parse(readFileSync(built, 'utf8'));
  assert.match(data.updated, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(data.count, Object.keys(data.companies).length);
  assert.ok(data.count > 1000, `only ${data.count} companies`);
  for (const cik of [320193, 789019, 1045810]) { // Apple, Microsoft, Nvidia
    assert.ok(data.companies[cik]?.bs?.v?.assets > 0, `no balance sheet for CIK ${cik}`);
  }
});

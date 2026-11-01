// js/lib/shariah-screen.js
//
// An MSCI-style Shariah screen of a US company from its SEC filings: a
// business-activity screen on its industry code (SIC), then financial ratios
// measured against total assets, which need no share price. No DOM and no
// fetch: the weekly build runs it for every company to label search results,
// and the page runs it again to show the working on a company's card.
//
// The ratios, each against total assets, must be below one third:
//   total debt;
//   cash plus interest-bearing securities (short- and long-term);
//   receivables plus cash.
// Interest income must also be under 5% of revenue.
//
// The business screen can only see a company's main industry. A company whose
// main business is permissible but which earns some revenue from a
// non-permissible line (a hotel chain's bar, say) is not caught by it; MSCI
// checks that 5% revenue test against segment data this screen does not have.

import { shortTermDebt, totalDebt } from './financials.js';

export const LIMITS = { debt: 1 / 3, cash: 1 / 3, receivables: 1 / 3, interestIncome: 0.05 };

export const METHOD = {
  name: 'MSCI-style screen on total assets',
  note: 'Business activity from the SEC industry code; debt, cash and interest-bearing securities, and '
    + 'receivables and cash each below 33.33% of total assets; interest income below 5% of revenue.'
};

// SIC code ranges and what they mean for the business screen. "fail" is a
// main business that is not permissible; "review" is an industry that holds
// both kinds of company, which needs a closer look than a code allows.
const RULES = [
  { from: 6000, to: 6299, verdict: 'fail', reason: 'Conventional banking, lending or securities dealing' },
  { from: 6300, to: 6499, verdict: 'fail', reason: 'Conventional insurance' },
  { from: 6726, to: 6726, verdict: 'fail', reason: 'Investment fund or trust' },
  { from: 6798, to: 6798, verdict: 'review', reason: 'Real estate investment trust: depends on its tenants and financing' },
  { from: 2082, to: 2085, verdict: 'fail', reason: 'Alcoholic beverages' },
  { from: 5180, to: 5182, verdict: 'fail', reason: 'Beer, wine or spirits wholesale' },
  { from: 5813, to: 5813, verdict: 'fail', reason: 'Bars and drinking places' },
  { from: 2100, to: 2199, verdict: 'fail', reason: 'Tobacco products' },
  { from: 5194, to: 5194, verdict: 'fail', reason: 'Tobacco wholesale' },
  { from: 7011, to: 7011, verdict: 'fail', reason: 'Hotels and casinos' },
  { from: 7990, to: 7999, verdict: 'review', reason: 'Amusement and recreation: may include gambling' },
  { from: 3480, to: 3489, verdict: 'fail', reason: 'Weapons and ammunition' },
  { from: 3760, to: 3769, verdict: 'fail', reason: 'Guided missiles and space vehicles' },
  { from: 3795, to: 3795, verdict: 'fail', reason: 'Tanks and armoured vehicles' },
  { from: 7812, to: 7833, verdict: 'fail', reason: 'Film production, distribution or cinemas' },
  { from: 3652, to: 3652, verdict: 'fail', reason: 'Recorded music' },
  { from: 2011, to: 2011, verdict: 'review', reason: 'Meat packing: may include pork' },
  { from: 2013, to: 2013, verdict: 'review', reason: 'Prepared meats: may include pork' }
];

// A SIC code -> { verdict: 'pass' | 'fail' | 'review' | 'unknown', reason }.
export function businessScreen(sic) {
  const code = Number(sic);
  if (!sic || !Number.isFinite(code)) return { verdict: 'unknown', reason: 'No industry code on file' };
  const rule = RULES.find(r => code >= r.from && code <= r.to);
  return rule ? { verdict: rule.verdict, reason: rule.reason } : { verdict: 'pass', reason: null };
}

const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);

// Debt for the screen: the total when one can be told. Otherwise two bounds
// can still settle the test. Short-term debt alone is a floor, which can
// prove a failure. Total liabilities are a ceiling, since debt is part of
// them, which can prove a pass. Where neither settles it, debt is unknown.
function screenDebt(bs) {
  const total = totalDebt(bs);
  if (total !== null) return { value: total, bound: null, note: null };
  const short = shortTermDebt(bs);
  if (short !== null && bs.assets > 0 && short / bs.assets >= LIMITS.debt) {
    return { value: short, bound: 'floor', note: 'Only short-term debt could be read, and it alone is over the limit.' };
  }
  const liabilities = num(bs.liabilities) ?? (num(bs.assets) !== null && num(bs.equity) !== null ? bs.assets - bs.equity : null);
  if (liabilities !== null) {
    return {
      value: liabilities,
      bound: 'ceiling',
      note: 'Debt could not be read from the filings; this is total liabilities, which debt cannot exceed.'
    };
  }
  return { value: null, bound: null, note: 'Debt could not be read from the filings.' };
}

// One check: its ratio, the limit, and whether it passed (null when unknown).
// A floor can prove a failure but not a pass; a ceiling, a pass but not a
// failure.
function check(key, label, numerator, denominator, limit, { bound = null, note = null } = {}) {
  const ratio = numerator !== null && denominator ? numerator / denominator : null;
  let pass = ratio === null ? null : ratio < limit;
  if (bound === 'floor' && pass) pass = null;
  if (bound === 'ceiling' && !pass) pass = null;
  return { key, label, ratio, limit, pass, note };
}

// The whole screen for one company.
//   status: 'compliant' | 'noncompliant' | 'review' | 'insufficient'
export function screenCompany(entry = {}, sic = null) {
  const bs = entry.bs?.v || {};
  const fy = entry.fy?.v || {};
  const business = businessScreen(sic);
  const assets = num(bs.assets) > 0 ? bs.assets : null;

  const debt = screenDebt(bs);
  const cash = num(bs.cash);
  const securities = (num(bs.shortInvestments) || 0) + (num(bs.longInvestments) || 0);
  const interestBearing = cash === null ? null : cash + securities;
  const receivablesAndCash = cash === null ? null : cash + (num(bs.receivables) || 0);
  const interestIncome = num(fy.interestIncome);
  const revenue = num(fy.revenue) > 0 ? fy.revenue : null;

  const checks = [
    check('debt', debt.bound === 'ceiling' ? 'Total liabilities ÷ total assets' : 'Debt ÷ total assets', debt.value, assets, LIMITS.debt, { bound: debt.bound, note: debt.note }),
    check('cash', 'Cash and interest-bearing securities ÷ total assets', interestBearing, assets, LIMITS.cash),
    check('receivables', 'Receivables and cash ÷ total assets', receivablesAndCash, assets, LIMITS.receivables)
  ];
  // Interest income only counts when reported; most companies report none.
  if (interestIncome !== null && revenue !== null) {
    checks.push(check('interestIncome', 'Interest income ÷ revenue', interestIncome, revenue, LIMITS.interestIncome));
  }

  let status;
  if (business.verdict === 'fail' || checks.some(c => c.pass === false)) status = 'noncompliant';
  else if (business.verdict === 'unknown' || assets === null || checks.some(c => c.pass === null)) status = 'insufficient';
  else if (business.verdict === 'review') status = 'review';
  else status = 'compliant';

  // The share of income to give away from dividends, where it can be told.
  const purification = interestIncome !== null && revenue !== null ? Math.max(0, interestIncome / revenue) : null;

  return { status, business, checks, purification, asOf: entry.bs?.end || null };
}

// The words for each status, shared by the search results and the card.
export const STATUS_TEXT = {
  compliant: { label: 'Shariah compliant', chip: 'Halal' },
  noncompliant: { label: 'Not Shariah compliant', chip: 'Not halal' },
  review: { label: 'Needs review', chip: null },
  insufficient: { label: 'Not enough data to screen', chip: null }
};

// Compact codes for the file the search results read.
export const STATUS_CODE = { compliant: 'c', noncompliant: 'x', review: 'r', insufficient: 'u' };
export const CODE_STATUS = Object.fromEntries(Object.entries(STATUS_CODE).map(([k, v]) => [v, k]));

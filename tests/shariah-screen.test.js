// tests/shariah-screen.test.js
//
// The MSCI-style Shariah screen of US companies: the business screen on the
// industry code, the three ratios against total assets and the interest-income
// test, how missing figures are treated, and the industry cache that feeds it.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LIMITS, STATUS_CODE, businessScreen, screenCompany } from '../js/lib/shariah-screen.js';
import { totalDebt } from '../js/lib/financials.js';
import { ciksToFetch, mergeIndustries, readSubmission, submissionsUrl } from '../scripts/lib/us-industries.mjs';
import { buildScreening } from '../scripts/build-us-screening.mjs';

test('the business screen reads the main industry from its SIC code', () => {
  assert.equal(businessScreen('3571').verdict, 'pass');       // computers
  assert.equal(businessScreen('7372').verdict, 'pass');       // software
  assert.equal(businessScreen('2086').verdict, 'pass');       // soft drinks
  assert.equal(businessScreen('6021').verdict, 'fail');       // national banks
  assert.equal(businessScreen('6311').verdict, 'fail');       // life insurance
  assert.equal(businessScreen('2082').verdict, 'fail');       // brewers
  assert.equal(businessScreen('2111').verdict, 'fail');       // cigarettes
  assert.equal(businessScreen('7011').verdict, 'fail');       // hotels and casinos
  assert.equal(businessScreen('3760').verdict, 'fail');       // missiles
  assert.equal(businessScreen('6798').verdict, 'review');     // REITs
  assert.equal(businessScreen('2011').verdict, 'review');     // meat packing
  assert.equal(businessScreen('6500').verdict, 'pass');       // real estate
  assert.equal(businessScreen(null).verdict, 'unknown');
});

const company = (bs, fy = {}) => ({ bs: { end: '2026-06-30', v: bs }, fy: { v: fy } });
const clean = { assets: 1000, cash: 100, shortInvestments: 50, longInvestments: 50, receivables: 100, longTermDebt: 200 };

test('a company under every limit in a permissible industry is compliant', () => {
  const r = screenCompany(company(clean, { revenue: 500, interestIncome: 10 }), '3571');
  assert.equal(r.status, 'compliant');
  assert.deepEqual(r.checks.map(c => [c.key, Number(c.ratio.toFixed(3)), c.pass]), [
    ['debt', 0.2, true], ['cash', 0.2, true], ['receivables', 0.2, true], ['interestIncome', 0.02, true]
  ]);
  assert.equal(r.purification, 0.02);
  assert.equal(r.asOf, '2026-06-30');
});

test('each limit fails on its own, and long-term debt securities count as cash', () => {
  assert.equal(screenCompany(company({ ...clean, longTermDebt: 340 }), '3571').status, 'noncompliant');
  assert.equal(screenCompany(company({ ...clean, longInvestments: 190 }), '3571').status, 'noncompliant');
  assert.equal(screenCompany(company({ ...clean, receivables: 240 }), '3571').status, 'noncompliant');
  assert.equal(screenCompany(company(clean, { revenue: 100, interestIncome: 6 }), '3571').status, 'noncompliant');
  // Exactly at a third is not below it.
  assert.equal(screenCompany(company({ ...clean, longTermDebt: 1000 / 3 }), '3571').checks[0].pass, false);
  assert.equal(LIMITS.debt, 1 / 3);
});

test('a non-permissible business fails whatever its ratios; a mixed one needs review', () => {
  const bank = screenCompany(company(clean), '6021');
  assert.equal(bank.status, 'noncompliant');
  assert.match(bank.business.reason, /banking/);
  assert.equal(screenCompany(company(clean), '6798').status, 'review');
  assert.equal(screenCompany({}, '2082').status, 'noncompliant');
});

test('missing figures leave a company unscreened rather than passed', () => {
  assert.equal(screenCompany(company(clean), null).status, 'insufficient');
  assert.equal(screenCompany({}, '3571').status, 'insufficient');
  assert.equal(screenCompany(company({ ...clean, cash: undefined }), '3571').status, 'insufficient');
});

test('debt that cannot be read is settled by bounds, never assumed to be zero', () => {
  // Liabilities are a ceiling: under a third of assets proves the debt test.
  const light = screenCompany(company({ assets: 1000, liabilities: 200, cash: 100, receivables: 50 }), '3571');
  assert.equal(light.status, 'compliant');
  assert.equal(light.checks[0].label, 'Total liabilities ÷ total assets');
  assert.equal(light.checks[0].ratio, 0.2);
  assert.match(light.checks[0].note, /cannot exceed/);
  // A high ceiling proves nothing.
  const heavy = screenCompany(company({ assets: 1000, liabilities: 700, cash: 100 }), '3571');
  assert.equal(heavy.checks[0].pass, null);
  assert.equal(heavy.status, 'insufficient');
  // Without reported liabilities, assets less equity stands in for them.
  assert.equal(screenCompany(company({ assets: 1000, equity: 900, cash: 100 }), '3571').status, 'compliant');
  assert.equal(screenCompany(company({ assets: 1000, cash: 100 }), '3571').status, 'insufficient');
});

test('debt: short-term debt alone can prove a failure but not a pass', () => {
  const big = screenCompany(company({ assets: 1000, cash: 10, shortTermBorrowings: 400 }), '3571');
  assert.equal(big.status, 'noncompliant');
  assert.match(big.checks[0].note, /over the limit/);
  const small = screenCompany(company({ assets: 1000, cash: 10, shortTermBorrowings: 50, liabilities: 600 }), '3571');
  assert.equal(small.checks[0].pass, null);
  assert.equal(small.status, 'insufficient');
});

test('total debt adds finance leases and falls back to notes, without double counting', () => {
  assert.equal(totalDebt({ longTermDebt: 100, financeLease: 10 }), 110);
  assert.equal(totalDebt({ longTermDebtNoncurrent: 80, debtCurrent: 20, financeLeaseNoncurrent: 7, financeLeaseCurrent: 3 }), 110);
  // A tag that already includes leases gets none added.
  assert.equal(totalDebt({ longTermDebtAndLeasesNoncurrent: 90, debtCurrent: 10, financeLease: 5 }), 100);
  assert.equal(totalDebt({ seniorNotes: 50, convertibleNotes: 20, notesPayable: 50 }), 70);
  assert.equal(totalDebt({ notesPayable: 40, shortTermBorrowings: 5 }), 45);
  assert.equal(totalDebt({ lineOfCredit: 12 }), 12);
});

test('industry codes are read from SEC submissions records', () => {
  assert.equal(submissionsUrl(320193), 'https://data.sec.gov/submissions/CIK0000320193.json');
  assert.deepEqual(readSubmission({ sic: '3571', sicDescription: 'ELECTRONIC COMPUTERS' }), { sic: '3571', d: 'ELECTRONIC COMPUTERS' });
  assert.deepEqual(readSubmission({ sic: '100', sicDescription: 'AGRICULTURE' }), { sic: '0100', d: 'AGRICULTURE' });
  assert.equal(readSubmission({ sic: '' }), null);
});

test('the industry cache fetches new companies first, then the oldest checked', () => {
  const cache = { 1: { sic: '3571', c: '2026-10-01' }, 2: { sic: '7372', c: '2026-09-01' }, 3: { c: '2026-10-15' } };
  assert.deepEqual(ciksToFetch([1, 2, 3, 9, 7], cache, { refresh: 2 }), [7, 9, 2, 1]);
  const merged = mergeIndustries([1, 2, 7], cache, new Map([[7, { sic: '2834', d: 'PHARMA' }], [2, null]]), '2026-11-02');
  assert.deepEqual(merged, { 1: cache[1], 2: { c: '2026-11-02' }, 7: { sic: '2834', d: 'PHARMA', c: '2026-11-02' } });
});

test('the screening file labels every listed US company', () => {
  const listings = { companies: [{ s: 'AAPL', cik: 1 }, { s: 'BANK', cik: 2 }, { s: 'NEW', cik: 3 }, { s: 'NOCIK' }] };
  const financials = { companies: { 1: company(clean), 2: company(clean) } };
  const industries = { companies: { 1: { sic: '3571', d: 'ELECTRONIC COMPUTERS' }, 2: { sic: '6021', d: 'NATIONAL COMMERCIAL BANKS' } } };
  const { companies, counts } = buildScreening(listings, financials, industries);
  assert.deepEqual(companies, {
    1: { s: STATUS_CODE.compliant, sic: '3571', d: 'ELECTRONIC COMPUTERS' },
    2: { s: STATUS_CODE.noncompliant, sic: '6021', d: 'NATIONAL COMMERCIAL BANKS' },
    3: { s: STATUS_CODE.insufficient }
  });
  assert.deepEqual(counts, { compliant: 1, noncompliant: 1, insufficient: 1 });
});

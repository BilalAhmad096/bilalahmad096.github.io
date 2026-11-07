// tests/shariah-screen.test.js
//
// The Hanafi Shariah screen of US companies on Mufti Taqi Usmani's conditions:
// the business screen on the industry code, the ratios against total assets at
// Meezan's thresholds, the price condition the card adds once a quote arrives,
// how missing figures are treated, and the industry cache that feeds it.

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
  assert.equal(businessScreen('3760').verdict, 'fail');       // missiles
  assert.equal(businessScreen('6798').verdict, 'review');     // REITs
  assert.equal(businessScreen('2011').verdict, 'review');     // meat packing
  assert.equal(businessScreen('6500').verdict, 'pass');       // real estate
  assert.equal(businessScreen(null).verdict, 'unknown');
});

test('hotels need review rather than failing, since the code covers casinos too', () => {
  const hotels = businessScreen('7011');
  assert.equal(hotels.verdict, 'review');
  assert.match(hotels.reason, /casino/);
});

test('a group’s generic code never passes on behalf of the specific ones', () => {
  // Brown-Forman and Coca-Cola are both filed under 2080, so passing it would
  // label a distiller halal. The specific codes still decide for themselves.
  assert.equal(businessScreen('2080').verdict, 'review');
  assert.match(businessScreen('2080').reason, /distillers/);
  assert.equal(businessScreen('2082').verdict, 'fail');
  assert.equal(businessScreen('2086').verdict, 'pass');
  // Live Nation sits under 7900 rather than in the 7990 range.
  assert.equal(businessScreen('7900').verdict, 'review');
  assert.equal(businessScreen('7993').verdict, 'review');
  assert.equal(businessScreen('3652').verdict, 'fail');
});

test('broadcasting and streaming need review, wherever the SEC filed them', () => {
  // A studio or a cinema chain is still caught outright.
  assert.equal(businessScreen('7812').verdict, 'fail');
  assert.equal(businessScreen('7830').verdict, 'fail');
  // Netflix under video rental, Comcast under cable, Fox under television,
  // SiriusXM under radio: the same business on codes that cannot settle it.
  assert.equal(businessScreen('7841').verdict, 'review');
  assert.match(businessScreen('7841').reason, /streaming/);
  assert.equal(businessScreen('4841').verdict, 'review');
  assert.equal(businessScreen('4833').verdict, 'review');
  assert.equal(businessScreen('4832').verdict, 'review');
  // Neighbouring communications codes are untouched.
  assert.equal(businessScreen('4813').verdict, 'pass');
  assert.equal(businessScreen('4899').verdict, 'pass');
});

const company = (bs, fy = {}, extra = {}) => ({ bs: { end: '2026-06-30', v: bs }, fy: { v: fy }, ...extra });
const clean = { assets: 1000, cash: 100, shortInvestments: 50, longInvestments: 50, receivables: 100, longTermDebt: 200 };

test('a company inside every condition in a permissible industry is compliant', () => {
  const r = screenCompany(company(clean, { revenue: 500, interestIncome: 10 }), '3571');
  assert.equal(r.status, 'compliant');
  assert.deepEqual(r.checks.map(c => [c.key, Number(c.ratio.toFixed(3)), c.pass]), [
    ['debt', 0.2, true], ['investments', 0.2, true], ['illiquid', 0.7, true], ['interestIncome', 0.02, true]
  ]);
  assert.equal(r.purification, 0.02);
  assert.equal(r.asOf, '2026-06-30');
});

test('each threshold fails on its own, at Meezan’s figures', () => {
  // Debt is allowed up to 37% of assets, not a third.
  assert.equal(screenCompany(company({ ...clean, longTermDebt: 340 }), '3571').status, 'compliant');
  assert.equal(screenCompany(company({ ...clean, longTermDebt: 380 }), '3571').status, 'noncompliant');
  // Exactly at the limit is not below it.
  assert.equal(screenCompany(company({ ...clean, longTermDebt: 370 }), '3571').checks[0].pass, false);
  assert.equal(LIMITS.debt, 0.37);

  // Long-term debt securities count with cash as interest-bearing.
  assert.equal(screenCompany(company({ ...clean, longInvestments: 190 }), '3571').status, 'noncompliant');
  assert.equal(screenCompany(company(clean, { revenue: 100, interestIncome: 6 }), '3571').status, 'noncompliant');
});

test('illiquid assets are a floor, and receivables count as liquid', () => {
  // Liquid is cash, securities and receivables: 750 of 1000 leaves exactly the
  // 25% floor, which is reached rather than missed.
  const atFloor = screenCompany(company({ ...clean, receivables: 550 }), '3571');
  assert.equal(atFloor.checks[2].ratio, 0.25);
  assert.equal(atFloor.checks[2].pass, true);
  assert.equal(atFloor.status, 'compliant');
  // One more of receivables and the illiquid part is in ignorable quantity.
  const below = screenCompany(company({ ...clean, receivables: 600 }), '3571');
  assert.equal(below.checks[2].ratio, 0.2);
  assert.equal(below.checks[2].pass, false);
  assert.equal(below.status, 'noncompliant');
  assert.equal(LIMITS.illiquid, 0.25);
  assert.equal(below.checks[2].kind, 'min');
});

test('a price adds the condition that a share cost more than its liquid assets', () => {
  // Liquid 300 less liabilities 100 is 200 of net liquid assets over 100
  // shares: $2 a share, which any sane price exceeds.
  const bs = { ...clean, liabilities: 100 };
  const priced = screenCompany(company(bs, {}, { shares: { val: 100 } }), '3571', { price: 10 });
  const check = priced.checks.at(-1);
  assert.equal(check.key, 'price');
  assert.equal(check.kind, 'price');
  assert.equal(check.perShare, 2);
  assert.equal(check.price, 10);
  assert.equal(check.pass, true);
  assert.equal(priced.status, 'compliant');

  // Usmani's theoretical case: a price at or below the liquid amount is riba.
  assert.equal(screenCompany(company(bs, {}, { shares: { val: 100 } }), '3571', { price: 2 }).status, 'noncompliant');
  assert.equal(screenCompany(company(bs, {}, { shares: { val: 100 } }), '3571', { price: 1.5 }).checks.at(-1).pass, false);
});

test('the price condition is left out, not left unknown, when it cannot be worked out', () => {
  const withShares = company({ ...clean, liabilities: 100 }, {}, { shares: { val: 100 } });
  const keys = r => r.checks.map(c => c.key);
  // No price at all: the weekly build's case.
  assert.ok(!keys(screenCompany(withShares, '3571')).includes('price'));
  // A company with several share classes has no usable share count.
  assert.ok(!keys(screenCompany(withShares, '3571', { price: 10, shareClasses: 2 })).includes('price'));
  // No share count on file, and no liabilities to net off.
  assert.ok(!keys(screenCompany(company({ ...clean, liabilities: 100 }), '3571', { price: 10 })).includes('price'));
  assert.ok(!keys(screenCompany(company(clean, {}, { shares: { val: 100 } }), '3571', { price: 10 })).includes('price'));
  // Leaving it out never unscreens a company the filings had settled.
  assert.equal(screenCompany(withShares, '3571', { price: 10, shareClasses: 2 }).status, 'compliant');
});

test('a non-permissible business fails whatever its ratios; a mixed one needs review', () => {
  const bank = screenCompany(company(clean), '6021');
  assert.equal(bank.status, 'noncompliant');
  assert.match(bank.business.reason, /banking/);
  assert.equal(screenCompany(company(clean), '6798').status, 'review');
  // The industry rules a company out even with no figures to screen.
  assert.equal(screenCompany({}, '2082').status, 'noncompliant');
  assert.equal(screenCompany(undefined, '2082').status, 'noncompliant');
});

test('a company with no balance sheet is held apart from one with gaps', () => {
  assert.equal(screenCompany(undefined, '3571').status, 'notScreenable');
  assert.equal(screenCompany({}, '3571').status, 'notScreenable');
  assert.deepEqual(screenCompany(undefined, '3571').checks, []);
  // Figures on file but a needed one unreadable is still a screen that ran.
  assert.equal(screenCompany(company({ ...clean, cash: undefined }), '3571').status, 'insufficient');
  assert.equal(screenCompany(company({ ...clean, assets: 0 }), '3571').status, 'insufficient');
  assert.equal(screenCompany(company(clean), null).status, 'insufficient');
});

test('debt that cannot be read is settled by bounds, never assumed to be zero', () => {
  // Liabilities are a ceiling: under the limit they prove the debt test.
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
    // No filings and no industry code: nothing to screen, rather than a gap.
    3: { s: STATUS_CODE.notScreenable }
  });
  assert.deepEqual(counts, { compliant: 1, noncompliant: 1, notScreenable: 1 });
});

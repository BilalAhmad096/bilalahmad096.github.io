// js/lib/shariah-screen.js
//
// A Hanafi Shariah screen of a US company from its SEC filings, on the
// conditions Mufti Muhammad Taqi Usmani sets for owning shares, with the
// thresholds his own Shariah board applies at Meezan Bank and in the KMI-30
// index. No DOM and no fetch: the weekly build runs it for every company to
// label search results, and the page runs it again to show the working on a
// company's card.
//
// Usmani's four conditions are that the company's main business be
// permissible; that the shareholder object to any interest dealing rather
// than consent to it; that interest income be given away rather than kept;
// and that the shares be negotiable at all, which on the Hanafi view they are
// whatever the proportion of liquid assets, so long as the illiquid part is
// "not in ignorable quantity" and the price exceeds the liquid amount the
// share represents. He fixes no percentage himself, so the figures are the
// six criteria of the KMI-30 methodology (Pakistan Stock Exchange, screened by
// Al Meezan, whose Shariah board he chairs):
//
//   illiquid assets                at least 25% of total assets;
//   interest-bearing debt          below 37% of total assets, preference
//                                  shares included;
//   non-compliant investments      below 33% of total assets;
//   non-compliant income           below 5% of total revenue;
//   market price per share         above net liquid assets per share.
//
// Debt is measured against total assets, not market capitalisation: filings
// give the one without a price, and it does not move with the market.
//
// Where the filings fall short of KMI's definitions, the screen takes the
// stricter reading. All cash counts as interest-bearing, where KMI counts only
// interest-bearing deposits; all securities count as liquid, where KMI counts
// shares in compliant companies as illiquid; and interest income is set
// against revenue alone, where KMI adds other income to the denominator.
// KMI's price test passes a price equal to the net liquid assets; Usmani's own
// example forbids that too, so equal fails here.
//
// The business screen can only see a company's main industry. A company whose
// main business is permissible but which earns some revenue from a
// non-permissible line (a hotel chain's bar, say) is not caught by it, and the
// income test sees only interest, not that revenue.

import { shortTermDebt, totalDebt } from './financials.js';

export const LIMITS = { debt: 0.37, investments: 0.33, illiquid: 0.25, interestIncome: 0.05 };

export const METHOD = {
  name: 'Hanafi screen on Mufti Taqi Usmani’s conditions',
  note: 'Business activity from the SEC industry code; illiquid assets at least 25% of total assets; '
    + 'interest-bearing debt (preference shares included) below 37% and interest-bearing investments below 33% of total assets; '
    + 'interest income below 5% of revenue; and the share price above the net liquid assets it represents. '
    + 'Thresholds from the KMI-30 methodology, screened by Al Meezan, whose Shariah board Usmani chairs; '
    + 'his own conditions fix no percentage.'
};

// SIC code ranges and what they mean for the business screen. "fail" is a
// main business that is not permissible; "review" is an industry that holds
// both kinds of company, which needs a closer look than a code allows.
const RULES = [
  { from: 6000, to: 6299, verdict: 'fail', reason: 'Conventional banking, lending or securities dealing' },
  { from: 6300, to: 6499, verdict: 'fail', reason: 'Conventional insurance' },
  { from: 6726, to: 6726, verdict: 'fail', reason: 'Investment fund or trust' },
  { from: 6798, to: 6798, verdict: 'review', reason: 'Real estate investment trust: depends on its tenants and financing' },
  // The SEC often files a company under a group's generic code rather than the
  // specific one, and the generic code cannot tell the two apart: Brown-Forman
  // and Willamette Valley Vineyards sit under 2080 with Coca-Cola, and Live
  // Nation under 7900 rather than 7990. Passing those would label a distiller
  // halal, so they need review.
  { from: 2080, to: 2080, verdict: 'review', reason: 'Beverages: the code covers soft drinks, brewers and distillers alike' },
  { from: 2082, to: 2085, verdict: 'fail', reason: 'Alcoholic beverages' },
  { from: 5180, to: 5182, verdict: 'fail', reason: 'Beer, wine or spirits wholesale' },
  { from: 5813, to: 5813, verdict: 'fail', reason: 'Bars and drinking places' },
  // Tobacco and weapons are not on the lists of forbidden businesses in
  // Usmani's conditions or in the KMI-30 methodology, and scholars differ on
  // both, so they need review rather than failing outright.
  { from: 2100, to: 2199, verdict: 'review', reason: 'Tobacco products: not on Usmani’s or KMI’s list of forbidden businesses, and scholars differ on it' },
  { from: 5194, to: 5194, verdict: 'review', reason: 'Tobacco wholesale: not on Usmani’s or KMI’s list of forbidden businesses, and scholars differ on it' },
  // The SEC files ordinary hotel groups and casino operators under the same
  // code, so it cannot settle the question on its own.
  { from: 7011, to: 7011, verdict: 'review', reason: 'Hotels: the code covers both hotel groups and casino operators' },
  { from: 7900, to: 7900, verdict: 'review', reason: 'Amusement and recreation: the generic code also covers gambling and entertainment' },
  { from: 7990, to: 7999, verdict: 'review', reason: 'Amusement and recreation: may include gambling' },
  { from: 3480, to: 3489, verdict: 'review', reason: 'Weapons and ammunition: not on Usmani’s or KMI’s list of forbidden businesses, and scholars differ on it' },
  { from: 3760, to: 3769, verdict: 'review', reason: 'Guided missiles and space vehicles: not on Usmani’s or KMI’s list of forbidden businesses, and scholars differ on weapons' },
  { from: 3795, to: 3795, verdict: 'review', reason: 'Tanks and armoured vehicles: not on Usmani’s or KMI’s list of forbidden businesses, and scholars differ on it' },
  { from: 7812, to: 7833, verdict: 'fail', reason: 'Film production, distribution or cinemas' },
  { from: 3652, to: 3652, verdict: 'fail', reason: 'Recorded music' },
  // The codes above are where the 1987 classification put film and music, and
  // they still catch a studio or a cinema chain. Broadcasting and streaming
  // moved the same business onto the codes below, which the SEC has not
  // revisited: Netflix is filed under video rental, from its DVD-by-post days,
  // and Comcast under cable television although it owns a film studio. Each of
  // these carries news and sport as readily as film and music, so the code
  // cannot settle it either way.
  { from: 4832, to: 4832, verdict: 'review', reason: 'Radio broadcasting: the output may be music as readily as speech' },
  { from: 4833, to: 4833, verdict: 'review', reason: 'Television broadcasting: the output ranges from news and sport to film and music' },
  { from: 4841, to: 4841, verdict: 'review', reason: 'Cable and pay television: may carry or produce film and music' },
  { from: 7841, to: 7841, verdict: 'review', reason: 'Video rental: the code predates the streaming studios filed under it' },
  { from: 2011, to: 2011, verdict: 'review', reason: 'Meat packing: may include pork' },
  { from: 2013, to: 2013, verdict: 'review', reason: 'Prepared meats: may include pork' },
  // KMI rules out selling haram meat as well as pork, and meat a poultry
  // processor sells is not, as a rule, slaughtered the Islamic way.
  { from: 2015, to: 2015, verdict: 'review', reason: 'Poultry slaughtering: the meat is not, as a rule, slaughtered the Islamic way' }
];

// A SIC code -> { verdict: 'pass' | 'fail' | 'review' | 'unknown', reason }.
export function businessScreen(sic) {
  const code = Number(sic);
  if (!sic || !Number.isFinite(code)) return { verdict: 'unknown', reason: 'No industry code on file' };
  const rule = RULES.find(r => code >= r.from && code <= r.to);
  return rule ? { verdict: rule.verdict, reason: rule.reason } : { verdict: 'pass', reason: null };
}

const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);

// Total liabilities as reported, or assets less equity, which comes to the
// same thing when both are on file.
function liabilitiesOf(bs) {
  const reported = num(bs.liabilities);
  if (reported !== null) return reported;
  const assets = num(bs.assets);
  const equity = num(bs.equity);
  return assets !== null && equity !== null ? assets - equity : null;
}

// Debt for the screen: the total when one can be told. Otherwise two bounds
// can still settle the test. Short-term debt alone is a floor, which can
// prove a failure. Total liabilities are a ceiling, since debt is part of
// them, which can prove a pass. Where neither settles it, debt is unknown.
//
// Preference shares are added to each: KMI counts them as interest-bearing
// debt, and they sit in equity, not in liabilities, so the ceiling needs them
// too.
function screenDebt(bs) {
  const preferred = Math.max(0, num(bs.preferredStock) || 0);
  const withPreferred = note => (preferred > 0 ? `${note ? `${note} ` : ''}Includes preference shares, which count as debt.` : note);
  const total = totalDebt(bs);
  if (total !== null) return { value: total + preferred, bound: null, note: withPreferred(null) };
  const short = shortTermDebt(bs);
  if (short !== null && bs.assets > 0 && (short + preferred) / bs.assets >= LIMITS.debt) {
    return {
      value: short + preferred,
      bound: 'floor',
      note: withPreferred('Only short-term debt could be read, and it alone is over the limit.')
    };
  }
  const liabilities = liabilitiesOf(bs);
  if (liabilities !== null) {
    return {
      value: liabilities + preferred,
      bound: 'ceiling',
      note: withPreferred('Debt could not be read from the filings; this is total liabilities, which debt cannot exceed.')
    };
  }
  return { value: null, bound: null, note: 'Debt could not be read from the filings.' };
}

// Interest income for the screen, on the same footing as debt. Reported, it
// is exact. Otherwise net interest, when positive, is a floor (a company
// cannot net more than it earned), and interest and other income together are
// a ceiling. A bound only counts where it settles the 5% test; where nothing
// does, the test is left out, as it is for a company that reports no figure.
function screenInterestIncome(fy, revenue) {
  const reported = num(fy.interestIncome);
  if (reported !== null) return { value: reported, bound: null, note: null };
  if (revenue === null) return null;
  const net = num(fy.interestNet);
  if (net !== null && net > 0 && net / revenue >= LIMITS.interestIncome) {
    return { value: net, bound: 'floor', note: 'Interest income is not reported on its own; this is net interest, which it is at least.' };
  }
  const combined = num(fy.interestAndOtherIncome);
  if (combined !== null && combined >= 0 && combined / revenue < LIMITS.interestIncome) {
    return {
      value: combined,
      bound: 'ceiling',
      note: 'Interest income is not reported on its own; this is interest and other income together, which it cannot exceed.'
    };
  }
  return null;
}

// One check: its ratio, the limit, and whether it passed (null when unknown).
// A "max" test must come in under its limit; a "min" test must reach it. A
// floor can prove a failure but not a pass; a ceiling, a pass but not a
// failure.
function check(key, label, numerator, denominator, limit, { kind = 'max', bound = null, note = null } = {}) {
  const ratio = numerator !== null && denominator ? numerator / denominator : null;
  let pass = ratio === null ? null : (kind === 'min' ? ratio >= limit : ratio < limit);
  if (bound === 'floor' && pass) pass = null;
  if (bound === 'ceiling' && !pass) pass = null;
  return { key, label, ratio, limit, kind, pass, note };
}

// The whole screen for one company. A price, where the page has one, adds
// Usmani's condition that a share cost more than the liquid amount it
// represents; the weekly build has no price and leaves that check out.
//
//   status: 'compliant' | 'noncompliant' | 'review' | 'insufficient' | 'notScreenable'
export function screenCompany(entry, sic = null, { price = null, shareClasses = 1 } = {}) {
  const bs = entry?.bs?.v;
  const fy = entry?.fy?.v || {};
  const business = businessScreen(sic);

  // A company with no balance sheet on file cannot be screened at all, which
  // is not the same as a screen that ran and came up short: most of these are
  // funds, trusts and foreign filers rather than companies with gaps. Its
  // industry can still rule it out.
  if (!bs) {
    return {
      status: business.verdict === 'fail' ? 'noncompliant' : 'notScreenable',
      business,
      checks: [],
      purification: null,
      asOf: null
    };
  }

  const assets = num(bs.assets) > 0 ? bs.assets : null;
  const debt = screenDebt(bs);
  const cash = num(bs.cash);
  const securities = (num(bs.shortInvestments) || 0) + (num(bs.longInvestments) || 0);
  // Interest-bearing holdings, which Meezan screens as non-compliant
  // investments: cash on deposit and the debt securities it is parked in.
  const interestBearing = cash === null ? null : cash + securities;
  // Liquid assets for the negotiability test: cash, those securities, and
  // receivables, which count as liquid because a debt owed in money is money.
  const liquid = cash === null ? null : cash + securities + (num(bs.receivables) || 0);
  const illiquid = liquid === null || assets === null ? null : assets - liquid;
  const revenue = num(fy.revenue) > 0 ? fy.revenue : null;
  const interest = screenInterestIncome(fy, revenue);

  const checks = [
    check('debt', debt.bound === 'ceiling' ? 'Total liabilities ÷ total assets' : 'Interest-bearing debt ÷ total assets',
      debt.value, assets, LIMITS.debt, { bound: debt.bound, note: debt.note }),
    check('investments', 'Cash and interest-bearing securities ÷ total assets', interestBearing, assets, LIMITS.investments),
    check('illiquid', 'Illiquid assets ÷ total assets', illiquid, assets, LIMITS.illiquid, { kind: 'min' })
  ];
  // Interest income only counts when it can be read or bounded; many
  // companies report none, and the card says so.
  if (interest && revenue !== null) {
    checks.push(check('interestIncome',
      interest.bound === 'ceiling' ? 'Interest and other income ÷ revenue'
        : interest.bound === 'floor' ? 'Net interest ÷ revenue' : 'Interest income ÷ revenue',
      interest.value, revenue, LIMITS.interestIncome, { bound: interest.bound, note: interest.note }));
  }

  // Usmani's price condition: a share must cost more than the liquid amount
  // it represents, or money is being exchanged for less money. He calls a
  // failure a theoretical possibility, so where the price, the share count or
  // the liabilities are missing the check is left out rather than counted
  // unknown, which would unscreen a company the filings alone had settled.
  const shares = shareClasses === 1 ? num(entry?.shares?.val) : null;
  const liabilities = liabilitiesOf(bs);
  const quoted = num(price);
  if (quoted !== null && quoted > 0 && shares !== null && shares > 0 && liquid !== null && liabilities !== null) {
    const perShare = (liquid - liabilities) / shares;
    checks.push({
      key: 'price',
      label: 'Market price vs net liquid assets per share',
      kind: 'price',
      price: quoted,
      perShare,
      ratio: perShare / quoted,
      limit: 1,
      pass: perShare < quoted,
      note: null
    });
  }

  let status;
  if (business.verdict === 'fail' || checks.some(c => c.pass === false)) status = 'noncompliant';
  else if (business.verdict === 'unknown' || assets === null || checks.some(c => c.pass === null)) status = 'insufficient';
  else if (business.verdict === 'review') status = 'review';
  else status = 'compliant';

  // The share of income to give away from dividends, where it can be told:
  // Usmani's proportion of interest in the company's income. From a ceiling
  // it is an upper bound, which gives away a little more than is due; from a
  // floor, a lower one.
  const purification = interest && revenue !== null ? Math.max(0, interest.value / revenue) : null;
  const purificationBound = purification === null ? null : interest.bound;

  return { status, business, checks, purification, purificationBound, asOf: entry.bs?.end || null };
}

// The words for each status, shared by the search results and the card.
export const STATUS_TEXT = {
  compliant: { label: 'Shariah compliant', chip: 'Halal' },
  noncompliant: { label: 'Not Shariah compliant', chip: 'Not halal' },
  review: { label: 'Needs review', chip: null },
  insufficient: { label: 'Not enough data to screen', chip: null },
  notScreenable: { label: 'No SEC figures to screen', chip: null }
};

// Compact codes for the file the search results read.
export const STATUS_CODE = { compliant: 'c', noncompliant: 'x', review: 'r', insufficient: 'u', notScreenable: 'n' };
export const CODE_STATUS = Object.fromEntries(Object.entries(STATUS_CODE).map(([k, v]) => [v, k]));

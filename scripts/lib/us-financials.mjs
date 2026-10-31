// The pure half of the US financials build: which SEC figures are read, which
// periods are asked for, and how each company's latest balance sheet and
// annual results are picked out of them. No fetch and no filesystem.
//
// The figures come from the SEC's XBRL "frames" API. One frame is one figure
// (a tag such as us-gaap:Assets) for one calendar period, across every company
// that reported it, so a few hundred requests cover the whole market:
//
//   https://data.sec.gov/api/xbrl/frames/{taxonomy}/{tag}/{unit}/{period}.json
//
// Companies label the same figure differently, so each field lists the tags
// that can carry it, in order of preference; the first one a company reported
// for the chosen period is used. Every field of one statement comes from the
// same period, so a balance sheet never mixes two quarters.
//
// Only figures reported in US dollars are read. Foreign companies that file
// in another currency (many 20-F filers) are left without financials rather
// than shown in the wrong unit.

// Balance sheet figures, read at a quarter end.
export const BALANCE_FIELDS = [
  ["assets", [["us-gaap", "Assets"], ["ifrs-full", "Assets"]]],
  ["liabilities", [["us-gaap", "Liabilities"], ["ifrs-full", "Liabilities"]]],
  ["equity", [
    ["us-gaap", "StockholdersEquity"],
    ["us-gaap", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
    ["ifrs-full", "Equity"]
  ]],
  ["cash", [
    ["us-gaap", "CashAndCashEquivalentsAtCarryingValue"],
    ["us-gaap", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"],
    ["ifrs-full", "CashAndCashEquivalents"]
  ]],
  ["shortInvestments", [
    ["us-gaap", "ShortTermInvestments"],
    ["us-gaap", "MarketableSecuritiesCurrent"],
    ["us-gaap", "AvailableForSaleSecuritiesDebtSecuritiesCurrent"]
  ]],
  ["receivables", [
    ["us-gaap", "AccountsReceivableNetCurrent"],
    ["us-gaap", "ReceivablesNetCurrent"],
    ["ifrs-full", "TradeAndOtherCurrentReceivables"]
  ]],
  // Debt is kept as the pieces companies report; js/lib/financials.js adds
  // them up without counting a current portion twice.
  ["longTermDebt", [["us-gaap", "LongTermDebt"]]],
  ["longTermDebtNoncurrent", [
    ["us-gaap", "LongTermDebtNoncurrent"],
    ["us-gaap", "LongTermDebtAndCapitalLeaseObligations"]
  ]],
  ["longTermDebtCurrent", [
    ["us-gaap", "LongTermDebtCurrent"],
    ["us-gaap", "LongTermDebtAndCapitalLeaseObligationsCurrent"]
  ]],
  ["debtCurrent", [["us-gaap", "DebtCurrent"]]],
  ["shortTermBorrowings", [["us-gaap", "ShortTermBorrowings"]]],
  ["commercialPaper", [["us-gaap", "CommercialPaper"]]],
  ["borrowings", [["ifrs-full", "Borrowings"]]]
];

// Results for a full year.
export const ANNUAL_FIELDS = [
  ["revenue", [
    ["us-gaap", "Revenues"],
    ["us-gaap", "RevenueFromContractWithCustomerExcludingAssessedTax"],
    ["us-gaap", "SalesRevenueNet"],
    ["us-gaap", "RevenueFromContractWithCustomerIncludingAssessedTax"],
    // Banks report revenue net of the interest they pay.
    ["us-gaap", "RevenuesNetOfInterestExpense"],
    ["us-gaap", "SalesRevenueGoodsNet"],
    ["us-gaap", "SalesRevenueServicesNet"],
    ["ifrs-full", "Revenue"]
  ]],
  ["operatingIncome", [["us-gaap", "OperatingIncomeLoss"], ["ifrs-full", "ProfitLossFromOperatingActivities"]]],
  ["netIncome", [["us-gaap", "NetIncomeLoss"], ["ifrs-full", "ProfitLoss"]]],
  ["interestExpense", [
    ["us-gaap", "InterestExpense"],
    ["us-gaap", "InterestExpenseNonoperating"],
    ["us-gaap", "InterestExpenseDebt"],
    ["ifrs-full", "FinanceCosts"]
  ]],
  ["interestIncome", [
    ["us-gaap", "InvestmentIncomeInterest"],
    ["us-gaap", "InterestIncomeOther"],
    ["us-gaap", "InvestmentIncomeInterestAndDividend"]
  ]]
];

// Shares outstanding, from the filing's cover page.
export const SHARES_TAG = ["dei", "EntityCommonStockSharesOutstanding"];

// The statement each kind of period is anchored on: a company's balance sheet
// date is the latest quarter it reported total assets for; its fiscal year is
// the latest year it reported net income or revenue for.
const BALANCE_ANCHOR = "assets";
const ANNUAL_ANCHORS = ["netIncome", "revenue"];

// The quarter ends to look back over, newest first, as frame period names
// ("CY2026Q2I"). A quarter is only asked for once it has ended.
export function instantPeriods(today, count = 5) {
  const d = new Date(`${today}T00:00:00Z`);
  let year = d.getUTCFullYear();
  let quarter = Math.floor(d.getUTCMonth() / 3); // the last quarter that has fully ended
  if (quarter === 0) { quarter = 4; year -= 1; }
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push(`CY${year}Q${quarter}I`);
    quarter -= 1;
    if (quarter === 0) { quarter = 4; year -= 1; }
  }
  return out;
}

// The calendar years to look back over, newest first ("CY2025").
export function annualPeriods(today, count = 2) {
  const year = Number(today.slice(0, 4)) - 1;
  return Array.from({ length: count }, (_, i) => `CY${year - i}`);
}

export function frameUrl([taxonomy, tag], unit, period) {
  return `https://data.sec.gov/api/xbrl/frames/${taxonomy}/${tag}/${unit}/${period}.json`;
}

// Every frame a build reads, so the fetching side is a plain loop.
export function framesToFetch(today) {
  const list = [];
  for (const period of instantPeriods(today)) {
    for (const [, tags] of BALANCE_FIELDS) for (const tag of tags) list.push({ tag, unit: "USD", period });
    list.push({ tag: SHARES_TAG, unit: "shares", period });
  }
  for (const period of annualPeriods(today)) {
    for (const [, tags] of ANNUAL_FIELDS) for (const tag of tags) list.push({ tag, unit: "USD", period });
  }
  return list;
}

export function frameKey(tag, unit, period) {
  return `${tag[0]}:${tag[1]}:${unit}:${period}`;
}

// A frame response -> Map(cik -> { val, end, start?, accn }), kept to the
// companies the site lists.
export function readFrame(json, ciks) {
  const map = new Map();
  for (const row of json?.data || []) {
    const cik = Number(row.cik);
    if (!ciks.has(cik) || typeof row.val !== "number") continue;
    map.set(cik, { val: row.val, end: row.end, start: row.start, accn: row.accn });
  }
  return map;
}

// One statement for one company: the newest period its anchor appears in,
// then each field from the first of its tags reported in that same period.
function pickStatement(cik, fields, anchors, periods, unit, frames) {
  const lookup = (tags, period) => {
    for (const tag of tags) {
      const hit = frames.get(frameKey(tag, unit, period))?.get(cik);
      if (hit) return hit;
    }
    return null;
  };
  const byName = new Map(fields);
  for (const period of periods) {
    const anchor = anchors.map(name => lookup(byName.get(name), period)).find(Boolean);
    if (!anchor) continue;
    const values = {};
    for (const [name, tags] of fields) {
      const hit = lookup(tags, period);
      if (hit) values[name] = Math.round(hit.val);
    }
    const out = { end: anchor.end, accn: anchor.accn, v: values };
    if (anchor.start) out.start = anchor.start;
    return out;
  }
  return null;
}

// Every listed company's latest figures, keyed by CIK (one CIK can stand for
// several share classes, such as GOOG and GOOGL).
export function assembleFinancials(ciks, frames, today) {
  const instants = instantPeriods(today);
  const years = annualPeriods(today);
  const out = {};
  for (const cik of [...ciks].sort((a, b) => a - b)) {
    const balance = pickStatement(cik, BALANCE_FIELDS, [BALANCE_ANCHOR], instants, "USD", frames);
    const annual = pickStatement(cik, ANNUAL_FIELDS, ANNUAL_ANCHORS, years, "USD", frames);
    let shares = null;
    for (const period of instants) {
      const hit = frames.get(frameKey(SHARES_TAG, "shares", period))?.get(cik);
      if (hit) { shares = { end: hit.end, val: Math.round(hit.val) }; break; }
    }
    if (!balance && !annual) continue;
    const company = {};
    if (balance) company.bs = balance;
    if (annual) company.fy = annual;
    if (shares) company.shares = shares;
    out[cik] = company;
  }
  return out;
}

export function serialiseFinancials({ updated, companies }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(updated)) throw new Error(`bad updated date: ${updated}`);
  return JSON.stringify({
    source: "SEC EDGAR XBRL frames (data.sec.gov), figures in US dollars",
    updated,
    count: Object.keys(companies).length,
    companies
  }) + "\n";
}

// True when two files hold the same figures, whatever their date.
export function sameFinancials(a, b) {
  try {
    return JSON.stringify(JSON.parse(a).companies) === JSON.stringify(JSON.parse(b).companies);
  } catch {
    return false;
  }
}

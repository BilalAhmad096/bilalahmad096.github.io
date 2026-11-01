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
//
// A field is [name, tags] for a dollar amount, or [name, tags, unit] for
// anything else: per-share figures are in "USD-per-shares".

const PER_SHARE = "USD-per-shares";

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
  // Debt securities held for more than a year: interest-bearing, so they count
  // with cash in the Shariah screen. Equity stakes (LongTermInvestments) are
  // not interest-bearing and are left out.
  ["longInvestments", [
    ["us-gaap", "MarketableSecuritiesNoncurrent"],
    ["us-gaap", "AvailableForSaleSecuritiesDebtSecuritiesNoncurrent"]
  ]],
  ["receivables", [
    ["us-gaap", "AccountsReceivableNetCurrent"],
    ["us-gaap", "ReceivablesNetCurrent"],
    ["ifrs-full", "TradeAndOtherCurrentReceivables"]
  ]],
  ["inventory", [["us-gaap", "InventoryNet"], ["ifrs-full", "Inventories"]]],
  ["currentAssets", [["us-gaap", "AssetsCurrent"], ["ifrs-full", "CurrentAssets"]]],
  ["currentLiabilities", [["us-gaap", "LiabilitiesCurrent"], ["ifrs-full", "CurrentLiabilities"]]],
  ["ppe", [["us-gaap", "PropertyPlantAndEquipmentNet"], ["ifrs-full", "PropertyPlantAndEquipment"]]],
  ["goodwill", [["us-gaap", "Goodwill"], ["ifrs-full", "Goodwill"]]],
  // Debt is kept as the pieces companies report; js/lib/financials.js adds
  // them up without counting a current portion twice.
  ["longTermDebt", [["us-gaap", "LongTermDebt"]]],
  ["longTermDebtNoncurrent", [["us-gaap", "LongTermDebtNoncurrent"]]],
  // The same, with finance leases already folded in.
  ["longTermDebtAndLeasesNoncurrent", [["us-gaap", "LongTermDebtAndCapitalLeaseObligations"]]],
  ["longTermDebtCurrent", [
    ["us-gaap", "LongTermDebtCurrent"],
    ["us-gaap", "LongTermDebtAndCapitalLeaseObligationsCurrent"]
  ]],
  ["debtCurrent", [["us-gaap", "DebtCurrent"]]],
  ["shortTermBorrowings", [["us-gaap", "ShortTermBorrowings"]]],
  ["commercialPaper", [["us-gaap", "CommercialPaper"]]],
  ["borrowings", [["ifrs-full", "Borrowings"]]],
  ["financeLease", [["us-gaap", "FinanceLeaseLiability"]]],
  ["financeLeaseNoncurrent", [["us-gaap", "FinanceLeaseLiabilityNoncurrent"]]],
  ["financeLeaseCurrent", [["us-gaap", "FinanceLeaseLiabilityCurrent"]]],
  // What smaller companies tag instead of LongTermDebt.
  ["seniorNotes", [["us-gaap", "SeniorNotes"]]],
  ["notesPayable", [["us-gaap", "LongTermNotesPayable"], ["us-gaap", "NotesPayable"]]],
  ["convertibleNotes", [["us-gaap", "ConvertibleNotesPayable"], ["us-gaap", "ConvertibleDebtNoncurrent"]]],
  ["lineOfCredit", [["us-gaap", "LineOfCredit"], ["us-gaap", "LongTermLineOfCredit"]]]
];

// Results and cash flows for a full year.
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
  ["costOfRevenue", [
    ["us-gaap", "CostOfRevenue"],
    ["us-gaap", "CostOfGoodsAndServicesSold"],
    ["ifrs-full", "CostOfSales"]
  ]],
  ["grossProfit", [["us-gaap", "GrossProfit"], ["ifrs-full", "GrossProfit"]]],
  ["researchAndDevelopment", [["us-gaap", "ResearchAndDevelopmentExpense"], ["ifrs-full", "ResearchAndDevelopmentExpense"]]],
  ["sellingGeneralAdmin", [["us-gaap", "SellingGeneralAndAdministrativeExpense"]]],
  ["operatingIncome", [["us-gaap", "OperatingIncomeLoss"], ["ifrs-full", "ProfitLossFromOperatingActivities"]]],
  ["incomeTax", [["us-gaap", "IncomeTaxExpenseBenefit"], ["ifrs-full", "IncomeTaxExpenseContinuingOperations"]]],
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
  ]],
  ["epsBasic", [["us-gaap", "EarningsPerShareBasic"], ["ifrs-full", "BasicEarningsLossPerShare"]], PER_SHARE],
  ["epsDiluted", [["us-gaap", "EarningsPerShareDiluted"], ["ifrs-full", "DilutedEarningsLossPerShare"]], PER_SHARE],
  ["dividendsPerShare", [
    ["us-gaap", "CommonStockDividendsPerShareDeclared"],
    ["us-gaap", "CommonStockDividendsPerShareCashPaid"]
  ], PER_SHARE],
  ["operatingCashFlow", [
    ["us-gaap", "NetCashProvidedByUsedInOperatingActivities"],
    ["ifrs-full", "CashFlowsFromUsedInOperatingActivities"]
  ]],
  ["capitalExpenditure", [
    ["us-gaap", "PaymentsToAcquirePropertyPlantAndEquipment"],
    ["us-gaap", "PaymentsToAcquireProductiveAssets"],
    ["ifrs-full", "PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities"]
  ]],
  ["dividendsPaid", [
    ["us-gaap", "PaymentsOfDividends"],
    ["us-gaap", "PaymentsOfDividendsCommonStock"],
    ["ifrs-full", "DividendsPaidClassifiedAsFinancingActivities"]
  ]],
  ["shareBuybacks", [["us-gaap", "PaymentsForRepurchaseOfCommonStock"]]]
];

// The year before, for growth: the same fields, from the next older year.
const PRIOR_FIELDS = ["revenue", "netIncome", "epsDiluted", "operatingCashFlow"];

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

// The calendar years to look back over, newest first ("CY2025"). Three, so a
// company whose latest is a year behind still has the year before it.
export function annualPeriods(today, count = 3) {
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
    for (const [, tags, unit = "USD"] of BALANCE_FIELDS) for (const tag of tags) list.push({ tag, unit, period });
    list.push({ tag: SHARES_TAG, unit: "shares", period });
  }
  for (const period of annualPeriods(today)) {
    for (const [, tags, unit = "USD"] of ANNUAL_FIELDS) for (const tag of tags) list.push({ tag, unit, period });
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

// Dollar amounts are whole dollars; per-share figures keep their cents.
function tidy(value, unit) {
  return unit === "USD" ? Math.round(value) : Math.round(value * 10000) / 10000;
}

// One statement for one company: the newest period its anchor appears in,
// then each field from the first of its tags reported in that same period.
// With prior, the year before that period is read for the PRIOR_FIELDS too.
function pickStatement(cik, fields, anchors, periods, frames, { prior = false } = {}) {
  const byName = new Map(fields.map(([name, tags, unit = "USD"]) => [name, { tags, unit }]));
  const lookup = (name, period) => {
    const { tags, unit } = byName.get(name);
    for (const tag of tags) {
      const hit = frames.get(frameKey(tag, unit, period))?.get(cik);
      if (hit) return { ...hit, val: tidy(hit.val, unit) };
    }
    return null;
  };
  const read = (names, period) => {
    const values = {};
    for (const name of names) {
      const hit = lookup(name, period);
      if (hit) values[name] = hit.val;
    }
    return values;
  };
  for (let i = 0; i < periods.length; i += 1) {
    const anchor = anchors.map(name => lookup(name, periods[i])).find(Boolean);
    if (!anchor) continue;
    const out = { end: anchor.end, accn: anchor.accn, v: read(byName.keys(), periods[i]) };
    if (anchor.start) out.start = anchor.start;
    if (prior && periods[i + 1]) {
      const before = anchors.map(name => lookup(name, periods[i + 1])).find(Boolean);
      if (before) out.prev = { end: before.end, v: read(PRIOR_FIELDS, periods[i + 1]) };
    }
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
    const balance = pickStatement(cik, BALANCE_FIELDS, [BALANCE_ANCHOR], instants, frames);
    const annual = pickStatement(cik, ANNUAL_FIELDS, ANNUAL_ANCHORS, years, frames, { prior: true });
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

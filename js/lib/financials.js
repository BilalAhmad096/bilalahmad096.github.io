// js/lib/financials.js
//
// Reading a US company's figures from data/markets/us-financials.json for the
// Market Explorer card. No DOM and no fetch, so it runs identically in the page
// and under node --test.

// Total debt from the pieces a company reported, or null when it cannot be
// told (unknown, which is not the same as no debt).
//
// LongTermDebt already includes the part due within a year, and DebtCurrent
// already includes short-term borrowings and commercial paper, so each total
// is built from pieces that do not overlap. Finance leases are debt; they are
// added unless the tag read already includes them. A total needs a long-term
// figure: a company whose only readable piece is short-term (JPMorgan files
// its long-term debt in a breakdown the SEC's frames leave out) would
// otherwise show a fraction of its debt as the whole.
export function totalDebt(v = {}) {
  const has = k => typeof v[k] === 'number';
  const sum = (...keys) => keys.reduce((t, k) => t + (has(k) ? v[k] : 0), 0);
  const current = () => (has('debtCurrent')
    ? v.debtCurrent
    : sum('longTermDebtCurrent', 'shortTermBorrowings', 'commercialPaper'));
  const leases = () => (has('financeLease') ? v.financeLease : sum('financeLeaseNoncurrent', 'financeLeaseCurrent'));

  if (has('longTermDebt')) return v.longTermDebt + sum('shortTermBorrowings', 'commercialPaper') + leases();
  if (has('longTermDebtNoncurrent')) return v.longTermDebtNoncurrent + current() + leases();
  if (has('longTermDebtAndLeasesNoncurrent')) return v.longTermDebtAndLeasesNoncurrent + current();
  if (has('borrowings')) return v.borrowings;
  // Notes, convertibles and credit lines are separate instruments; a
  // company's NotesPayable can be its senior notes, so it is only used alone.
  const notes = ['seniorNotes', 'convertibleNotes', 'lineOfCredit'].filter(has);
  if (notes.length || has('notesPayable')) {
    return (notes.length ? sum(...notes) : v.notesPayable) + sum('shortTermBorrowings', 'commercialPaper') + leases();
  }
  return null;
}

// The short-term pieces, shown on their own when no total can be given.
export function shortTermDebt(v = {}) {
  if (typeof v.debtCurrent === 'number') return v.debtCurrent;
  const parts = ['longTermDebtCurrent', 'shortTermBorrowings', 'commercialPaper'].filter(k => typeof v[k] === 'number');
  return parts.length ? parts.reduce((t, k) => t + v[k], 0) : null;
}

// 1234567890 -> "$1.23B"; -45600000 -> "−$45.6M".
export function formatUsd(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const sign = value < 0 ? '−' : '';
  const abs = Math.abs(value);
  const units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [size, suffix] of units) {
    if (abs >= size) {
      const n = abs / size;
      return `${sign}$${n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)}${suffix}`;
    }
  }
  return `${sign}$${abs.toFixed(0)}`;
}

export function formatCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const units = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [size, suffix] of units) {
    if (value >= size) return `${(value / size).toFixed(2)}${suffix}`;
  }
  return String(value);
}

// "2026-06-30" -> "30 Jun 2026"
export function formatDay(iso) {
  if (!iso) return null;
  return new Date(`${iso}T00:00:00Z`)
    .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

// The filing a statement came from: its folder in EDGAR's archive.
export function filingUrl(cik, accn) {
  if (!cik || !accn) return null;
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${String(accn).replace(/-/g, '')}/`;
}

// $1.23 per share; −$0.45.
export function formatPerShare(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return `${value < 0 ? '−' : ''}$${Math.abs(value).toFixed(2)}`;
}

// 0.2534 -> "25.3%"; growth gets a sign: "+12.0%", "−4.5%".
export function formatPercent(ratio, { signed = false } = {}) {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return null;
  const pct = ratio * 100;
  const sign = pct < 0 ? '−' : signed && pct > 0 ? '+' : '';
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

function ratio(a, b) {
  return typeof a === 'number' && typeof b === 'number' && b !== 0 ? a / b : null;
}

// Year-on-year change. Undefined from a loss, where a percentage misleads.
export function growth(now, before) {
  if (typeof now !== 'number' || typeof before !== 'number' || before <= 0) return null;
  return (now - before) / before;
}

// Operating cash flow less capital spending, when both are known.
export function freeCashFlow(v = {}) {
  if (typeof v.operatingCashFlow !== 'number' || typeof v.capitalExpenditure !== 'number') return null;
  return v.operatingCashFlow - v.capitalExpenditure;
}

// Gross profit as reported, or revenue less cost of revenue.
function grossProfit(v) {
  if (typeof v.grossProfit === 'number') return v.grossProfit;
  if (typeof v.revenue === 'number' && typeof v.costOfRevenue === 'number') return v.revenue - v.costOfRevenue;
  return null;
}

// Ratios worked out from the figures, each only when both sides are known.
// Return on equity mixes the year's profit with the latest balance sheet, as
// is usual for a quick view, and is left out when equity is negative.
export function financialRatios(entry = {}) {
  const fy = entry.fy?.v || {};
  const bs = entry.bs?.v || {};
  const prev = entry.fy?.prev?.v || {};
  return {
    grossMargin: ratio(grossProfit(fy), fy.revenue),
    operatingMargin: ratio(fy.operatingIncome, fy.revenue),
    netMargin: ratio(fy.netIncome, fy.revenue),
    returnOnEquity: bs.equity > 0 ? ratio(fy.netIncome, bs.equity) : null,
    debtToAssets: ratio(totalDebt(bs), bs.assets),
    currentRatio: ratio(bs.currentAssets, bs.currentLiabilities),
    revenueGrowth: growth(fy.revenue, prev.revenue),
    netIncomeGrowth: growth(fy.netIncome, prev.netIncome),
    epsGrowth: growth(fy.epsDiluted, prev.epsDiluted)
  };
}

// The card's sections: a title, the period, the filing and labelled rows.
// Rows a company did not report are left out rather than shown as zero.
export function financialSections(cik, entry) {
  if (!entry) return [];
  const sections = [];
  const rows = list => list.filter(([, value]) => value !== null);
  const year = entry.fy && (entry.fy.start
    ? `Year ${formatDay(entry.fy.start)} to ${formatDay(entry.fy.end)}`
    : `Year to ${formatDay(entry.fy.end)}`);

  if (entry.fy) {
    const v = entry.fy.v;
    sections.push({
      title: 'Income statement',
      period: year,
      filing: filingUrl(cik, entry.fy.accn),
      rows: rows([
        ['Revenue', formatUsd(v.revenue)],
        ['Cost of revenue', formatUsd(v.costOfRevenue)],
        ['Gross profit', formatUsd(grossProfit(v))],
        ['Research and development', formatUsd(v.researchAndDevelopment)],
        ['Selling, general and admin', formatUsd(v.sellingGeneralAdmin)],
        ['Operating income', formatUsd(v.operatingIncome)],
        ['Interest expense', formatUsd(v.interestExpense)],
        ['Interest income', formatUsd(v.interestIncome)],
        ['Income tax', formatUsd(v.incomeTax)],
        ['Net income', formatUsd(v.netIncome)]
      ])
    });
  }
  if (entry.bs) {
    const v = entry.bs.v;
    sections.push({
      title: 'Balance sheet',
      period: `As of ${formatDay(entry.bs.end)}`,
      filing: filingUrl(cik, entry.bs.accn),
      rows: rows([
        ['Total assets', formatUsd(v.assets)],
        ['Current assets', formatUsd(v.currentAssets)],
        ['Cash and equivalents', formatUsd(v.cash)],
        ['Short-term investments', formatUsd(v.shortInvestments)],
        ['Long-term debt securities', formatUsd(v.longInvestments)],
        ['Receivables', formatUsd(v.receivables)],
        ['Inventory', formatUsd(v.inventory)],
        ['Property and equipment', formatUsd(v.ppe)],
        ['Goodwill', formatUsd(v.goodwill)],
        ['Total liabilities', formatUsd(v.liabilities)],
        ['Current liabilities', formatUsd(v.currentLiabilities)],
        ['Total debt', formatUsd(totalDebt(v))],
        ['Short-term debt', totalDebt(v) === null ? formatUsd(shortTermDebt(v)) : null],
        ["Shareholders' equity", formatUsd(v.equity)]
      ])
    });
  }
  if (entry.fy) {
    const v = entry.fy.v;
    sections.push({
      title: 'Cash flow',
      period: year,
      filing: filingUrl(cik, entry.fy.accn),
      rows: rows([
        ['Operating cash flow', formatUsd(v.operatingCashFlow)],
        ['Capital expenditure', formatUsd(v.capitalExpenditure)],
        ['Free cash flow', formatUsd(freeCashFlow(v))],
        ['Dividends paid', formatUsd(v.dividendsPaid)],
        ['Share buybacks', formatUsd(v.shareBuybacks)]
      ])
    });
  }
  const perShare = rows([
    ['Earnings per share (diluted)', formatPerShare(entry.fy?.v.epsDiluted)],
    ['Earnings per share (basic)', formatPerShare(entry.fy?.v.epsBasic)],
    ['Dividends per share', formatPerShare(entry.fy?.v.dividendsPerShare)],
    ['Shares outstanding', entry.shares ? formatCount(entry.shares.val) : null]
  ]);
  if (perShare.length) {
    sections.push({
      title: 'Per share',
      period: entry.fy ? year : `Shares as of ${formatDay(entry.shares.end)}`,
      filing: null,
      rows: perShare
    });
  }
  const r = financialRatios(entry);
  const prevYear = entry.fy?.prev?.end ? `growth on the year to ${formatDay(entry.fy.prev.end)}` : null;
  sections.push({
    title: 'Ratios and growth',
    period: ['Worked out from the figures above', prevYear].filter(Boolean).join('; '),
    filing: null,
    rows: rows([
      ['Gross margin', formatPercent(r.grossMargin)],
      ['Operating margin', formatPercent(r.operatingMargin)],
      ['Net margin', formatPercent(r.netMargin)],
      ['Return on equity', formatPercent(r.returnOnEquity)],
      ['Debt to assets', formatPercent(r.debtToAssets)],
      ['Current ratio', r.currentRatio === null ? null : r.currentRatio.toFixed(2)],
      ['Revenue growth', formatPercent(r.revenueGrowth, { signed: true })],
      ['Net income growth', formatPercent(r.netIncomeGrowth, { signed: true })],
      ['EPS growth', formatPercent(r.epsGrowth, { signed: true })]
    ])
  });
  return sections.filter(sec => sec.rows.length);
}

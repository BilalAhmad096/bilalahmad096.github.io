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
// is built from pieces that do not overlap. A total needs a long-term figure:
// a company whose only readable piece is short-term (JPMorgan files its
// long-term debt in a breakdown the SEC's frames leave out) would otherwise
// show a fraction of its debt as the whole.
export function totalDebt(v = {}) {
  const has = k => typeof v[k] === 'number';
  const sum = (...keys) => keys.reduce((t, k) => t + (has(k) ? v[k] : 0), 0);

  if (has('longTermDebt')) {
    return v.longTermDebt + sum('shortTermBorrowings', 'commercialPaper');
  }
  if (has('longTermDebtNoncurrent')) {
    const current = has('debtCurrent')
      ? v.debtCurrent
      : sum('longTermDebtCurrent', 'shortTermBorrowings', 'commercialPaper');
    return v.longTermDebtNoncurrent + current;
  }
  if (has('borrowings')) return v.borrowings;
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

// The card's sections: a title, the period, the filing and labelled rows.
// Rows a company did not report are left out rather than shown as zero.
export function financialSections(cik, entry) {
  if (!entry) return [];
  const sections = [];
  const rows = list => list.filter(([, value]) => value !== null);

  if (entry.bs) {
    const v = entry.bs.v;
    sections.push({
      title: 'Balance sheet',
      period: `As of ${formatDay(entry.bs.end)}`,
      filing: filingUrl(cik, entry.bs.accn),
      rows: rows([
        ['Total assets', formatUsd(v.assets)],
        ['Total liabilities', formatUsd(v.liabilities)],
        ["Shareholders' equity", formatUsd(v.equity)],
        ['Cash and equivalents', formatUsd(v.cash)],
        ['Short-term investments', formatUsd(v.shortInvestments)],
        ['Receivables', formatUsd(v.receivables)],
        ['Total debt', formatUsd(totalDebt(v))],
        ['Short-term debt', totalDebt(v) === null ? formatUsd(shortTermDebt(v)) : null]
      ])
    });
  }
  if (entry.fy) {
    const v = entry.fy.v;
    sections.push({
      title: 'Annual results',
      period: entry.fy.start
        ? `Year ${formatDay(entry.fy.start)} to ${formatDay(entry.fy.end)}`
        : `Year to ${formatDay(entry.fy.end)}`,
      filing: filingUrl(cik, entry.fy.accn),
      rows: rows([
        ['Revenue', formatUsd(v.revenue)],
        ['Operating income', formatUsd(v.operatingIncome)],
        ['Net income', formatUsd(v.netIncome)],
        ['Interest expense', formatUsd(v.interestExpense)],
        ['Interest income', formatUsd(v.interestIncome)]
      ])
    });
  }
  if (entry.shares) {
    sections.push({
      title: 'Shares',
      period: `As of ${formatDay(entry.shares.end)}`,
      filing: null,
      rows: rows([['Shares outstanding', formatCount(entry.shares.val)]])
    });
  }
  return sections.filter(s => s.rows.length);
}

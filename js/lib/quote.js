// js/lib/quote.js
//
// A US company's price from the Worker's /v1/quote, set against its SEC
// figures: market capitalisation and P/E. No DOM and no fetch.

import { formatUsd } from './financials.js';

export const DEFAULT_API_BASE = 'https://ask-mintorian-api.dystil-ai.workers.dev';
export const LOCAL_API_BASE = 'http://127.0.0.1:8787';

// Where the page asks for prices: a data-api-base on the explorer wins, then
// the local Worker on a local copy of the site, then the deployed one.
export function apiBaseFor(hostname, override) {
  if (override) return override.replace(/\/+$/, '');
  return /^(localhost|127\.0\.0\.1)$/.test(hostname) ? LOCAL_API_BASE : DEFAULT_API_BASE;
}

// Market cap and P/E from a price.
//
// Shares outstanding come from the filing's cover page, which lists one class
// at a time for a company with several (Alphabet's GOOGL and GOOG), so market
// cap is left out for those rather than understated. P/E uses diluted EPS for
// the last full fiscal year, the nearest to a trailing figure SEC filings give,
// and is left out after a loss, where a P/E means nothing.
export function valuation(price, entry, { shareClasses = 1 } = {}) {
  const shares = entry?.shares?.val;
  const eps = entry?.fy?.v?.epsDiluted;
  return {
    marketCap: price > 0 && shares > 0 && shareClasses === 1 ? price * shares : null,
    pe: price > 0 && eps > 0 ? price / eps : null,
    epsYearEnd: entry?.fy?.end || null,
    loss: typeof eps === 'number' && eps <= 0
  };
}

export function formatPrice(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// "+1.23 (+0.46%)" or "−4.10 (−1.52%)"
export function formatChange(change, percent) {
  if (typeof change !== 'number' || !Number.isFinite(change)) return null;
  const sign = change > 0 ? '+' : change < 0 ? '−' : '';
  const pct = typeof percent === 'number' && Number.isFinite(percent) ? ` (${sign}${Math.abs(percent).toFixed(2)}%)` : '';
  return `${sign}${Math.abs(change).toFixed(2)}${pct}`;
}

// "3 Nov, 4:00 pm ET": the market's own clock, whatever the visitor's.
export function formatQuoteTime(iso) {
  if (!iso) return null;
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return null;
  const day = when.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'America/New_York' });
  const time = when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
  return `${day}, ${time.toLowerCase()} ET`;
}

export function valuationRows(v) {
  const rows = [];
  if (v.marketCap !== null) rows.push(['Market cap', formatUsd(v.marketCap)]);
  if (v.pe !== null) rows.push(['P/E (last fiscal year)', v.pe.toFixed(1)]);
  else if (v.loss) rows.push(['P/E (last fiscal year)', 'n/a (loss-making)']);
  return rows;
}

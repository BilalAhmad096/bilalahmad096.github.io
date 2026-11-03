// tests/quotes.test.js
//
// Live prices: the Worker's /v1/quote, which hides the Finnhub key, checks the
// caller and caps calls to Finnhub; and the page's working of market cap and
// P/E from a price and the SEC figures.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import worker from '../worker/src/index.js';
import { normaliseSymbol, readQuote } from '../worker/src/quotes.js';
import {
  apiBaseFor, formatChange, formatPrice, formatQuoteTime, valuation, valuationRows
} from '../js/lib/quote.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function context() {
  return { promises: [], waitUntil(p) { this.promises.push(p); } };
}

// A KV stand-in, so the shared cap on Finnhub calls can be exercised.
function kv() {
  const store = new Map();
  return { get: async k => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); }, store };
}

const quoteRequest = (symbol, origin = 'https://mintorian.com') =>
  new Request(`https://api.example/v1/quote?symbol=${encodeURIComponent(symbol)}`, { headers: origin ? { Origin: origin } : {} });

const FINNHUB_AAPL = { c: 270.37, d: 1.23, dp: 0.4569, h: 271.1, l: 266.2, o: 267, pc: 269.14, t: 1762203600 };

test('a quote is fetched with the key in a header, never in the answer', async () => {
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), token: init.headers['X-Finnhub-Token'] };
    return new Response(JSON.stringify(FINNHUB_AAPL), { status: 200 });
  };
  const env = { ENVIRONMENT: 'production', FINNHUB_API_KEY: 'secret-key', RATE_LIMIT_KV: kv() };
  const response = await worker.fetch(quoteRequest('aapl'), env, context());
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(seen.url, 'https://finnhub.io/api/v1/quote?symbol=AAPL');
  assert.equal(seen.token, 'secret-key');
  assert.equal(body.quote.symbol, 'AAPL');
  assert.equal(body.quote.price, 270.37);
  assert.equal(body.quote.time, '2025-11-03T21:00:00.000Z');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://mintorian.com');
  assert.equal(JSON.stringify(body).includes('secret-key'), false);
});

test('quotes are refused to other sites, bad symbols, and before a key is set', async () => {
  globalThis.fetch = async () => { throw new Error('must not be called'); };
  const env = { ENVIRONMENT: 'production', FINNHUB_API_KEY: 'k' };
  assert.equal((await worker.fetch(quoteRequest('AAPL', 'https://evil.example'), env, context())).status, 403);
  assert.equal((await worker.fetch(quoteRequest('AAPL; DROP'), env, context())).status, 400);
  const unconfigured = await worker.fetch(quoteRequest('AAPL'), { ENVIRONMENT: 'production' }, context());
  assert.equal(unconfigured.status, 503);
  assert.equal((await unconfigured.json()).code, 'quotes_not_configured');
});

test('an unknown symbol, a Finnhub limit and an outage each get their own answer', async () => {
  const env = { ENVIRONMENT: 'production', FINNHUB_API_KEY: 'k' };
  globalThis.fetch = async () => new Response(JSON.stringify({ c: 0, d: null, dp: null, h: 0, l: 0, o: 0, pc: 0, t: 0 }));
  assert.equal((await worker.fetch(quoteRequest('ZZZZ'), env, context())).status, 404);
  globalThis.fetch = async () => new Response('{}', { status: 429 });
  assert.equal((await (await worker.fetch(quoteRequest('AAPL'), env, context())).json()).code, 'quotes_busy');
  globalThis.fetch = async () => { throw new Error('offline'); };
  assert.equal((await worker.fetch(quoteRequest('AAPL'), env, context())).status, 502);
});

test('calls to Finnhub stop at the shared per-minute budget', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response(JSON.stringify(FINNHUB_AAPL)); };
  const env = { ENVIRONMENT: 'production', FINNHUB_API_KEY: 'k', RATE_LIMIT_KV: kv(), QUOTE_UPSTREAM_PER_MINUTE: '2', QUOTE_RATE_LIMIT: '100' };
  const statuses = [];
  for (let i = 0; i < 3; i += 1) statuses.push((await worker.fetch(quoteRequest('AAPL'), env, context())).status);
  assert.deepEqual(statuses, [200, 200, 503]);
  assert.equal(calls, 2);
});

test('symbols are checked and Finnhub quotes read', () => {
  assert.equal(normaliseSymbol(' brk.b '), 'BRK.B');
  assert.throws(() => normaliseSymbol(''), /invalid_symbol/);
  assert.throws(() => normaliseSymbol('../etc'), /invalid_symbol/);
  assert.equal(readQuote('X', { c: 0, t: 0 }), null);
  assert.equal(readQuote('AAPL', FINNHUB_AAPL).changePercent, 0.4569);
});

test('the health check says whether prices are configured, without the key', async () => {
  const body = await (await worker.fetch(new Request('https://api.example/v1/health'), { FINNHUB_API_KEY: 'secret-key' }, context())).json();
  assert.equal(body.integrations.quotes, true);
  assert.equal(JSON.stringify(body).includes('secret-key'), false);
});

const APPLE = { shares: { val: 14.8e9 }, fy: { end: '2025-09-27', v: { epsDiluted: 7.46 } } };

test('market cap and P/E are worked out from the price and the SEC figures', () => {
  const v = valuation(270.37, APPLE);
  assert.equal(Math.round(v.marketCap / 1e9), 4001);
  assert.equal(v.pe.toFixed(1), '36.2');
  assert.deepEqual(valuationRows(v), [['Market cap', '$4.00T'], ['P/E (last fiscal year)', '36.2']]);
  // Several share classes: the cover page lists one, so no market cap.
  assert.equal(valuation(270.37, APPLE, { shareClasses: 2 }).marketCap, null);
  // A loss leaves P/E meaningless.
  const loss = valuation(10, { fy: { v: { epsDiluted: -0.5 } } });
  assert.equal(loss.pe, null);
  assert.deepEqual(valuationRows(loss), [['P/E (last fiscal year)', 'n/a (loss-making)']]);
  assert.deepEqual(valuationRows(valuation(10, undefined)), []);
});

test('prices, changes and times are written for people', () => {
  assert.equal(formatPrice(270.37), '$270.37');
  assert.equal(formatPrice(1234.5), '$1,234.50');
  assert.equal(formatChange(1.23, 0.4569), '+1.23 (+0.46%)');
  assert.equal(formatChange(-4.1, -1.52), '−4.10 (−1.52%)');
  assert.equal(formatChange(null, null), null);
  assert.equal(formatQuoteTime('2025-11-03T21:00:00.000Z'), '3 Nov, 4:00 pm ET');
  assert.equal(apiBaseFor('mintorian.com'), 'https://ask-mintorian-api.dystil-ai.workers.dev');
  assert.equal(apiBaseFor('localhost'), 'http://127.0.0.1:8787');
  assert.equal(apiBaseFor('mintorian.com', 'https://api.example/'), 'https://api.example');
});

// GET /v1/quote?symbol=AAPL: a US stock's latest price, for the Market Explorer
// on /tools/. The page is static and cannot hold a price-API key, so it asks
// here and the key stays a Worker secret (FINNHUB_API_KEY).
//
// Finnhub's free plan allows 60 calls a minute across everyone, so each quote
// is cached for a minute and calls to Finnhub are capped below that budget.
// A visitor who opens a card that someone else opened in the last minute is
// served from the cache without a call.

import { RequestError, assertAllowedOrigin, enforceRateLimit, jsonResponse } from "./security.js";

const FINNHUB_QUOTE = "https://finnhub.io/api/v1/quote";
const CACHE_SECONDS = 60;
const DEFAULT_UPSTREAM_PER_MINUTE = 50;

// US symbols as the Market Explorer lists them: letters and digits, with a
// dot for a share class (BRK.B).
export function normaliseSymbol(value) {
  const symbol = String(value || "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{0,6}(\.[A-Z])?$/.test(symbol)) {
    throw new RequestError("invalid_symbol", 400, "That is not a valid US ticker symbol.");
  }
  return symbol;
}

// Finnhub's quote -> the fields the page shows. Finnhub answers an unknown
// symbol with zeros rather than an error.
export function readQuote(symbol, body) {
  const price = Number(body?.c);
  const time = Number(body?.t);
  if (!Number.isFinite(price) || price <= 0 || !time) return null;
  const num = value => (Number.isFinite(Number(value)) ? Number(value) : null);
  return {
    symbol,
    price,
    change: num(body.d),
    changePercent: num(body.dp),
    open: num(body.o),
    high: num(body.h),
    low: num(body.l),
    previousClose: num(body.pc),
    time: new Date(time * 1000).toISOString(),
    source: "Finnhub"
  };
}

// One shared budget for calls to Finnhub, whoever triggers them. KV is only
// eventually consistent, so the cap sits below Finnhub's limit with room to
// spare; without KV (local development) there is no shared cap.
async function takeUpstreamCall(env) {
  if (!env.RATE_LIMIT_KV) return true;
  const limit = Number(env.QUOTE_UPSTREAM_PER_MINUTE || DEFAULT_UPSTREAM_PER_MINUTE);
  const key = `quote-upstream:${Math.floor(Date.now() / 60000)}`;
  const used = Number(await env.RATE_LIMIT_KV.get(key) || 0);
  if (used >= limit) return false;
  await env.RATE_LIMIT_KV.put(key, String(used + 1), { expirationTtl: 120 });
  return true;
}

function cacheKey(symbol) {
  return new Request(`https://quotes.cache.internal/v1/${encodeURIComponent(symbol)}`);
}

export async function quoteResponse(request, env, ctx) {
  assertAllowedOrigin(request, env);
  await enforceRateLimit(request, env, "quote", Number(env.QUOTE_RATE_LIMIT || 60), 60);
  const symbol = normaliseSymbol(new URL(request.url).searchParams.get("symbol"));

  if (!env.FINNHUB_API_KEY) {
    throw new RequestError("quotes_not_configured", 503, "Live prices are not available yet.");
  }

  // The Cache API exists on Cloudflare but not under node --test.
  const cache = globalThis.caches?.default;
  if (cache) {
    const hit = await cache.match(cacheKey(symbol));
    if (hit) return jsonResponse(request, env, { ok: true, cached: true, quote: await hit.json() });
  }

  if (!(await takeUpstreamCall(env))) {
    throw new RequestError("quotes_busy", 503, "Prices are busy right now. Please try again in a minute.");
  }

  let response;
  try {
    response = await fetch(`${FINNHUB_QUOTE}?symbol=${encodeURIComponent(symbol)}`, {
      headers: { "X-Finnhub-Token": env.FINNHUB_API_KEY, Accept: "application/json" },
      signal: AbortSignal.timeout(8000)
    });
  } catch {
    throw new RequestError("quotes_unavailable", 502, "The price service could not be reached.");
  }
  if (response.status === 429) {
    throw new RequestError("quotes_busy", 503, "Prices are busy right now. Please try again in a minute.");
  }
  if (!response.ok) {
    console.error("Quote request failed", response.status);
    throw new RequestError("quotes_unavailable", 502, "The price service could not be reached.");
  }

  const quote = readQuote(symbol, await response.json());
  if (!quote) throw new RequestError("quote_not_found", 404, "No price was found for that symbol.");

  if (cache) {
    const stored = new Response(JSON.stringify(quote), {
      headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${CACHE_SECONDS}` }
    });
    ctx?.waitUntil?.(cache.put(cacheKey(symbol), stored));
  }
  return jsonResponse(request, env, { ok: true, cached: false, quote });
}

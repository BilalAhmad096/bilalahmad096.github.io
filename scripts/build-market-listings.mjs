// Builds data/markets/india.json (NSE) and data/markets/us.json (NYSE and
// Nasdaq), the companies the Market Explorer on /tools/ searches.
//
// GitHub Pages serves a static tree, so the lists are fetched here, in a weekly
// GitHub Action, and committed as files every visitor reads the same copy of.
//
//   node scripts/build-market-listings.mjs [--only india|us] [--out-dir <dir>]
//
// Every source is public and needs no credential. Each market is built on its
// own: if one exchange's file cannot be read, the other is still refreshed and
// the stale one is left as it was, and the run fails so the miss is seen. The
// industry and CIK joins only enrich a market, so losing one is a warning.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseNseEquities,
  parseNseIndustries,
  mergeUsListings,
  parseNasdaqListings,
  parseNyseListings,
  parseSecCiks,
  sameCompanies,
  serialiseMarket
} from "./lib/market-listings.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const NSE_EQUITIES = "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv";
const NSE_INDUSTRIES = "https://nsearchives.nseindia.com/content/indices/ind_niftytotalmarket_list.csv";
const NASDAQ_LISTINGS = "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt";
const NYSE_LISTINGS = "https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt";
const SEC_TICKERS = "https://www.sec.gov/files/company_tickers_exchange.json";

// NSE turns away requests that do not look like a browser. The SEC asks for a
// user agent naming who is calling.
const BROWSER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const SITE_AGENT = "mintorian.com market-listings build (https://mintorian.com)";

function readArgs(argv) {
  const args = { only: null, outDir: "data/markets" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--only") args.only = argv[++i];
    else if (argv[i] === "--out-dir") args.outDir = argv[++i];
  }
  return args;
}

async function fetchText(url, userAgent) {
  const response = await fetch(url, {
    headers: { "User-Agent": userAgent, Accept: "*/*" },
    signal: AbortSignal.timeout(60_000)
  });
  if (!response.ok) throw new Error(`${url} answered ${response.status} ${response.statusText}`);
  return response.text();
}

async function optional(label, load) {
  try {
    return await load();
  } catch (error) {
    console.warn(`Warning: ${label} unavailable, continuing without it: ${error.message}`);
    return new Map();
  }
}

const MARKETS = {
  india: {
    exchange: "NSE",
    source: "National Stock Exchange of India equity list, with industries from the Nifty Total Market index",
    async build() {
      const industries = await optional("NSE industries",
        async () => parseNseIndustries(await fetchText(NSE_INDUSTRIES, BROWSER_AGENT)));
      return parseNseEquities(await fetchText(NSE_EQUITIES, BROWSER_AGENT), industries);
    }
  },
  us: {
    exchange: "NYSE + Nasdaq",
    source: "Nasdaq Trader symbol directories (Nasdaq and NYSE listings), with CIKs from the SEC",
    async build() {
      const ciks = await optional("SEC CIKs",
        async () => parseSecCiks(await fetchText(SEC_TICKERS, SITE_AGENT)));
      return mergeUsListings(
        parseNasdaqListings(await fetchText(NASDAQ_LISTINGS, BROWSER_AGENT), ciks),
        parseNyseListings(await fetchText(NYSE_LISTINGS, BROWSER_AGENT), ciks));
    }
  }
};

// A file far smaller than the one it replaces means a source sent something
// other than its list, so it is not written over a good one.
const MIN_KEEP_RATIO = 0.8;

async function buildMarket(key, outDir) {
  const market = MARKETS[key];
  const out = `${outDir}/${key}.json`;
  const target = resolve(REPO_ROOT, out);
  const stored = await readFile(target, "utf8").catch(() => null);

  const companies = await market.build();
  if (companies.length === 0) throw new Error(`${market.exchange} returned no companies`);

  const previous = stored ? JSON.parse(stored).count || 0 : 0;
  if (previous && companies.length < previous * MIN_KEEP_RATIO) {
    throw new Error(`${market.exchange} returned ${companies.length} companies, down from ${previous}; keeping the old file`);
  }

  const text = serialiseMarket({
    market: key,
    exchange: market.exchange,
    source: market.source,
    updated: new Date().toISOString().slice(0, 10),
    companies
  });

  // Left alone rather than restamped, so a week with no listing changes
  // produces no commit.
  if (stored && sameCompanies(stored, text)) {
    console.log(`No change: ${out} already lists the same ${companies.length} companies.`);
    return;
  }

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text, "utf8");
  console.log(`Wrote ${out}: ${companies.length} ${market.exchange} companies.`);
}

async function main() {
  const { only, outDir } = readArgs(process.argv.slice(2));
  const keys = only ? [only] : Object.keys(MARKETS);
  for (const key of keys) if (!MARKETS[key]) throw new Error(`unknown market: ${key}`);

  let failed = false;
  for (const key of keys) {
    try {
      await buildMarket(key, outDir);
    } catch (error) {
      failed = true;
      console.error(`Could not build the ${key} listings: ${error.message}`);
    }
  }
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  console.error(`Could not build the market listings: ${error.message}`);
  process.exitCode = 1;
});

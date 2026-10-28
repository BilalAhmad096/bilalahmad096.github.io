// Builds data/markets/india.json and data/markets/us.json, the companies the
// Market Explorer on /tools/ searches.
//
// GitHub Pages serves a static tree, so the lists are fetched here, in a weekly
// GitHub Action, and committed as files every visitor reads the same copy of.
//
//   node scripts/build-market-listings.mjs [--only india|us] [--out-dir <dir>]
//
// Every source is public and needs no credential. Each market is built on its
// own: if one exchange's file cannot be read, the other is still refreshed and
// the stale one is left as it was, and the run fails so the miss is seen. The
// industry, Shariah and CIK joins only enrich a market, so losing one still
// writes the file, with each company keeping last week's values for it, and
// fails the run.
//
// India's Shariah status comes from NSE's Nifty 500 Shariah index: a company
// in it passed screening by TASIS; one in the Nifty 500 but not in it did not;
// any other company is outside the screened universe.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SHARIAH_SOURCE,
  carryOver,
  checkShariahLists,
  parseIndexMembers,
  parseNseEquities,
  parseNseIndustries,
  parseNyseListings,
  parseSecCiks,
  sameCompanies,
  serialiseMarket
} from "./lib/market-listings.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const NSE_EQUITIES = "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv";
const NSE_INDUSTRIES = "https://nsearchives.nseindia.com/content/indices/ind_niftytotalmarket_list.csv";
// NSE serves its index constituent files from two hosts and has renamed them
// before, so each list is tried at every known address in turn.
const INDEX_HOSTS = [
  "https://nsearchives.nseindia.com/content/indices",
  "https://www.niftyindices.com/IndexConstituent"
];
const NIFTY_500_FILES = ["ind_nifty500list.csv"];
const NIFTY_500_SHARIAH_FILES = [
  "ind_nifty500shariah_list.csv",
  "ind_nifty500shariahlist.csv",
  "ind_nifty500_shariah_list.csv",
  "ind_nifty500Shariah_list.csv"
];
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

async function fetchFirst(files) {
  const misses = [];
  for (const file of files) {
    for (const host of INDEX_HOSTS) {
      const url = `${host}/${file}`;
      try {
        const text = await fetchText(url, BROWSER_AGENT);
        // A missing file can come back as an HTML error page with a 200.
        if (/^\s*</.test(text)) throw new Error("answered with a web page, not a CSV");
        console.log(`Read ${url}`);
        return text;
      } catch (error) {
        misses.push(error.message);
      }
    }
  }
  throw new Error(`no address answered: ${misses.join("; ")}`);
}

// An enriching source that fails returns null, and the caller keeps last
// week's values for the fields it fills.
async function optional(label, load) {
  try {
    return await load();
  } catch (error) {
    console.warn(`Warning: ${label} unavailable; keeping the previous values: ${error.message}`);
    // The file is still written, but the run fails so a stale join is seen.
    process.exitCode = 1;
    return null;
  }
}

const MARKETS = {
  india: {
    exchange: "NSE",
    source: "National Stock Exchange of India equity list, with industries from the Nifty Total Market index",
    async build(stored) {
      const industries = await optional("NSE industries",
        async () => parseNseIndustries(await fetchText(NSE_INDUSTRIES, BROWSER_AGENT)));
      const shariah = await optional("Nifty 500 Shariah lists", async () => {
        const universe = parseIndexMembers(await fetchFirst(NIFTY_500_FILES));
        const compliant = parseIndexMembers(await fetchFirst(NIFTY_500_SHARIAH_FILES));
        checkShariahLists(universe, compliant);
        console.log(`Nifty 500 Shariah: ${compliant.symbols.size} of ${universe.symbols.size} Nifty 500 companies.`);
        return { universe, compliant };
      });

      let companies = parseNseEquities(await fetchText(NSE_EQUITIES, BROWSER_AGENT), industries || new Map(), shariah);
      const keep = [...(industries ? [] : ["ind"]), ...(shariah ? [] : ["sh"])];
      if (keep.length) companies = carryOver(companies, stored?.companies, keep);

      const screened = shariah || stored?.shariah;
      return { companies, ...(screened ? { shariah: SHARIAH_SOURCE } : {}) };
    }
  },
  us: {
    exchange: "NYSE",
    source: "Nasdaq Trader symbol directory (NYSE listings), with CIKs from the SEC",
    async build(stored) {
      const ciks = await optional("SEC CIKs",
        async () => parseSecCiks(await fetchText(SEC_TICKERS, SITE_AGENT)));
      let companies = parseNyseListings(await fetchText(NYSE_LISTINGS, BROWSER_AGENT), ciks || new Map());
      if (!ciks) companies = carryOver(companies, stored?.companies, ["cik"]);
      return { companies };
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
  const storedData = stored ? JSON.parse(stored) : null;

  const { companies, ...extra } = await market.build(storedData);
  if (companies.length === 0) throw new Error(`${market.exchange} returned no companies`);

  const previous = storedData?.count || 0;
  if (previous && companies.length < previous * MIN_KEEP_RATIO) {
    throw new Error(`${market.exchange} returned ${companies.length} companies, down from ${previous}; keeping the old file`);
  }

  const text = serialiseMarket({
    market: key,
    exchange: market.exchange,
    source: market.source,
    updated: new Date().toISOString().slice(0, 10),
    ...extra,
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

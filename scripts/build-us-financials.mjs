// Builds data/markets/us-financials.json: the latest balance sheet and annual
// results, from SEC filings, of every company in data/markets/us.json.
//
//   node scripts/build-us-financials.mjs [--out <path>]
//
// The SEC's data is public and needs no key; it asks every caller to name
// itself in the user agent and to stay under ten requests a second. Requests
// here go one at a time with a pause between, well under that.
//
// A frame the SEC does not have (a tag nobody used that quarter) answers 404
// and is simply empty. Anything else that fails leaves the old file in place
// and fails the run.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assembleFinancials,
  frameKey,
  frameUrl,
  framesToFetch,
  readFrame,
  sameFinancials,
  serialiseFinancials
} from "./lib/us-financials.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LISTINGS = "data/markets/us.json";
const DEFAULT_OUT = "data/markets/us-financials.json";
const SITE_AGENT = "mintorian.com market-data build (https://mintorian.com)";
const PAUSE_MS = 150;

// A build that finds far fewer companies than the last one is a broken
// download, not a market that stopped filing.
const MIN_COMPANIES = 1000;
const MIN_KEEP_RATIO = 0.8;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function readArgs(argv) {
  const args = { out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === "--out") args.out = argv[++i];
  return args;
}

async function fetchFrame(url) {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(url, {
      headers: { "User-Agent": SITE_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(120_000)
    });
    if (response.status === 404) return null;
    if (response.ok) return response.json();
    // The SEC answers 429 or 503 when busy; wait and try again a few times.
    if ((response.status === 429 || response.status >= 500) && attempt < 4) {
      await sleep(2000 * attempt);
      continue;
    }
    throw new Error(`${url} answered ${response.status} ${response.statusText}`);
  }
}

async function main() {
  const { out } = readArgs(process.argv.slice(2));
  const target = resolve(REPO_ROOT, out);
  const listings = JSON.parse(await readFile(resolve(REPO_ROOT, LISTINGS), "utf8"));
  const ciks = new Set(listings.companies.map(c => c.cik).filter(Boolean));
  const today = new Date().toISOString().slice(0, 10);

  const wanted = framesToFetch(today);
  const frames = new Map();
  let found = 0;
  for (const { tag, unit, period } of wanted) {
    const json = await fetchFrame(frameUrl(tag, unit, period));
    if (json) {
      const frame = readFrame(json, ciks);
      frames.set(frameKey(tag, unit, period), frame);
      found += 1;
    }
    await sleep(PAUSE_MS);
  }
  console.log(`Read ${found} of ${wanted.length} frames for ${ciks.size} listed companies.`);

  const companies = assembleFinancials(ciks, frames, today);
  const count = Object.keys(companies).length;
  const stored = await readFile(target, "utf8").catch(() => null);
  const previous = stored ? JSON.parse(stored).count || 0 : 0;
  if (count < MIN_COMPANIES || (previous && count < previous * MIN_KEEP_RATIO)) {
    throw new Error(`only ${count} companies have figures (last build had ${previous}); keeping the old file`);
  }

  const text = serialiseFinancials({ updated: today, companies });
  if (stored && sameFinancials(stored, text)) {
    console.log(`No change: ${out} already holds the same figures for ${count} companies.`);
    return;
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text, "utf8");
  const withBalance = Object.values(companies).filter(c => c.bs).length;
  const withAnnual = Object.values(companies).filter(c => c.fy).length;
  console.log(`Wrote ${out}: ${count} companies (${withBalance} with a balance sheet, ${withAnnual} with annual results).`);
}

main().catch(error => {
  console.error(`Could not build the US financials: ${error.message}`);
  process.exitCode = 1;
});

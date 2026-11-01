// Builds data/markets/us-industries.json: each listed US company's industry
// code (SIC) from the SEC, for the Shariah business screen.
//
//   node scripts/build-us-industries.mjs [--refresh <n>]
//
// One request per company, one at a time with a pause between, under the
// SEC's ten a second. The first run asks for every company (about fifteen
// minutes); later runs ask for new ones and re-check a few hundred.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ciksToFetch,
  mergeIndustries,
  readSubmission,
  serialiseIndustries,
  submissionsUrl
} from "./lib/us-industries.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LISTINGS = "data/markets/us.json";
const OUT = "data/markets/us-industries.json";
const SITE_AGENT = "mintorian.com market-data build (https://mintorian.com)";
const PAUSE_MS = 130;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function readArgs(argv) {
  const args = { refresh: 300 };
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === "--refresh") args.refresh = Number(argv[++i]);
  return args;
}

async function fetchSubmission(cik) {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(submissionsUrl(cik), {
      headers: { "User-Agent": SITE_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(60_000)
    });
    if (response.status === 404) return null;
    if (response.ok) return readSubmission(await response.json());
    if ((response.status === 429 || response.status >= 500) && attempt < 4) {
      await sleep(2000 * attempt);
      continue;
    }
    throw new Error(`CIK ${cik} answered ${response.status} ${response.statusText}`);
  }
}

async function main() {
  const { refresh } = readArgs(process.argv.slice(2));
  const listings = JSON.parse(await readFile(resolve(REPO_ROOT, LISTINGS), "utf8"));
  const ciks = [...new Set(listings.companies.map(c => c.cik).filter(Boolean))];
  const target = resolve(REPO_ROOT, OUT);
  const stored = await readFile(target, "utf8").then(JSON.parse).catch(() => null);
  const cache = stored?.companies || {};
  const today = new Date().toISOString().slice(0, 10);

  const wanted = ciksToFetch(ciks, cache, { refresh });
  const fetched = new Map();
  let failures = 0;
  for (const cik of wanted) {
    try {
      fetched.set(cik, await fetchSubmission(cik));
    } catch (error) {
      failures += 1;
      console.warn(`Warning: ${error.message}`);
      // Many failures in a row means the SEC is refusing us; stop and keep
      // what this run has, rather than hammering it.
      if (failures >= 25) {
        console.warn("Stopping early after repeated failures.");
        break;
      }
    }
    await sleep(PAUSE_MS);
  }

  const companies = mergeIndustries(ciks, cache, fetched, today);
  const withCode = Object.values(companies).filter(c => c.sic).length;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, serialiseIndustries({ updated: today, companies }), "utf8");
  console.log(`Wrote ${OUT}: ${withCode} of ${ciks.length} companies have an industry code (${fetched.size} fetched this run, ${failures} failed).`);
  if (failures >= 25) process.exitCode = 1;
}

main().catch(error => {
  console.error(`Could not build the US industries: ${error.message}`);
  process.exitCode = 1;
});

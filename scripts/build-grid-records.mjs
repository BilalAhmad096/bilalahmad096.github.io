// Keeps data/grid-records.json, the lowest and highest carbon intensity the
// "GB Grid, Right Now" panel reports as recorded on this site.
//
// GitHub Pages serves a static tree with nothing to accumulate state in, so the
// record is folded here, in a scheduled GitHub Action, and committed as a file
// every visitor then reads the same copy of.
//
//   node scripts/build-grid-records.mjs [--out <path>] [--since <YYYY-MM-DD>]
//
// The feed is public and needs no credential. Each run re-reads today and
// yesterday, because a half hour settles after it ends, and backfills any day a
// missed run left uncovered.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  datesToFetch,
  londonDate,
  mergeRecords,
  readingsFrom,
  sameRecord,
  serialise
} from "./lib/grid-records.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API_DATE = "https://api.carbonintensity.org.uk/intensity/date";
const DEFAULT_OUT = "data/grid-records.json";
const USER_AGENT = "mintorian.com-grid-records-build";

function readArgs(argv) {
  const args = { out: DEFAULT_OUT, since: process.env.GRID_RECORDS_SINCE || null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--since") args.since = argv[++i];
  }
  return args;
}

async function fetchDay(date) {
  const response = await fetch(`${API_DATE}/${date}`, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT }
  });

  if (!response.ok) {
    throw new Error(`${date} request failed with ${response.status} ${response.statusText}`);
  }

  return readingsFrom(await response.json());
}

async function main() {
  const { out, since } = readArgs(process.argv.slice(2));
  const target = resolve(REPO_ROOT, out);

  const stored = await readFile(target, "utf8")
    .then(text => JSON.parse(text))
    .catch(() => null);

  const today = londonDate();
  const days = datesToFetch(stored, today);

  const readings = [];
  for (const day of days) {
    // Serially, not in parallel: this is a free public feed and one run is
    // never in a hurry.
    readings.push(...await fetchDay(day));
  }

  const records = mergeRecords(stored, readings, { since: since || today });

  // Left alone rather than restamped, so the scheduled run only produces a
  // commit on a day the record actually moved.
  if (sameRecord(stored, records)) {
    console.log(`No change: ${out} already holds the record through ${records.through}.`);
    return;
  }

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, serialise(records), "utf8");
  console.log(
    `Wrote ${out} from ${days.length} day(s) of readings: lowest ${records.lowest.value} at ` +
    `${records.lowest.at}, highest ${records.highest.value} at ${records.highest.at}, ` +
    `recorded since ${records.since} through ${records.through}.`
  );
}

main().catch(error => {
  console.error(`Could not build the grid records file: ${error.message}`);
  process.exitCode = 1;
});

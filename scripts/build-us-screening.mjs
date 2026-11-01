// Builds data/markets/us-screening.json: each listed US company's industry and
// Shariah status, which the Market Explorer reads to label search results.
//
//   node scripts/build-us-screening.mjs
//
// No network: it runs js/lib/shariah-screen.js, the same screen the page shows
// the working of, over data/markets/us-financials.json and us-industries.json.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { METHOD, STATUS_CODE, screenCompany } from "../js/lib/shariah-screen.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = path => readFile(resolve(REPO_ROOT, path), "utf8").then(JSON.parse);

export function buildScreening(listings, financials, industries) {
  const companies = {};
  const counts = {};
  const ciks = [...new Set(listings.companies.map(c => c.cik).filter(Boolean))].sort((a, b) => a - b);
  for (const cik of ciks) {
    const industry = industries.companies?.[cik] || {};
    const result = screenCompany(financials.companies?.[cik], industry.sic);
    const row = { s: STATUS_CODE[result.status] };
    if (industry.sic) row.sic = industry.sic;
    if (industry.d) row.d = industry.d;
    companies[cik] = row;
    counts[result.status] = (counts[result.status] || 0) + 1;
  }
  return { companies, counts };
}

async function main() {
  const [listings, financials, industries] = await Promise.all([
    read("data/markets/us.json"),
    read("data/markets/us-financials.json"),
    read("data/markets/us-industries.json").catch(() => ({ companies: {} }))
  ]);
  const { companies, counts } = buildScreening(listings, financials, industries);
  // Dated by its inputs, not by today, so an unchanged week rewrites nothing.
  const updated = [financials.updated, industries.updated].filter(Boolean).sort().at(-1);
  const text = JSON.stringify({ method: METHOD, updated, count: Object.keys(companies).length, companies }) + "\n";
  await writeFile(resolve(REPO_ROOT, "data/markets/us-screening.json"), text, "utf8");
  console.log(`Wrote data/markets/us-screening.json: ${JSON.stringify(counts)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    console.error(`Could not build the US screening: ${error.message}`);
    process.exitCode = 1;
  });
}

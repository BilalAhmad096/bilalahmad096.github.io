// The pure half of the US industries build: each listed company's industry
// code (SIC) from its SEC submissions record, which the Shariah business
// screen reads. No fetch and no filesystem.
//
//   https://data.sec.gov/submissions/CIK##########.json  ->  sic, sicDescription
//
// One request per company, so the file is kept as a cache: each run fetches
// companies it has never seen, then re-checks the ones checked longest ago, a
// few hundred at a time. A company's industry code rarely changes.

export function submissionsUrl(cik) {
  return `https://data.sec.gov/submissions/CIK${String(cik).padStart(10, "0")}.json`;
}

// A submissions record -> { sic, d } or null when it carries no code.
export function readSubmission(json) {
  const sic = String(json?.sic || "").trim();
  if (!/^\d{3,4}$/.test(sic)) return null;
  return { sic: sic.padStart(4, "0"), d: String(json.sicDescription || "").trim() };
}

// Which CIKs to fetch this run: every one missing from the cache, then the
// oldest-checked, up to refresh more. Companies no longer listed are dropped.
export function ciksToFetch(ciks, cache, { refresh = 300 } = {}) {
  const missing = [];
  const known = [];
  for (const cik of ciks) {
    const entry = cache[cik];
    if (entry) known.push([cik, entry.c || ""]);
    else missing.push(cik);
  }
  known.sort((a, b) => a[1].localeCompare(b[1]) || a[0] - b[0]);
  return [...missing.sort((a, b) => a - b), ...known.slice(0, refresh).map(([cik]) => cik)];
}

// The cache kept to listed companies, with this run's answers merged in. An
// answer of null (no code on file) is still recorded, so it is not asked for
// again every week.
export function mergeIndustries(ciks, cache, fetched, today) {
  const out = {};
  for (const cik of [...ciks].sort((a, b) => a - b)) {
    if (fetched.has(cik)) {
      const hit = fetched.get(cik);
      out[cik] = hit ? { ...hit, c: today } : { c: today };
    } else if (cache[cik]) {
      out[cik] = cache[cik];
    }
  }
  return out;
}

export function serialiseIndustries({ updated, companies }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(updated)) throw new Error(`bad updated date: ${updated}`);
  return JSON.stringify({
    source: "SEC EDGAR submissions (data.sec.gov): Standard Industrial Classification codes",
    updated,
    count: Object.keys(companies).length,
    companies
  }) + "\n";
}

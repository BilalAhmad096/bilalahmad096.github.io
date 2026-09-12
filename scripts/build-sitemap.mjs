// Rebuilds sitemap.xml from the pages that actually exist.
//
//   node scripts/build-sitemap.mjs [--check]
//
// Every index.html that is not marked noindex is listed, and each lastmod is
// the date git last committed that file, so the dates cannot drift from the
// history the way hand-edited ones did. A page with uncommitted changes is
// dated today, since that is when it is about to change.
//
// --check writes nothing and exits non-zero if sitemap.xml is out of date.

import { execFileSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SKIPPED_DIRS, isIndexable, renderSitemap, urlPathFor } from "./lib/sitemap.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(REPO_ROOT, "sitemap.xml");

async function findIndexPages(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (dir === REPO_ROOT && SKIPPED_DIRS.has(entry.name)) continue;
      found.push(...await findIndexPages(full));
    } else if (entry.name === "index.html") {
      found.push(relative(REPO_ROOT, full).split("\\").join("/"));
    }
  }
  return found;
}

function git(...args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function lastModified(file) {
  if (git("status", "--porcelain", "--", file)) return today();
  return git("log", "-1", "--format=%cs", "--", file) || today();
}

const check = process.argv.includes("--check");
const entries = [];
for (const file of await findIndexPages(REPO_ROOT)) {
  if (!isIndexable(await readFile(join(REPO_ROOT, file), "utf8"))) continue;
  entries.push({ path: urlPathFor(file), lastmod: lastModified(file) });
}

const xml = renderSitemap(entries);
const current = await readFile(OUT, "utf8").catch(() => "");

if (check) {
  if (current.replace(/\r\n/g, "\n") !== xml) {
    console.error("sitemap.xml is out of date; run: node scripts/build-sitemap.mjs");
    process.exit(1);
  }
  console.log(`sitemap.xml is current (${entries.length} pages)`);
} else {
  await writeFile(OUT, xml);
  for (const { path, lastmod } of entries) console.log(`${lastmod}  ${path}`);
}

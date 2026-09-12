// The pure half of the sitemap build: which pages belong in it, what URL each
// is served at, and how the file is written. Kept free of git and the
// filesystem so the rules can be tested directly.

export const SITE_ORIGIN = "https://mintorian.com";

// Directories that are not part of the published site, or that only hold
// redirect stubs for URLs the site has retired.
export const SKIPPED_DIRS = new Set([
  "node_modules", "worker", "scripts", "tests", "data", "css", "js",
  "image", "img", "fonts", "footer", "Files", "Website Image", "pages", "coverage"
]);

// A page opts out of the sitemap the same way it opts out of search: with a
// robots noindex. That covers every redirect stub without listing them.
export function isIndexable(html) {
  return !/<meta\s+name=["']robots["']\s+content=["'][^"']*noindex/i.test(html);
}

// "index.html" -> "/", "research/index.html" -> "/research/"
export function urlPathFor(relativeFile) {
  const parts = relativeFile.split(/[\\/]/);
  if (parts.at(-1) !== "index.html") throw new Error(`not an index page: ${relativeFile}`);
  const dir = parts.slice(0, -1).join("/");
  return dir ? `/${dir}/` : "/";
}

// Home first, then alphabetical, so the file only changes when a page or a
// date does.
export function sortEntries(entries) {
  return [...entries].sort((a, b) =>
    a.path === "/" ? -1 : b.path === "/" ? 1 : a.path.localeCompare(b.path));
}

export function renderSitemap(entries, origin = SITE_ORIGIN) {
  const rows = sortEntries(entries).map(({ path, lastmod }) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(lastmod)) throw new Error(`bad lastmod for ${path}: ${lastmod}`);
    return `  <url>\n    <loc>${origin}${path}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`;
  });
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + rows.join("\n") + "\n</urlset>\n";
}

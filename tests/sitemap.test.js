// tests/sitemap.test.js
//
// The sitemap is built by scripts/build-sitemap.mjs. These check the rules it
// builds from, and that the committed sitemap.xml lists exactly the pages a
// search engine should index: a page added without rebuilding it, or a
// redirect stub that leaks into it, fails here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { isIndexable, renderSitemap, sortEntries, urlPathFor } from '../scripts/lib/sitemap.mjs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('index files map to the directory URL they are served at', () => {
  assert.equal(urlPathFor('index.html'), '/');
  assert.equal(urlPathFor('research/index.html'), '/research/');
  assert.equal(urlPathFor('research\\index.html'), '/research/');
  assert.throws(() => urlPathFor('404.html'));
});

test('a robots noindex keeps a page out, and nothing else does', () => {
  assert.equal(isIndexable('<meta name="robots" content="noindex" />'), false);
  assert.equal(isIndexable('<meta name="robots" content="noindex, follow">'), false);
  assert.equal(isIndexable('<meta name="description" content="noindex is mentioned here">'), true);
  assert.equal(isIndexable('<title>Research</title>'), true);
});

test('home sorts first and the rest alphabetically', () => {
  const order = sortEntries([{ path: '/updates/' }, { path: '/' }, { path: '/experience/' }]).map(e => e.path);
  assert.deepEqual(order, ['/', '/experience/', '/updates/']);
});

test('a malformed lastmod is refused rather than written', () => {
  assert.throws(() => renderSitemap([{ path: '/', lastmod: '12/09/2026' }]));
});

test('sitemap.xml lists exactly the indexable pages, and each one exists', () => {
  const listed = [...read('sitemap.xml').matchAll(/<loc>https:\/\/mintorian\.com(\/[^<]*)<\/loc>/g)].map(m => m[1]);
  for (const path of listed) {
    const file = path === '/' ? 'index.html' : `${path.slice(1)}index.html`;
    assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), `${path} is in the sitemap but ${file} does not exist`);
    assert.ok(isIndexable(read(file)), `${path} is in the sitemap but marked noindex`);
  }
  for (const retired of ['/contingency/', '/researchgroup/']) {
    assert.ok(!listed.includes(retired), `${retired} redirects away and must not be listed`);
  }
  for (const page of ['/', '/experience/', '/publications/', '/research/', '/updates/']) {
    assert.ok(listed.includes(page), `${page} is missing from the sitemap`);
  }
});

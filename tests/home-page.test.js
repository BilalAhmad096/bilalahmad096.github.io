// tests/home-page.test.js
//
// The home page's Interactive Research section: where it sits, what it links
// to, and that every link lands on a project that actually exists.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const home = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const research = readFileSync(new URL('../research/index.html', import.meta.url), 'utf8');

const sections = [...home.matchAll(/<section id="([^"]+)"/g)].map(m => m[1]);
const projects = home.slice(home.indexOf('<section id="projects"'), home.indexOf('</section>', home.indexOf('<section id="projects"')));
const cards = [...projects.matchAll(/<a class="project-card" href="([^"]+)"[\s\S]*?<\/a>/g)];
const text = s => s.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();

test('Interactive Research sits directly below GB Grid, Right Now', () => {
  const i = sections.indexOf('grid');
  assert.ok(i >= 0, 'grid section missing');
  assert.equal(sections[i + 1], 'projects');
  assert.match(projects, /<h2 class="section-title"[^>]*>Interactive Research<\/h2>/);
});

test('the old single-project card has gone from the grid section', () => {
  assert.doesNotMatch(home, /demo-card/);
  assert.doesNotMatch(home, /id="demo"/);
});

test('three cards link, in order, to projects that exist on the research page', () => {
  const hrefs = cards.map(m => m[1]);
  assert.deepEqual(hrefs, ['/research/#resilient-investment', '/research/#contingency', '/research/#storage']);
  for (const href of hrefs) {
    const id = href.split('#')[1];
    assert.match(research, new RegExp(`<article class="project" id="${id}"`), `${id} is not on the research page`);
  }
});

test('each card is numbered and titled as its project is on the research page', () => {
  const researchTitles = [...research.matchAll(/<h2 class="project__title">([^<]+)<\/h2>/g)].map(m => m[1].trim());
  cards.forEach((m, i) => {
    const html = m[0];
    const num = String(i + 1).padStart(2, '0');
    assert.match(html, new RegExp(`project-card__num" aria-hidden="true">${num}<`));
    const title = html.match(/<h3 class="project-card__title" id="([^"]+)">([^<]+)<\/h3>/);
    assert.ok(title, `card ${num} has no title`);
    assert.equal(title[2], researchTitles[i], `card ${num} title differs from the research page`);
    // The whole card is the link, so its accessible name is the title alone.
    assert.match(html, new RegExp(`aria-labelledby="${title[1]}"`));
    assert.match(html, /<svg class="project-card__art"[^>]*aria-hidden="true"/);
  });
});

test('the home page carries no em dashes', () => {
  assert.doesNotMatch(home, /—|&mdash;|&#8212;/);
  assert.doesNotMatch(text(projects), /—/);
});

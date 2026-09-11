// tests/research-page.test.js
//
// The research page's own markup. notes.css promotes the bold lead-in of every
// notes bullet onto a line of its own, and the lead-in of any paragraph marked
// .term. That only reads correctly when the promoted text is a whole sentence -
// otherwise the next line starts with a comma - and it has gone wrong twice by
// eye, so it is checked here instead.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const html = readFileSync(new URL('../research/index.html', import.meta.url), 'utf8');

const notesBlocks = [...html.matchAll(/<div class="(?:rx|cx|bx)-notes">([\s\S]*?)<\/div>/g)].map(m => m[1]);
const text = s => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

test('every project has a notes block', () => {
  assert.equal(notesBlocks.length, 3);
});

test('every promoted lead-in is a complete sentence', () => {
  const promoted = [];
  for (const block of notesBlocks) {
    for (const [, li] of block.matchAll(/<li>\s*(<strong>[\s\S]*?<\/strong>)([\s\S]*?)<\/li>/g)) promoted.push(li);
    for (const [, term] of block.matchAll(/<strong class="term">([\s\S]*?)<\/strong>/g)) promoted.push(term);
  }
  assert.ok(promoted.length >= 15, `only ${promoted.length} lead-ins found`);
  for (const lead of promoted) {
    const t = text(lead);
    assert.match(t, /[.?!]$/, `lead-in is not a complete sentence: "${t}"`);
  }
});

test('the three projects run 01, 02, 03 and keep their anchors', () => {
  const ids = [...html.matchAll(/<article class="project" id="([^"]+)"/g)].map(m => m[1]);
  const nums = [...html.matchAll(/project__num" aria-hidden="true">(\d+)</g)].map(m => m[1]);
  assert.deepEqual(ids, ['resilient-investment', 'contingency', 'storage']);
  assert.deepEqual(nums, ['01', '02', '03']);
});

test('the page names no client or collaborator', () => {
  assert.doesNotMatch(text(html), /\bEY\b|Ernst|Yasir/);
});

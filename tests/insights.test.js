import test from "node:test";
import assert from "node:assert/strict";
import {
  RETENTION_DAYS,
  buildDigest,
  purgeExpired,
  recordTurn,
  renderDigest
} from "../worker/src/insights.js";

// Minimal D1 shim: records the SQL and bindings it was handed, and returns queued rows in
// the order the code asks for them.
function stubDatabase(responses = []) {
  const calls = [];
  const queue = [...responses];
  return {
    calls,
    prepare(sql) {
      const call = { sql, bindings: [] };
      calls.push(call);
      const statement = {
        bind(...bindings) {
          call.bindings = bindings;
          return statement;
        },
        async all() {
          return { results: queue.length ? queue.shift() : [] };
        },
        async run() {
          return { meta: { changes: queue.length ? queue.shift() : 0 } };
        }
      };
      return statement;
    }
  };
}

const turn = {
  question: "  Who supervises   his PhD?  ",
  matchType: "none",
  resultCount: 0,
  grounded: false,
  tools: ["search_knowledge_base"],
  toolQueries: ["phd supervisor"],
  recordIds: []
};

test("a captured turn holds the question and retrieval outcome, and no visitor identity", async () => {
  const database = stubDatabase();
  assert.equal(await recordTurn({ INSIGHTS_DB: database }, turn), true);

  const [call] = database.calls;
  assert.match(call.sql, /INSERT INTO retrieval_log/);
  for (const forbidden of [/\bip\b/i, /session/i, /answer/i, /response_text/i]) {
    assert.equal(forbidden.test(call.sql), false, `column matching ${forbidden} must not be stored`);
  }

  const [, createdAt, question, questionKey, toolQueries, matchType, resultCount, grounded] = call.bindings;
  assert.equal(question, "Who supervises his PhD?");
  assert.equal(questionKey, "who supervises his phd");
  assert.equal(JSON.parse(toolQueries)[0], "phd supervisor");
  assert.equal(matchType, "none");
  assert.equal(resultCount, 0);
  assert.equal(grounded, 0);
  assert.ok(Number.isFinite(createdAt));
});

test("capture never throws when the database is missing or failing", async () => {
  assert.equal(await recordTurn({}, turn), false);

  const broken = {
    prepare() {
      throw new Error("d1_unavailable");
    }
  };
  assert.equal(await recordTurn({ INSIGHTS_DB: broken }, turn), false);
});

test("purging uses the agreed retention window", async () => {
  const database = stubDatabase([7]);
  const now = 1_800_000_000_000;
  assert.equal(await purgeExpired({ INSIGHTS_DB: database }, now), 7);

  const [call] = database.calls;
  assert.match(call.sql, /DELETE FROM retrieval_log/);
  assert.equal(call.bindings[0], now - RETENTION_DAYS * 86400000);
  assert.equal(RETENTION_DAYS, 90);
});

test("the digest counts best matches, keeps search scope, and finds records never reached", async () => {
  const database = stubDatabase([
    [{ turns: 12, grounded: 10, unanswered: 2, orientation: 1, contact: 2 }],
    [
      { question_key: "please i insist", asked: 1, example: "Please i insist", searched_for: '["approved personal detail"]', searched_in: '[["EXTRACURRICULAR"]]' },
      { question_key: "who supervises his phd", asked: 1, example: "Who supervises his PhD?", searched_for: '["phd supervisor"]', searched_in: '[[]]' },
      { question_key: "old row", asked: 1, example: "Old row", searched_for: '["x"]', searched_in: "[]" }
    ],
    [{ question_key: "what does he do", asked: 1, example: "What does he do?", searched_for: '[""]', searched_in: '[["PROFILE"],["CONTACT"]]' }],
    [{ record_id: "profile-summary", served: 8 }],
    [{ record_id: "profile-summary" }, { record_id: "research-core" }]
  ]);

  const summary = await buildDigest({ INSIGHTS_DB: database }, 1_800_000_000_000);

  assert.equal(summary.turns, 12);
  assert.equal(summary.contactTurns, 2);

  // Scope reads as a filter, as every category, or as unknown for rows logged before it.
  assert.deepEqual(summary.unanswered[0].searchedIn, ["EXTRACURRICULAR"]);
  assert.deepEqual(summary.unanswered[1].searchedIn, []);
  assert.equal(summary.unanswered[2].searchedIn, null);
  assert.deepEqual(summary.orientation[0].searchedIn, ["PROFILE", "CONTACT"]);
  assert.deepEqual(summary.unanswered[0].searchedFor, ["approved personal detail"]);

  // Top answers count only the first record of each turn.
  const topQuery = database.calls[3].sql;
  assert.match(topQuery, /json_extract\(record_ids, '\$\[0\]'\)/);
  assert.equal(summary.topAnswers[0].record_id, "profile-summary");

  // Never served means never retrieved in any position, not merely never ranked first.
  // It must not share the top list's row cap: an earlier version did, and reported eleven
  // retrieved records as never served because they ranked below the twenty-fifth row.
  assert.equal(/LIMIT/i.test(database.calls[4].sql), false);
  assert.equal(summary.neverServed.includes("research-core"), false);
  assert.ok(summary.neverServed.includes("publication-i2ct-2019"));

  assert.equal(database.calls[0].bindings[0], 1_800_000_000_000 - 7 * 86400000);
});

function summaryFixture(overrides = {}) {
  return {
    windowDays: 7,
    windowStart: "2026-09-06T08:00:00.000Z",
    generatedAt: "2026-09-13T08:00:00.000Z",
    turns: 12,
    grounded: 9,
    unansweredTurns: 3,
    orientationTurns: 2,
    contactTurns: 2,
    unanswered: [{ asked: 3, example: "Who supervises his PhD? <script>alert(1)</script>", searchedFor: ["phd supervisor"], searchedIn: ["PROFESSIONAL_EXPERIENCE"] }],
    orientation: [{ asked: 2, example: "What does he do?", searchedFor: [], searchedIn: [] }],
    topAnswers: [{ record_id: "profile-summary", served: 8 }, { record_id: "research-core", served: 4 }],
    neverServed: ["publication-i2ct-2019"],
    ...overrides
  };
}

test("the digest email has a header, stat tiles and explained gaps, in text and HTML", () => {
  const busy = renderDigest(summaryFixture());

  assert.match(busy.subject, /12 questions, 1 gap$/);
  assert.match(busy.text, /75% were answered from a verified record/);
  assert.match(busy.text, /2 were meeting or collaboration requests/);
  assert.match(busy.text, /UNANSWERED \(3\)/);
  assert.match(busy.text, /Searched for "phd supervisor" in professional experience/);
  assert.match(busy.text, /Searched all categories/);
  assert.match(busy.text, /NEVER SERVED \(1\)/);

  assert.match(busy.html, /^<!doctype html>/);
  assert.match(busy.html, /Weekly knowledge digest/);
  assert.match(busy.html, /6 to 13 September 2026/);
  assert.match(busy.html, />75%</);
  assert.match(busy.html, /Includes 2 meeting or collaboration requests/);
  assert.match(busy.html, /Top answers/);
  assert.match(busy.html, /publication-i2ct-2019/);

  // Visitor questions are untrusted text and must never reach the email as markup.
  assert.equal(busy.html.includes("<script>alert(1)</script>"), false);
  assert.ok(busy.html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));

  // The site replaced every em dash; the digest follows suit.
  assert.equal(/\u2014/.test(busy.html + busy.text), false);

  const clean = renderDigest(summaryFixture({ unanswered: [], unansweredTurns: 0 }));
  assert.match(clean.html, /Every question found a verified record this week/);

  const quiet = renderDigest(summaryFixture({ turns: 0, grounded: 0, contactTurns: 0, unanswered: [], orientation: [], topAnswers: [], neverServed: [] }));
  assert.match(quiet.subject, /quiet week/);
  assert.match(quiet.text, /No questions were asked this week/);
  assert.match(quiet.text, /digest is still running/);
  assert.match(quiet.html, /A quiet week/);
});

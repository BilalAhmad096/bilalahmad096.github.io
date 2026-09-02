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

test("the digest aggregates gaps, served records and records never reached", async () => {
  const database = stubDatabase([
    [{ turns: 12, grounded: 9, unanswered: 3, orientation: 2 }],
    [{ question_key: "who supervises his phd", asked: 3, example: "Who supervises his PhD?" }],
    [{ question_key: "what does he do", asked: 2, example: "What does he do?" }],
    [{ record_id: "profile-summary", served: 8 }, { record_id: "research-core", served: 5 }]
  ]);

  const summary = await buildDigest({ INSIGHTS_DB: database }, 1_800_000_000_000);

  assert.equal(summary.turns, 12);
  assert.equal(summary.grounded, 9);
  assert.equal(summary.unansweredTurns, 3);
  assert.equal(summary.unanswered[0].asked, 3);
  assert.equal(summary.orientation[0].example, "What does he do?");
  assert.equal(summary.served[0].record_id, "profile-summary");

  // Every record that was not served this week should be reported, and nothing that was.
  assert.equal(summary.neverServed.includes("profile-summary"), false);
  assert.equal(summary.neverServed.includes("research-core"), false);
  assert.ok(summary.neverServed.includes("publication-i2ct-2019"));

  // The window is seven days regardless of the ninety-day retention.
  assert.equal(database.calls[0].bindings[0], 1_800_000_000_000 - 7 * 86400000);
});

test("a week with questions reports the gaps, a quiet week still reports in", async () => {
  const busy = renderDigest({
    windowDays: 7,
    turns: 12,
    grounded: 9,
    unansweredTurns: 3,
    orientationTurns: 2,
    unanswered: [{ asked: 3, example: "Who supervises his PhD?" }],
    orientation: [{ asked: 2, example: "What does he do?" }],
    served: [{ record_id: "profile-summary", served: 8 }],
    neverServed: ["publication-i2ct-2019"]
  });

  assert.match(busy.subject, /12 questions, 1 gap$/);   // singular when there is one gap
  assert.match(busy.text, /75% were answered from a verified record/);
  assert.match(busy.text, /UNANSWERED \(3\)/);
  assert.ok(busy.text.includes("Who supervises his PhD?"));
  assert.match(busy.text, /NEVER SERVED \(1\)/);
  assert.ok(busy.html.startsWith("<pre"));

  const quiet = renderDigest({
    windowDays: 7,
    turns: 0,
    grounded: 0,
    unansweredTurns: 0,
    orientationTurns: 0,
    unanswered: [],
    orientation: [],
    served: [],
    neverServed: []
  });

  assert.match(quiet.subject, /quiet week/);
  assert.match(quiet.text, /No questions were asked this week/);
  assert.match(quiet.text, /digest is still running/);
});

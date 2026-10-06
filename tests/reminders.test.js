import test from "node:test";
import assert from "node:assert/strict";
import { renderReminderEmail, runDueReminders } from "../worker/src/reminders.js";
import { insertReminderSql, parseDueAt, sqlString } from "../scripts/lib/reminders.mjs";

test("local times are read as UK time across both sides of the clock change", () => {
  assert.equal(parseDueAt("2026-07-01 09:00"), Date.parse("2026-07-01T08:00:00Z"));
  assert.equal(parseDueAt("2026-12-01 09:00"), Date.parse("2026-12-01T09:00:00Z"));
  assert.equal(parseDueAt("2026-10-25T00:30"), Date.parse("2026-10-24T23:30:00Z"));
  assert.equal(parseDueAt("2026-12-01T09:00:00+05:00"), Date.parse("2026-12-01T04:00:00Z"));
});

test("times that do not exist are refused", () => {
  assert.throws(() => parseDueAt("2027-03-28 01:30"), /clocks-forward/);
  assert.throws(() => parseDueAt("2026-02-30 09:00"), /not a valid/);
  assert.throws(() => parseDueAt("next tuesday"), /Could not read/);
});

test("the insert quotes text and refuses past or empty reminders", () => {
  const now = Date.parse("2026-10-06T12:00:00Z");
  const sql = insertReminderSql({ id: "abc", title: "Bob's  review", notes: "x'); DROP TABLE reminders; --", dueAt: now + 60000, now });
  assert.match(sql, /'Bob''s review'/);
  assert.match(sql, /'x''\); DROP TABLE reminders; --'/);
  assert.throws(() => insertReminderSql({ id: "a", title: "t", dueAt: now - 1, now }), /past/);
  assert.throws(() => insertReminderSql({ id: "a", title: "  ", dueAt: now + 1, now }), /title/);
  assert.equal(sqlString("a\u0000b"), "'ab'");
});

test("the reminder email escapes the title and shows the time in UK time", () => {
  const email = renderReminderEmail({ title: "<b>Call</b>", notes: "line one\nline two", due_at: Date.parse("2026-07-01T08:00:00Z") });
  assert.equal(email.subject, "[Reminder] <b>Call</b>");
  assert.match(email.html, /&lt;b&gt;Call&lt;\/b&gt;/);
  assert.match(email.html, /line one<br>line two/);
  assert.match(email.text, /09:00/);
});

function reminderDatabase(rows, { claimed = true } = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const call = { sql, bindings: [] };
      calls.push(call);
      const statement = {
        bind(...bindings) { call.bindings = bindings; return statement; },
        async all() { return { results: rows }; },
        async run() { return { meta: { changes: claimed ? 1 : 0 } }; }
      };
      return statement;
    }
  };
}

const env = database => ({
  INSIGHTS_DB: database,
  RESEND_API_KEY: "re_test",
  CONTACT_TO_EMAIL: "owner@example.com",
  CONTACT_FROM_EMAIL: "Site <site@example.com>"
});

test("due reminders are claimed, sent once with an idempotency key, and released on failure", async t => {
  const sent = [];
  let ok = true;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    sent.push(init);
    return { ok, status: ok ? 200 : 500, json: async () => ({ id: "x" }) };
  });
  t.mock.method(console, "error", () => {});
  const rows = [{ id: "r1", due_at: 1, title: "One", notes: "" }];

  const database = reminderDatabase(rows);
  assert.deepEqual(await runDueReminders(env(database), 1000), { due: 1, sent: 1, failed: 0 });
  assert.equal(sent[0].headers["Idempotency-Key"], "reminder:r1");
  assert.match(database.calls[1].sql, /SET sent_at = \?.*AND sent_at IS NULL/);

  ok = false;
  const failing = reminderDatabase(rows);
  assert.deepEqual(await runDueReminders(env(failing), 1000), { due: 1, sent: 0, failed: 1 });
  assert.match(failing.calls.at(-1).sql, /SET sent_at = NULL/);

  // Another run already claimed it, so nothing is sent.
  const raced = reminderDatabase(rows, { claimed: false });
  sent.length = 0;
  assert.deepEqual(await runDueReminders(env(raced), 1000), { due: 1, sent: 0, failed: 0 });
  assert.equal(sent.length, 0);
});

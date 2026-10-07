import test from "node:test";
import assert from "node:assert/strict";
import { renderReminderEmail, runDueReminders } from "../worker/src/reminders.js";
import { eventReminders, insertReminderSql, parseDueAt, parseIcs, parseLeadTimes, sqlString } from "../scripts/lib/reminders.mjs";

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

test("a reminder for the wife goes to her secret address, replies reach the owner, and unknown keys are refused", async t => {
  const sent = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ id: "x" }) };
  });
  t.mock.method(console, "error", () => {});
  const rows = [{ id: "w1", due_at: 1, title: "Pick up the parcel", notes: "", recipient: "wife" }];

  const configured = { ...env(reminderDatabase(rows)), REMINDER_TO_WIFE: "wife@example.com" };
  assert.deepEqual(await runDueReminders(configured, 1000), { due: 1, sent: 1, failed: 0 });
  assert.deepEqual(sent[0].to, ["wife@example.com"]);
  assert.equal(sent[0].reply_to, "owner@example.com");
  assert.match(sent[0].html, /Bilal set this reminder for you/);

  // Without her secret nothing is sent, and the claim is released for a later run.
  sent.length = 0;
  const unconfigured = reminderDatabase(rows);
  assert.deepEqual(await runDueReminders(env(unconfigured), 1000), { due: 1, sent: 0, failed: 1 });
  assert.equal(sent.length, 0);
  assert.match(unconfigured.calls.at(-1).sql, /SET sent_at = NULL/);

  // An unrecognised key never falls back to the owner.
  const stray = reminderDatabase([{ ...rows[0], recipient: "someone" }]);
  assert.deepEqual(await runDueReminders(env(stray), 1000), { due: 1, sent: 0, failed: 1 });
  assert.equal(sent.length, 0);

  const now = Date.parse("2026-10-06T12:00:00Z");
  assert.match(insertReminderSql({ id: "a", title: "t", dueAt: now + 1, recipient: "wife", now }), /'wife'\)$/);
  assert.throws(() => insertReminderSql({ id: "a", title: "t", dueAt: now + 1, recipient: "x@example.com", now }), /--for must be one of: me, wife/);
});

test("calendar sessions become one reminder per lead time, in UK time, with stable ids", () => {
  const ics = [
    "BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:s-1", "DTSTART:20261201T121500", "DTEND:20261201T140500",
    "SUMMARY:Lab\\, MATLAB", "END:VEVENT",
    "BEGIN:VEVENT", "UID:s-2", "DTSTART;TZID=Europe/London:20270705T091500", "SUMMARY:Summer lab", "END:VEVENT",
    "BEGIN:VEVENT", "UID:s-0", "DTSTART:20260101T090000Z", "SUMMARY:Past", "END:VEVENT", "END:VCALENDAR"
  ].join("\r\n");
  const events = parseIcs(ics);
  assert.deepEqual(events.map(event => event.summary), ["Past", "Lab, MATLAB", "Summer lab"]);
  assert.equal(events[2].start, Date.parse("2027-07-05T08:15:00Z"));

  const now = Date.parse("2026-10-07T12:00:00Z");
  const reminders = eventReminders(events, parseLeadTimes("1d,2h"), { now });
  assert.equal(reminders.length, 4);
  assert.equal(reminders[0].dueAt, Date.parse("2026-11-30T12:15:00Z"));
  assert.equal(reminders[0].title, "Tomorrow at 12:15: Lab, MATLAB");
  assert.match(reminders[0].notes, /Tuesday, 1 December 2026, 12:15–14:05 \(UK time\)/);
  assert.equal(reminders[1].title, "In 2 hours at 12:15: Lab, MATLAB");
  assert.deepEqual(eventReminders(events, parseLeadTimes("1d,2h"), { now }).map(r => r.id), reminders.map(r => r.id));
  assert.match(insertReminderSql({ ...reminders[0], now, ignoreDuplicates: true }), /^INSERT OR IGNORE INTO reminders/);

  assert.throws(() => parseLeadTimes("2 weeks"), /Could not read lead time/);
  assert.throws(() => parseIcs("BEGIN:VEVENT\nUID:x\nDTSTART;TZID=America/New_York:20261201T090000\nEND:VEVENT"), /only Europe\/London/);
});

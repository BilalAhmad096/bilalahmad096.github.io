import test from "node:test";
import assert from "node:assert/strict";
import {
  RECORDS_SCHEMA,
  datesToFetch,
  londonDate,
  mergeRecords,
  previousDate,
  readingsFrom,
  sameRecord,
  serialise,
  widenTo
} from "../scripts/lib/grid-records.mjs";

// A day of the feed's /intensity/date/ response, which opens at 23:00Z the
// evening before because the grid's day runs on London time.
const dayPayload = {
  data: [
    { from: "2026-09-11T23:00Z", to: "2026-09-11T23:30Z", intensity: { forecast: 130, actual: 137, index: "moderate" } },
    { from: "2026-09-11T23:30Z", to: "2026-09-12T00:00Z", intensity: { forecast: 128, actual: 121, index: "moderate" } },
    { from: "2026-09-12T12:30Z", to: "2026-09-12T13:00Z", intensity: { forecast: 33, actual: 29, index: "low" } },
    { from: "2026-09-12T13:00Z", to: "2026-09-12T13:30Z", intensity: { forecast: 31, actual: null, index: "low" } }
  ]
};

test("a summer evening reading belongs to the London day after its UTC stamp", () => {
  assert.equal(londonDate("2026-09-11T23:00Z"), "2026-09-12");
  assert.equal(londonDate("2026-09-11T22:30Z"), "2026-09-11");
  // Midwinter, when London is on UTC and the day boundaries line up.
  assert.equal(londonDate("2026-01-11T23:00Z"), "2026-01-11");
});

test("the day before is taken through noon, so no date is skipped", () => {
  assert.equal(previousDate("2026-09-12"), "2026-09-11");
  assert.equal(previousDate("2026-03-01"), "2026-02-28");
  assert.equal(previousDate("2026-01-01"), "2025-12-31");
  // Across the clock change, where a naive 24 hours lands on the wrong day.
  assert.equal(previousDate("2026-03-30"), "2026-03-29");
});

test("only settled readings are recordable", () => {
  const readings = readingsFrom(dayPayload);
  assert.equal(readings.length, 3);
  assert.deepEqual(readings[2], { at: "2026-09-12T12:30Z", value: 29, index: "low" });
  assert.deepEqual(readingsFrom(null), []);
});

test("a first run records today, and counts the London day's 23:00Z opener", () => {
  const records = mergeRecords(null, readingsFrom(dayPayload), { since: "2026-09-12" });

  assert.equal(records.schema, RECORDS_SCHEMA);
  assert.equal(records.since, "2026-09-12");
  assert.equal(records.through, "2026-09-12T12:30Z", "the newest half hour folded in");
  assert.deepEqual(records.lowest, { at: "2026-09-12T12:30Z", value: 29, index: "low" });
  assert.deepEqual(records.highest, { at: "2026-09-11T23:00Z", value: 137, index: "moderate" });
});

test("nothing before the start date can set a record", () => {
  const yesterday = [{ at: "2026-09-11T12:00Z", value: 5, index: "very low" }];
  const records = mergeRecords(null, [...yesterday, ...readingsFrom(dayPayload)], { since: "2026-09-12" });

  assert.equal(records.lowest.value, 29);
});

test("re-reading a covered day leaves the record exactly as it was", () => {
  const first = mergeRecords(null, readingsFrom(dayPayload), { since: "2026-09-12" });
  const again = mergeRecords(first, readingsFrom(dayPayload));

  assert.deepEqual(again, first);
  assert.equal(sameRecord(first, again), true);
});

test("a new day only moves the halves it actually beats", () => {
  const first = mergeRecords(null, readingsFrom(dayPayload), { since: "2026-09-12" });
  const next = mergeRecords(first, [
    { at: "2026-09-13T02:00Z", value: 24, index: "very low" },
    { at: "2026-09-13T18:00Z", value: 130, index: "moderate" }
  ]);

  assert.equal(next.lowest.value, 24);
  assert.equal(next.highest.value, 137, "137 still stands");
  assert.equal(next.since, "2026-09-12", "the start date never moves");
  assert.equal(next.through, "2026-09-13T18:00Z");
  assert.equal(sameRecord(first, next), false);
});

test("only a half hour that lands after the last one can move the record", () => {
  const held = mergeRecords(null, readingsFrom(dayPayload), { since: "2026-09-12" });
  assert.equal(held.through, "2026-09-12T12:30Z");

  // A reading from earlier in the covered span, settling late and lower than
  // the record, is not folded: the record is not re-derived from history.
  const older = mergeRecords(held, [{ at: "2026-09-12T09:00Z", value: 12, index: "very low" }]);
  assert.equal(older.lowest.value, 29);
  assert.equal(sameRecord(held, older), true);

  // One that lands after it, and beats it outright, does move it.
  const beaten = mergeRecords(held, [{ at: "2026-09-12T13:00Z", value: 27, index: "low" }]);
  assert.equal(beaten.lowest.value, 27);
  assert.equal(beaten.lowest.at, "2026-09-12T13:00Z");
  assert.equal(beaten.highest.value, 137, "the other half is left alone");
});

test("matching the record is not beating it", () => {
  const held = mergeRecords(null, readingsFrom(dayPayload), { since: "2026-09-12" });
  const level = mergeRecords(held, [
    { at: "2026-09-12T13:00Z", value: 29, index: "low" },
    { at: "2026-09-12T13:30Z", value: 137, index: "moderate" }
  ]);

  assert.equal(level.lowest.at, "2026-09-12T12:30Z", "the first half hour to reach it keeps it");
  assert.equal(level.highest.at, "2026-09-11T23:00Z");
  assert.equal(sameRecord(held, level), true, "so the file is left alone");
});

test("a run that beat nothing does not rewrite the file for its own sake", () => {
  const held = mergeRecords(null, readingsFrom(dayPayload), { since: "2026-09-12" });
  const later = mergeRecords(held, [{ at: "2026-09-12T14:00Z", value: 60, index: "low" }]);

  assert.equal(later.through, "2026-09-12T14:00Z", "the run did see a newer half hour");
  assert.equal(sameRecord(held, later), true, "but the record itself has not moved");
});

test("a tie belongs to the half hour that reached it first", () => {
  const records = mergeRecords(null, [
    { at: "2026-09-12T09:00Z", value: 40, index: "low" },
    { at: "2026-09-12T10:00Z", value: 40, index: "low" }
  ], { since: "2026-09-12" });

  assert.equal(records.lowest.at, "2026-09-12T09:00Z");
  assert.equal(records.highest.at, "2026-09-12T09:00Z");
});

test("a run with nothing settled refuses to write a half record", () => {
  assert.throws(() => mergeRecords(null, [], { since: "2026-09-12" }), /no settled readings/);
});

test("each run re-reads yesterday, and backfills a gap it finds", () => {
  assert.deepEqual(datesToFetch(null, "2026-09-12"), ["2026-09-11", "2026-09-12"]);

  assert.deepEqual(
    datesToFetch({ since: "2026-09-12", through: "2026-09-12" }, "2026-09-12"),
    ["2026-09-11", "2026-09-12"]);

  // Four days since the last successful run.
  assert.deepEqual(
    datesToFetch({ since: "2026-09-01", through: "2026-09-08" }, "2026-09-12"),
    ["2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-12"]);

  // A through that is a timestamp names the day it falls in.
  assert.deepEqual(
    datesToFetch({ since: "2026-09-01", through: "2026-09-08T18:30Z" }, "2026-09-10"),
    ["2026-09-08", "2026-09-09", "2026-09-10"]);

  // A file left stale for a year asks for a capped window, not a year of calls.
  assert.equal(datesToFetch({ since: "2025-09-12", through: "2025-09-12" }, "2026-09-12").length, 14);
});

test("widening the start reopens the window and keeps the records held", () => {
  const held = mergeRecords(null, readingsFrom(dayPayload), { since: "2026-09-12" });
  const wider = widenTo(held, "2026-09-11");

  assert.equal(wider.since, "2026-09-11");
  assert.equal(wider.through, "2026-09-11", "the day to re-read from moves back with it");
  assert.deepEqual(wider.lowest, held.lowest, "a record stands over a longer span");
  assert.deepEqual(datesToFetch(wider, "2026-09-12"), ["2026-09-11", "2026-09-12"]);

  // Yesterday's readings can then take a half the stored pair did not hold.
  const merged = mergeRecords(wider, [{ at: "2026-09-11T18:30Z", value: 200, index: "high" }]);
  assert.equal(merged.highest.value, 200);
  assert.equal(merged.lowest.value, 29);
  assert.equal(merged.since, "2026-09-11");
});

test("a start date that is not earlier leaves the record untouched", () => {
  const held = mergeRecords(null, readingsFrom(dayPayload), { since: "2026-09-12" });

  assert.equal(widenTo(held, "2026-09-12"), held);
  assert.equal(widenTo(held, "2026-09-13"), held, "the start never moves forwards");
  assert.equal(widenTo(held, null), held);
  assert.equal(widenTo(null, "2026-09-11"), null);
  assert.throws(() => widenTo(held, "yesterday"), /not a date/);
});

test("the written file stamps the run and keeps each record on one line", () => {
  const records = mergeRecords(null, readingsFrom(dayPayload), { since: "2026-09-12" });
  const text = serialise(records, new Date("2026-09-12T13:22:45Z"));

  assert.equal(JSON.parse(text).updated, "2026-09-12T13:22:45.000Z");
  assert.deepEqual(JSON.parse(text).lowest, records.lowest);
  assert.ok(text.includes('"lowest": {"value": 29, "at": "2026-09-12T12:30Z", "index": "low"}'));
  assert.ok(text.endsWith("}\n"));
});

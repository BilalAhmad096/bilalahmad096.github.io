// Pure transforms behind data/grid-records.json, the lowest and highest carbon
// intensity this site has on record.
//
// The site is static, so the record cannot accumulate in a visitor's browser
// and still be the same record for everyone. Instead a scheduled job re-reads
// the settled half hours from the carbon intensity feed, folds them into the
// stored pair and commits the file, the way the contribution calendar is kept.
//
// Two rules keep the claim honest:
//   * only settled readings count, so a forecast can never set a record, and
//   * a day already covered is re-read rather than trusted, because a half hour
//     settles some minutes after it ends.
//
// Nothing here performs I/O, so the folding rules stay testable.

export const RECORDS_SCHEMA = 1;

export class GridRecordsError extends Error {}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const londonParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

/**
 * The settlement day a moment belongs to, named the way the feed's /date/
 * endpoint names it. The grid's day runs on London time, so a reading stamped
 * 23:00Z in summer belongs to the day after the one its UTC stamp reads.
 */
export function londonDate(when = new Date()) {
  const moment = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(moment.getTime())) throw new GridRecordsError(`${when} is not a moment`);

  const parts = Object.fromEntries(
    londonParts.formatToParts(moment).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** The day before, taken through London noon so no date is skipped or repeated. */
export function previousDate(date) {
  if (!DATE_PATTERN.test(String(date))) throw new GridRecordsError(`${date} is not a date`);
  return londonDate(new Date(new Date(`${date}T12:00:00Z`).getTime() - DAY_MS));
}

/**
 * The days worth requesting this run: today, yesterday, and any further back
 * left uncovered by a run that did not happen. Capped, so a file left stale for
 * a month does not turn one run into a month of requests.
 */
export function datesToFetch(records, today = londonDate(), maxDays = 14) {
  if (!DATE_PATTERN.test(String(today))) throw new GridRecordsError(`${today} is not a date`);

  const held = records?.through ?? records?.since ?? today;
  const covered = DATE_PATTERN.test(String(held)) ? held : londonDate(held);
  const yesterday = previousDate(today);
  const from = covered < yesterday ? covered : yesterday;

  const days = [];
  let day = today;
  while (days.length < Math.max(1, maxDays)) {
    days.unshift(day);
    if (day <= from) break;
    day = previousDate(day);
  }
  return days;
}

/**
 * The stored record reopened at an earlier start date. Widening backwards is
 * safe: a record already held stays a record over a longer span, so only the
 * window to re-read has to move with it.
 */
export function widenTo(records, since) {
  if (!records || !since) return records ?? null;
  if (!DATE_PATTERN.test(String(since))) throw new GridRecordsError(`${since} is not a date`);

  return since < records.since ? { ...records, since, through: since } : records;
}

/** A day of feed rows down to the settled readings, forecasts dropped. */
export function readingsFrom(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows
    .filter(row => typeof row?.from === "string" && Number.isFinite(row?.intensity?.actual))
    .map(row => ({
      at: row.from,
      value: row.intensity.actual,
      index: row.intensity.index || null
    }));
}

/**
 * Readings folded into the stored record.
 *
 * Only a half hour that has landed since the last one folded is considered, and
 * it has to beat the record outright: strictly below the lowest, or strictly
 * above the highest, at the moment it lands. So the pair is never re-derived
 * from history, and re-reading a day cannot restate it. Ties change nothing
 * either, which keeps a record with the first half hour that reached it.
 */
export function mergeRecords(records, readings, { since } = {}) {
  const start = records?.since ?? since ?? londonDate();
  if (!DATE_PATTERN.test(String(start))) throw new GridRecordsError(`${start} is not a date`);

  let lowest = records?.lowest ?? null;
  let highest = records?.highest ?? null;
  let through = records?.through ?? null;

  (Array.isArray(readings) ? readings : [])
    .filter(reading =>
      Number.isFinite(reading?.value) &&
      typeof reading?.at === "string" &&
      londonDate(reading.at) >= start &&
      // Landed since the last run, rather than read back out of a covered day.
      (!records?.through || reading.at > records.through))
    .forEach(reading => {
      const landed = { at: reading.at, value: reading.value, index: reading.index || null };

      if (!lowest || landed.value < lowest.value) lowest = landed;
      if (!highest || landed.value > highest.value) highest = landed;
      if (!through || landed.at > through) through = landed.at;
    });

  if (!lowest || !highest) throw new GridRecordsError("no settled readings to record");

  return { schema: RECORDS_SCHEMA, since: start, through, lowest, highest };
}

/** The stored file, with the run's own timestamp stamped on top. */
export function serialise(records, updated = new Date()) {
  const stamped = {
    ...records,
    updated: (updated instanceof Date ? updated : new Date(updated)).toISOString()
  };
  const { lowest, highest, ...head } = stamped;
  const pair = ([name, reading]) =>
    `  ${JSON.stringify(name)}: {"value": ${reading.value}, ` +
    `"at": ${JSON.stringify(reading.at)}, "index": ${JSON.stringify(reading.index)}}`;

  return `{\n${Object.entries(head)
    .map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`)
    .join("\n")}\n${[["lowest", lowest], ["highest", highest]].map(pair).join(",\n")}\n}\n`;
}

/** True when a run found nothing the stored file does not already say. */
export function sameRecord(stored, next) {
  if (!stored || !next) return false;
  const same = (a, b) => a?.value === b?.value && a?.at === b?.at;
  // How far the reading has got is deliberately not part of this: a run that
  // beat nothing leaves the file alone, rather than committing a new high water
  // mark for a record that has not moved.
  return stored.since === next.since &&
    same(stored.lowest, next.lowest) && same(stored.highest, next.highest);
}

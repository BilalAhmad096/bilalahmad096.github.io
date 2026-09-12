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

  const covered = records?.through ?? records?.since ?? today;
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
 * Readings folded into the stored record. Ties keep the earlier half hour: the
 * record belongs to the first time the grid reached it, not the latest time it
 * matched, so re-reading a covered day changes nothing.
 *
 * Coverage is tracked by settlement day rather than by the last half hour seen.
 * A timestamp would differ on every run and commit a file nobody's reading
 * changed; a day means the file moves when the record moves, or once at
 * midnight.
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
      londonDate(reading.at) >= start)
    .forEach(reading => {
      const held = { at: reading.at, value: reading.value, index: reading.index || null };
      const day = londonDate(held.at);

      if (!lowest || held.value < lowest.value ||
        (held.value === lowest.value && held.at < lowest.at)) lowest = held;

      if (!highest || held.value > highest.value ||
        (held.value === highest.value && held.at < highest.at)) highest = held;

      if (!through || day > through) through = day;
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
  return stored.since === next.since && stored.through === next.through &&
    same(stored.lowest, next.lowest) && same(stored.highest, next.highest);
}

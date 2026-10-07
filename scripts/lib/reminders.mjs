// Helpers for scripts/reminder.mjs, kept separate so the time parsing can be tested.
import { createHash } from "node:crypto";
import { RECIPIENT_KEYS } from "../../worker/src/reminders.js";

export const TIME_ZONE = "Europe/London";
const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/;
const MAX_TITLE = 200;
const MAX_NOTES = 3000;

// Offset of London from UTC, in milliseconds, at the given instant.
function londonOffset(instant) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TIME_ZONE, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"
    }).formatToParts(new Date(instant)).map(part => [part.type, part.value])
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

// "2026-10-10 09:00" is read as London time; anything with Z or an offset is taken as given.
export function parseDueAt(value) {
  const text = String(value || "").trim();
  const local = LOCAL_TIME.exec(text);
  if (local) {
    const [, year, month, day, hour, minute] = local.map(Number);
    const wall = Date.UTC(year, month - 1, day, hour, minute);
    let instant = wall - londonOffset(wall);
    instant = wall - londonOffset(instant);
    if (formatLondon(instant, true) !== `${local[1]}-${local[2]}-${local[3]} ${String(hour).padStart(2, "0")}:${local[5]}`) {
      throw new Error(`${text} is not a valid London time (check the date, or the clocks-forward hour).`);
    }
    return instant;
  }
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const instant = Date.parse(text);
    if (Number.isFinite(instant)) return instant;
  }
  throw new Error(`Could not read "${text}". Use "YYYY-MM-DD HH:MM" in UK time.`);
}

export function formatLondon(instant, compact = false) {
  if (compact) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: TIME_ZONE, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
      }).formatToParts(new Date(instant)).map(part => [part.type, part.value])
    );
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  }
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "full", timeStyle: "short", timeZone: TIME_ZONE }).format(new Date(instant));
}

// wrangler d1 execute --command takes no bound parameters, so values are quoted here.
export function sqlString(value) {
  return `'${String(value).replace(/\u0000/g, "").replace(/'/g, "''")}'`;
}

// ignoreDuplicates lets a re-import skip reminders it already created, cancelled ones included.
export function insertReminderSql({ id, title, notes = "", dueAt, recipient = "me", now = Date.now(), ignoreDuplicates = false }) {
  if (!RECIPIENT_KEYS.includes(recipient)) throw new Error(`--for must be one of: ${RECIPIENT_KEYS.join(", ")}.`);
  const cleanTitle = String(title || "").replace(/\s+/g, " ").trim();
  if (!cleanTitle) throw new Error("A reminder needs a title.");
  if (cleanTitle.length > MAX_TITLE) throw new Error(`Keep the title under ${MAX_TITLE} characters; put detail in --notes.`);
  const cleanNotes = String(notes || "").trim();
  if (cleanNotes.length > MAX_NOTES) throw new Error(`Keep notes under ${MAX_NOTES} characters.`);
  if (!Number.isFinite(dueAt)) throw new Error("A reminder needs a due time.");
  if (dueAt <= now) throw new Error(`${formatLondon(dueAt)} is already in the past.`);
  return `INSERT${ignoreDuplicates ? " OR IGNORE" : ""} INTO reminders (id, created_at, due_at, title, notes, recipient) VALUES (${sqlString(id)}, ${now}, ${dueAt}, ${sqlString(cleanTitle)}, ${sqlString(cleanNotes)}, ${sqlString(recipient)})`;
}

// A deliberately small iCalendar reader: VEVENTs with UID, SUMMARY, DTSTART and DTEND.
// Times are read as London time when floating or TZID=Europe/London, or as UTC with Z.
function unescapeText(value) {
  return value.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
}

function parseIcsTime(params, value) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})\d{2}(Z?)$/.exec(value);
  if (!match) throw new Error(`Unsupported calendar time "${value}" (all-day events are not supported).`);
  const [, year, month, day, hour, minute, utc] = match;
  if (utc) return Date.UTC(+year, +month - 1, +day, +hour, +minute);
  const zone = /TZID=([^;:]+)/i.exec(params)?.[1];
  if (zone && zone !== TIME_ZONE) throw new Error(`Unsupported calendar time zone ${zone}; only ${TIME_ZONE} is handled.`);
  return parseDueAt(`${year}-${month}-${day} ${hour}:${minute}`);
}

export function parseIcs(text) {
  const lines = String(text).replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const events = [];
  let event = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") event = {};
    else if (line === "END:VEVENT") {
      if (event?.uid && event.summary && Number.isFinite(event.start)) events.push(event);
      event = null;
    } else if (event) {
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const [name, ...rest] = line.slice(0, colon).split(";");
      const params = rest.join(";");
      const value = line.slice(colon + 1);
      const key = name.toUpperCase();
      if (key === "UID") event.uid = value.trim();
      else if (key === "SUMMARY") event.summary = unescapeText(value).trim();
      else if (key === "DTSTART") event.start = parseIcsTime(params, value.trim());
      else if (key === "DTEND") event.end = parseIcsTime(params, value.trim());
    }
  }
  return events.sort((a, b) => a.start - b.start);
}

const UNIT_MS = { m: 60000, h: 3600000, d: 86400000 };
const UNIT_NAME = { m: "minute", h: "hour", d: "day" };

// "1d,2h" -> lead times before each event.
export function parseLeadTimes(value) {
  const leads = String(value || "").split(",").map(item => item.trim()).filter(Boolean).map(item => {
    const match = /^(\d+)\s*([mhd])$/i.exec(item);
    if (!match || +match[1] === 0) throw new Error(`Could not read lead time "${item}". Use forms like 1d, 2h or 30m.`);
    const amount = +match[1];
    const unit = match[2].toLowerCase();
    return { code: `${amount}${unit}`, ms: amount * UNIT_MS[unit], label: `${amount} ${UNIT_NAME[unit]}${amount === 1 ? "" : "s"}`, tomorrow: unit === "d" && amount === 1 };
  });
  if (!leads.length) throw new Error("Give at least one lead time with --before, e.g. --before 1d,2h.");
  return leads;
}

function londonParts(instant, options) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, ...options }).format(new Date(instant));
}

const clock = instant => londonParts(instant, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const longDate = instant => londonParts(instant, { weekday: "long", day: "numeric", month: "long", year: "numeric" });

// One reminder per event and lead time. Ids come from the event UID and lead time, so
// importing the same calendar twice adds nothing new.
export function eventReminders(events, leads, { recipient = "me", now = Date.now() } = {}) {
  const reminders = [];
  for (const event of events) {
    const span = Number.isFinite(event.end) ? `${clock(event.start)}–${clock(event.end)}` : clock(event.start);
    for (const lead of leads) {
      const dueAt = event.start - lead.ms;
      if (dueAt <= now) continue;
      const when = lead.tomorrow ? "Tomorrow" : `In ${lead.label}`;
      const timing = lead.tomorrow ? "is tomorrow" : `starts in ${lead.label}`;
      reminders.push({
        id: createHash("sha256").update(`${recipient}|${event.uid}|${event.start}|${lead.code}`).digest("hex").slice(0, 8),
        dueAt,
        recipient,
        title: `${when} at ${clock(event.start)}: ${event.summary}`,
        notes: `${event.summary}\n\nThis session ${timing}: ${longDate(event.start)}, ${span} (UK time).`
      });
    }
  }
  return reminders;
}

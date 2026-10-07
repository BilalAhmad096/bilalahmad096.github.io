// Helpers for scripts/reminder.mjs, kept separate so the time parsing can be tested.
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

export function insertReminderSql({ id, title, notes = "", dueAt, recipient = "me", now = Date.now() }) {
  if (!RECIPIENT_KEYS.includes(recipient)) throw new Error(`--for must be one of: ${RECIPIENT_KEYS.join(", ")}.`);
  const cleanTitle = String(title || "").replace(/\s+/g, " ").trim();
  if (!cleanTitle) throw new Error("A reminder needs a title.");
  if (cleanTitle.length > MAX_TITLE) throw new Error(`Keep the title under ${MAX_TITLE} characters; put detail in --notes.`);
  const cleanNotes = String(notes || "").trim();
  if (cleanNotes.length > MAX_NOTES) throw new Error(`Keep notes under ${MAX_NOTES} characters.`);
  if (!Number.isFinite(dueAt)) throw new Error("A reminder needs a due time.");
  if (dueAt <= now) throw new Error(`${formatLondon(dueAt)} is already in the past.`);
  return `INSERT INTO reminders (id, created_at, due_at, title, notes, recipient) VALUES (${sqlString(id)}, ${now}, ${dueAt}, ${sqlString(cleanTitle)}, ${sqlString(cleanNotes)}, ${sqlString(recipient)})`;
}

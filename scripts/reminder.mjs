// Adds, lists and cancels the owner's email reminders in the production D1 database.
// The Worker's five-minute cron sends each one through Resend once it falls due.
//
//   npm run reminder -- add --at "2026-10-10 09:00" --title "Submit the review" [--notes "..."] [--for wife]
//   npm run reminder -- list
//   npm run reminder -- cancel <id> [<id>...]
//   npm run reminder -- import sessions.ics --before 1d,2h [--for wife] [--dry-run]
//   npm run reminder -- import-json reminders.json [--dry-run]
//   npm run reminder -- sync-json reminders.json --prefix tt- [--dry-run]
//
// Times without an offset are UK time. Reminders go to the owner unless --for names another
// recipient key. Needs `npx wrangler login`.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { eventReminders, formatLondon, insertReminderSql, parseDueAt, parseIcs, parseLeadTimes, sqlString } from "./lib/reminders.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WRANGLER = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const DATABASE = "ask-mintorian-insights";
const IMPORT_BATCH = 15;

// Cloudflare intermittently rejects a D1 request with 7403 before running it, and the same
// request succeeds moments later, so that one error is retried.
const TRANSIENT_ATTEMPTS = 4;

// Spawned without a shell, so the SQL reaches wrangler as one argument with no quoting games.
// Returns one result per statement.
function execute(sql) {
  let run;
  for (let attempt = 1; attempt <= TRANSIENT_ATTEMPTS; attempt += 1) {
    run = spawnSync(
      process.execPath,
      [WRANGLER, "d1", "execute", DATABASE, "--remote", "--json", "--config", "worker/wrangler.jsonc", "--command", sql],
      { cwd: ROOT, encoding: "utf8" }
    );
    if (run.status === 0 || !/"code":\s*7403/.test(run.stdout || "")) break;
    if (attempt < TRANSIENT_ATTEMPTS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000 * attempt);
  }
  if (run.status !== 0) {
    process.stderr.write(run.stderr || run.stdout || "wrangler failed\n");
    process.exit(run.status || 1);
  }
  return JSON.parse(run.stdout);
}

function add(options) {
  const dueAt = parseDueAt(options.at);
  const id = crypto.randomUUID().slice(0, 8);
  const recipient = options.for || "me";
  execute(insertReminderSql({ id, title: options.title, notes: options.notes, dueAt, recipient }));
  console.log(`Reminder ${id} for ${recipient} set for ${formatLondon(dueAt)}: ${options.title}`);
}

function list() {
  const [{ results }] = execute(
    "SELECT id, due_at, title, notes, recipient, attempts FROM reminders WHERE sent_at IS NULL AND cancelled_at IS NULL ORDER BY due_at"
  );
  if (!results.length) return console.log("No upcoming reminders.");
  for (const row of results) {
    const retry = row.attempts ? ` (failed ${row.attempts}x)` : "";
    console.log(`${row.id}  ${formatLondon(row.due_at, true)}  ${row.recipient.padEnd(4)}  ${row.title}${retry}`);
    if (row.notes) console.log(`          ${row.notes.replace(/\s*\n\s*/g, " / ")}`);
  }
}

function cancel(ids) {
  if (!ids.length) throw new Error("Give one or more ids from `npm run reminder -- list`.");
  const [{ meta }] = execute(
    `UPDATE reminders SET cancelled_at = ${Date.now()} WHERE id IN (${ids.map(sqlString).join(", ")}) AND sent_at IS NULL AND cancelled_at IS NULL`
  );
  console.log(`Cancelled ${meta?.changes || 0} of ${ids.length} upcoming reminders.`);
}

// Statements use INSERT OR IGNORE with stable ids, so a source can be imported again
// after it changes without duplicating the reminders already there.
function save(reminders, now, dryRun) {
  for (const reminder of reminders) {
    console.log(`${reminder.id}  ${formatLondon(reminder.dueAt, true)}  ${reminder.recipient.padEnd(4)}  ${reminder.title}`);
  }
  if (dryRun) return console.log(`Dry run: ${reminders.length} reminders, nothing saved.`);

  let added = 0;
  for (let start = 0; start < reminders.length; start += IMPORT_BATCH) {
    const batch = reminders.slice(start, start + IMPORT_BATCH);
    const results = execute(batch.map(reminder => insertReminderSql({ ...reminder, now, ignoreDuplicates: true })).join(";\n"));
    added += results.reduce((total, result) => total + (result?.meta?.changes || 0), 0);
  }
  console.log(`Added ${added} of ${reminders.length} reminders${added < reminders.length ? " (the rest were already there)" : ""}.`);
}

function importCalendar(file, options) {
  if (!file) throw new Error("Give the path of an .ics file.");
  const now = Date.now();
  const reminders = eventReminders(parseIcs(readFileSync(file, "utf8")), parseLeadTimes(options.before), { recipient: options.for || "me", now });
  if (!reminders.length) return console.log("No future reminders to add from that calendar.");
  save(reminders, now, options["dry-run"]);
}

// A JSON array of { id, at, title, notes, for }, as written by a generator script. Each
// item needs its own stable id so that re-importing the file adds only what is missing.
function readJsonReminders(file, now) {
  if (!file) throw new Error("Give the path of a .json file.");
  return JSON.parse(readFileSync(file, "utf8")).map(item => {
    if (!/^[\w-]{4,40}$/.test(String(item.id || ""))) throw new Error(`Every item needs a stable id; got ${JSON.stringify(item.id)}.`);
    return { id: item.id, dueAt: parseDueAt(item.at), title: item.title, notes: item.notes, recipient: item.for || "me" };
  }).filter(reminder => reminder.dueAt > now);
}

function importJson(file, options) {
  const now = Date.now();
  const reminders = readJsonReminders(file, now);
  if (!reminders.length) return console.log("No future reminders in that file.");
  save(reminders, now, options["dry-run"]);
}

// Makes the upcoming reminders whose ids start with --prefix match the file exactly: ones no
// longer in the file are cancelled, new ones are added, and unchanged ones are left alone.
function syncJson(file, options) {
  const prefix = String(options.prefix || "");
  if (!/^[\w-]{2,20}$/.test(prefix)) throw new Error("Give the id prefix the file owns, e.g. --prefix tt-.");
  const now = Date.now();
  const reminders = readJsonReminders(file, now);
  if (reminders.some(reminder => !reminder.id.startsWith(prefix))) throw new Error(`Every id in the file must start with ${prefix}.`);

  const wanted = new Set(reminders.map(reminder => reminder.id));
  const [{ results }] = execute(
    `SELECT id FROM reminders WHERE id LIKE ${sqlString(`${prefix}%`)} AND sent_at IS NULL AND cancelled_at IS NULL`
  );
  const stale = results.map(row => row.id).filter(id => !wanted.has(id));
  const fresh = reminders.filter(reminder => !results.some(row => row.id === reminder.id));
  console.log(`${stale.length} to cancel, ${fresh.length} to add, ${reminders.length - fresh.length} unchanged.`);
  if (options["dry-run"]) return;
  if (stale.length) cancel(stale);
  if (fresh.length) save(fresh, now, false);
}

try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      at: { type: "string" }, title: { type: "string" }, notes: { type: "string" }, for: { type: "string" },
      before: { type: "string" }, prefix: { type: "string" }, "dry-run": { type: "boolean" }
    }
  });
  const [command, argument, ...rest] = positionals;
  if (command === "add") add(values);
  else if (command === "list") list();
  else if (command === "cancel") cancel([argument, ...rest].filter(Boolean));
  else if (command === "import") importCalendar(argument, values);
  else if (command === "import-json") importJson(argument, values);
  else if (command === "sync-json") syncJson(argument, values);
  else throw new Error("Usage: npm run reminder -- add --at \"YYYY-MM-DD HH:MM\" --title \"...\" [--for wife] | list | cancel <id>... | import <file.ics> --before 1d,2h | import-json <file.json> | sync-json <file.json> --prefix tt-");
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

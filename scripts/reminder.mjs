// Adds, lists and cancels the owner's email reminders in the production D1 database.
// The Worker's five-minute cron sends each one through Resend once it falls due.
//
//   npm run reminder -- add --at "2026-10-10 09:00" --title "Submit the review" [--notes "..."]
//   npm run reminder -- list
//   npm run reminder -- cancel <id>
//
// Times without an offset are UK time. Needs `npx wrangler login`.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { formatLondon, insertReminderSql, parseDueAt, sqlString } from "./lib/reminders.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WRANGLER = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const DATABASE = "ask-mintorian-insights";

// Spawned without a shell, so the SQL reaches wrangler as one argument with no quoting games.
function execute(sql) {
  const run = spawnSync(
    process.execPath,
    [WRANGLER, "d1", "execute", DATABASE, "--remote", "--json", "--config", "worker/wrangler.jsonc", "--command", sql],
    { cwd: ROOT, encoding: "utf8" }
  );
  if (run.status !== 0) {
    process.stderr.write(run.stderr || run.stdout || "wrangler failed\n");
    process.exit(run.status || 1);
  }
  const [result] = JSON.parse(run.stdout);
  return result;
}

function add(options) {
  const dueAt = parseDueAt(options.at);
  const id = crypto.randomUUID().slice(0, 8);
  execute(insertReminderSql({ id, title: options.title, notes: options.notes, dueAt }));
  console.log(`Reminder ${id} set for ${formatLondon(dueAt)}: ${options.title}`);
}

function list() {
  const { results } = execute(
    "SELECT id, due_at, title, attempts FROM reminders WHERE sent_at IS NULL AND cancelled_at IS NULL ORDER BY due_at"
  );
  if (!results.length) return console.log("No upcoming reminders.");
  for (const row of results) {
    const retry = row.attempts ? ` (failed ${row.attempts}x)` : "";
    console.log(`${row.id}  ${formatLondon(row.due_at, true)}  ${row.title}${retry}`);
  }
}

function cancel(id) {
  if (!id) throw new Error("Give the id from `npm run reminder -- list`.");
  const { meta } = execute(
    `UPDATE reminders SET cancelled_at = ${Date.now()} WHERE id = ${sqlString(id)} AND sent_at IS NULL AND cancelled_at IS NULL`
  );
  console.log(meta?.changes ? `Cancelled ${id}.` : `No upcoming reminder with id ${id}.`);
}

try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { at: { type: "string" }, title: { type: "string" }, notes: { type: "string" } }
  });
  const [command, argument] = positionals;
  if (command === "add") add(values);
  else if (command === "list") list();
  else if (command === "cancel") cancel(argument);
  else throw new Error("Usage: npm run reminder -- add --at \"YYYY-MM-DD HH:MM\" --title \"...\" | list | cancel <id>");
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

import { escapeHtml, sendOperationalEmail } from "./email.js";
import { getAllRecordIds } from "./knowledge.js";

// Rows carry what was asked and what retrieval did with it. They never carry visitor
// identity - no IP, no session id - and never the assistant's answer.
export const RETENTION_DAYS = 90;
const DIGEST_WINDOW_DAYS = 7;
const MAX_QUESTION_LENGTH = 300;
const MAX_DIGEST_ROWS = 25;
const DAY_MS = 86400000;

function normaliseQuestion(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, MAX_QUESTION_LENGTH);
}

function truncate(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

// Never throws and never blocks the answer: a logging failure must not cost a visitor
// their response. Callers pass this to ctx.waitUntil rather than awaiting it inline.
export async function recordTurn(env, turn) {
  const database = env?.INSIGHTS_DB;
  if (!database) return false;

  const question = truncate(turn?.question, MAX_QUESTION_LENGTH);
  if (!question) return false;

  try {
    await database
      .prepare(
        `INSERT INTO retrieval_log
           (id, created_at, question, question_key, tool_queries, match_type, result_count, grounded, tools, record_ids)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        crypto.randomUUID(),
        Date.now(),
        question,
        normaliseQuestion(question),
        JSON.stringify(Array.isArray(turn?.toolQueries) ? turn.toolQueries.map(item => truncate(item, 200)) : []),
        String(turn?.matchType || "none"),
        Number(turn?.resultCount) || 0,
        turn?.grounded ? 1 : 0,
        JSON.stringify(Array.isArray(turn?.tools) ? turn.tools : []),
        JSON.stringify(Array.isArray(turn?.recordIds) ? turn.recordIds : [])
      )
      .run();
    return true;
  } catch (error) {
    console.error("Retrieval log write failed", error?.name || "unknown_error");
    return false;
  }
}

export async function purgeExpired(env, now = Date.now()) {
  const database = env?.INSIGHTS_DB;
  if (!database) return 0;
  try {
    const result = await database
      .prepare("DELETE FROM retrieval_log WHERE created_at < ?")
      .bind(now - RETENTION_DAYS * DAY_MS)
      .run();
    return result?.meta?.changes || 0;
  } catch (error) {
    console.error("Retrieval log purge failed", error?.name || "unknown_error");
    return 0;
  }
}

async function queryAll(database, sql, ...bindings) {
  const statement = bindings.length ? database.prepare(sql).bind(...bindings) : database.prepare(sql);
  const result = await statement.all();
  return result?.results || [];
}

export async function buildDigest(env, now = Date.now()) {
  const database = env?.INSIGHTS_DB;
  if (!database) return null;

  const since = now - DIGEST_WINDOW_DAYS * DAY_MS;

  const [totals] = await queryAll(
    database,
    `SELECT COUNT(*) AS turns,
            SUM(CASE WHEN grounded = 1 THEN 1 ELSE 0 END) AS grounded,
            SUM(CASE WHEN match_type = 'none' THEN 1 ELSE 0 END) AS unanswered,
            SUM(CASE WHEN match_type = 'orientation' THEN 1 ELSE 0 END) AS orientation
       FROM retrieval_log
      WHERE created_at >= ?`,
    since
  );

  // Grouped on the normalised key so "where does he work" and "Where does Bilal work?"
  // count as one gap, but the digest shows a real phrasing rather than the flattened key.
  const gapSql = `SELECT question_key,
                         COUNT(*) AS asked,
                         MAX(question) AS example
                    FROM retrieval_log
                   WHERE created_at >= ? AND match_type = ?
                   GROUP BY question_key
                   ORDER BY asked DESC, example ASC
                   LIMIT ?`;

  const unanswered = await queryAll(database, gapSql, since, "none", MAX_DIGEST_ROWS);
  const orientation = await queryAll(database, gapSql, since, "orientation", MAX_DIGEST_ROWS);

  // json_each expands the stored record_ids array so records can be counted across turns.
  const served = await queryAll(
    database,
    `SELECT value AS record_id, COUNT(*) AS served
       FROM retrieval_log, json_each(retrieval_log.record_ids)
      WHERE created_at >= ?
      GROUP BY value
      ORDER BY served DESC, record_id ASC
      LIMIT ?`,
    since,
    MAX_DIGEST_ROWS
  );

  const servedIds = new Set(served.map(row => row.record_id));
  const neverServed = getAllRecordIds().filter(id => !servedIds.has(id));

  const turns = Number(totals?.turns) || 0;
  return {
    windowDays: DIGEST_WINDOW_DAYS,
    generatedAt: new Date(now).toISOString(),
    turns,
    grounded: Number(totals?.grounded) || 0,
    unansweredTurns: Number(totals?.unanswered) || 0,
    orientationTurns: Number(totals?.orientation) || 0,
    unanswered,
    orientation,
    served,
    neverServed
  };
}

function gapLines(rows) {
  return rows.map(row => `  ${String(row.asked).padStart(3)} x  ${row.example}`).join("\n");
}

// The leading blank line lives here, so an omitted section leaves no gap behind it.
function section(title, lines) {
  return lines ? `\n${title}\n${lines}` : "";
}

function plural(count, word) {
  return count === 1 ? word : `${word}s`;
}

export function renderDigest(summary) {
  const rate = summary.turns ? Math.round((summary.grounded / summary.turns) * 100) : 0;
  const gapCount = summary.unanswered.length;
  const subject = summary.turns
    ? `Ask Mintorian: ${summary.turns} ${plural(summary.turns, "question")}, ${gapCount} ${plural(gapCount, "gap")}`
    : "Ask Mintorian: a quiet week";

  if (!summary.turns) {
    const quiet = [
      "No questions were asked this week.",
      "",
      "Nothing to add to the knowledge base. This note confirms the digest is still running."
    ].join("\n");
    return { subject, text: quiet, html: `<p>${quiet.split("\n").join("<br>")}</p>` };
  }

  const parts = [
    `${summary.turns} ${plural(summary.turns, "question")} over the last ${summary.windowDays} days. ${rate}% were answered from a verified record.`,
    section(
      `UNANSWERED (${summary.unansweredTurns}) - nothing matched, so the assistant declined:`,
      gapLines(summary.unanswered)
    ),
    section(
      `NO SPECIFIC MATCH (${summary.orientationTurns}) - fell back to a general category:`,
      gapLines(summary.orientation)
    ),
    section(
      "MOST SERVED RECORDS:",
      summary.served.map(row => `  ${String(row.served).padStart(3)} x  ${row.record_id}`).join("\n")
    ),
    section(
      `NEVER SERVED (${summary.neverServed.length}) - present but never retrieved:`,
      summary.neverServed.map(id => `  ${id}`).join("\n")
    )
  ];

  const text = parts.filter(Boolean).join("\n");
  return { subject, text, html: `<pre style="font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace">${escapeHtml(text)}</pre>` };
}

// Entry point for the Monday cron. Builds the digest, sends it, then drops anything past
// the retention window so the purge happens even in a week nobody asked anything.
export async function runWeeklyDigest(env, now = Date.now()) {
  const summary = await buildDigest(env, now);
  if (!summary) {
    console.error("Digest skipped: no insights database bound");
    return { sent: false, purged: 0 };
  }

  const { subject, text, html } = renderDigest(summary);
  const sent = await sendOperationalEmail(env, { subject, text, html });
  const purged = await purgeExpired(env, now);
  return { sent, purged, turns: summary.turns, gaps: summary.unanswered.length };
}

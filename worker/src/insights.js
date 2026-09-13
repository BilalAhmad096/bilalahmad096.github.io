import { escapeHtml, sendOperationalEmail } from "./email.js";
import { getAllRecordIds, getRecordTitles } from "./knowledge.js";

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
           (id, created_at, question, question_key, tool_queries, match_type, result_count, grounded, tools, record_ids, categories)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        JSON.stringify(Array.isArray(turn?.recordIds) ? turn.recordIds : []),
        JSON.stringify(Array.isArray(turn?.categories) ? turn.categories : [])
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
            SUM(CASE WHEN match_type = 'orientation' THEN 1 ELSE 0 END) AS orientation,
            SUM(CASE WHEN match_type = 'contact' THEN 1 ELSE 0 END) AS contact
       FROM retrieval_log
      WHERE created_at >= ?`,
    since
  );

  // Grouped on the normalised key so "where does he work" and "Where does Bilal work?"
  // count as one gap. MAX keeps one real phrasing, plus one sample of what the model
  // searched for and where, which is usually what explains the miss.
  const gapSql = `SELECT question_key,
                         COUNT(*) AS asked,
                         MAX(question) AS example,
                         MAX(tool_queries) AS searched_for,
                         MAX(categories) AS searched_in
                    FROM retrieval_log
                   WHERE created_at >= ? AND match_type = ?
                   GROUP BY question_key
                   ORDER BY asked DESC, example ASC
                   LIMIT ?`;

  const unanswered = (await queryAll(database, gapSql, since, "none", MAX_DIGEST_ROWS)).map(withSearch);
  const orientation = (await queryAll(database, gapSql, since, "orientation", MAX_DIGEST_ROWS)).map(withSearch);

  // Only each turn's first record counts: it is the best match. Counting every record
  // returned let filler that rode along on unrelated questions look popular.
  const topAnswers = await queryAll(
    database,
    `SELECT json_extract(record_ids, '$[0]') AS record_id, COUNT(*) AS served
       FROM retrieval_log
      WHERE created_at >= ? AND json_array_length(record_ids) > 0
      GROUP BY record_id
      ORDER BY served DESC, record_id ASC
      LIMIT ?`,
    since,
    MAX_DIGEST_ROWS
  );

  // "Never served" still means never retrieved at all, in any position.
  const reached = await queryAll(
    database,
    `SELECT DISTINCT value AS record_id
       FROM retrieval_log, json_each(retrieval_log.record_ids)
      WHERE created_at >= ?`,
    since
  );
  const reachedIds = new Set(reached.map(row => row.record_id));
  const neverServed = getAllRecordIds().filter(id => !reachedIds.has(id));

  return {
    windowDays: DIGEST_WINDOW_DAYS,
    windowStart: new Date(since).toISOString(),
    generatedAt: new Date(now).toISOString(),
    turns: Number(totals?.turns) || 0,
    grounded: Number(totals?.grounded) || 0,
    unansweredTurns: Number(totals?.unanswered) || 0,
    orientationTurns: Number(totals?.orientation) || 0,
    contactTurns: Number(totals?.contact) || 0,
    unanswered,
    orientation,
    topAnswers,
    neverServed
  };
}

function parseJsonList(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// searchedIn is null when the row predates scope logging, [] when a call searched every
// category, and the union of filters otherwise. A gap only ever comes from a turn that
// called at least one tool, so a stored "[]" can only mean "not recorded".
function withSearch(row) {
  const scopes = row.searched_in && row.searched_in !== "[]" ? parseJsonList(row.searched_in) : null;
  let searchedIn = null;
  if (scopes) {
    searchedIn = scopes.some(scope => Array.isArray(scope) && scope.length === 0)
      ? []
      : [...new Set(scopes.flat().map(String))];
  }
  return {
    ...row,
    searchedFor: parseJsonList(row.searched_for).map(String).filter(Boolean),
    searchedIn
  };
}

function plural(count, word) {
  return count === 1 ? word : `${word}s`;
}

function categoryLabel(category) {
  return String(category).toLowerCase().replaceAll("_", " ");
}

function scopeLabel(searchedIn) {
  if (searchedIn.length === 0) return "all categories";
  return searchedIn.map(categoryLabel).join(", ");
}

// Explains a miss in one line: what the model looked for and where it was allowed to look.
// Rows logged before search scope was recorded simply omit where the search looked.
function searchDescription(row) {
  const query = row.searchedFor[0];
  const scope = row.searchedIn === null ? "" : scopeLabel(row.searchedIn);
  if (query) return scope ? `Searched for "${query}" in ${scope}` : `Searched for "${query}"`;
  return scope ? `Searched ${scope}` : "Search details not recorded";
}

// The site avoids em dashes, so the range reads "6 to 13 September 2026".
function formatRange(startIso, endIso) {
  const zone = "Europe/London";
  const start = new Date(startIso);
  const end = new Date(endIso);
  const full = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: zone });
  const parts = date => Object.fromEntries(full.formatToParts(date).map(part => [part.type, part.value]));
  const a = parts(start);
  const b = parts(end);
  if (a.month === b.month && a.year === b.year) return `${a.day} to ${full.format(end)}`;
  if (a.year === b.year) return `${a.day} ${a.month} to ${full.format(end)}`;
  return `${full.format(start)} to ${full.format(end)}`;
}

function textSection(title, lines) {
  return lines.length ? ["", title, ...lines].join("\n") : "";
}

function renderText(summary, rate, titles) {
  if (!summary.turns) {
    return [
      "No questions were asked this week.",
      "",
      "Nothing to add to the knowledge base. This note confirms the digest is still running."
    ].join("\n");
  }

  const gapLines = rows => rows.flatMap(row => [
    `  ${String(row.asked).padStart(3)} x  ${row.example}`,
    `         ${searchDescription(row)}`
  ]);

  return [
    `${summary.turns} ${plural(summary.turns, "question")} over the last ${summary.windowDays} days. ${rate}% were answered from a verified record.`,
    summary.contactTurns
      ? `${summary.contactTurns === 1 ? "1 was a meeting or collaboration request" : `${summary.contactTurns} were meeting or collaboration requests`}, answered with contact routes.`
      : "",
    textSection(`UNANSWERED (${summary.unansweredTurns}) - nothing matched, so the assistant declined:`, gapLines(summary.unanswered)),
    textSection(`NO SPECIFIC MATCH (${summary.orientationTurns}) - fell back to a general category:`, gapLines(summary.orientation)),
    textSection(
      "TOP ANSWERS - the best match for each question:",
      summary.topAnswers.map(row => `  ${String(row.served).padStart(3)} x  ${titles.get(row.record_id) || row.record_id}`)
    ),
    textSection(`NEVER SERVED (${summary.neverServed.length}) - present but never retrieved:`, summary.neverServed.map(id => `  ${id}`))
  ].filter(Boolean).join("\n");
}

// Email clients ignore stylesheets and most modern CSS, so the digest is built from nested
// tables with inline styles. The palette matches the Ask Mintorian panel on the site.
const COLOUR = Object.freeze({
  ink: "#0a1a3b",
  accent: "#0f66ff",
  accentSoft: "#eaf2ff",
  page: "#f3f6fb",
  card: "#ffffff",
  soft: "#f7f9fc",
  line: "#e3e9f2",
  track: "#edf1f7",
  muted: "#5b6b82",
  amber: "#b54708",
  amberSoft: "#fff3e8",
  green: "#1e8a58",
  greenSoft: "#ebf7f0"
});

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

function statTile(value, label, tone) {
  const colour = tone === "warn" ? COLOUR.amber : tone === "good" ? COLOUR.green : COLOUR.ink;
  return `<td width="33%" valign="top" style="padding:0 6px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLOUR.soft};border:1px solid ${COLOUR.line};border-radius:12px;">
      <tr><td style="padding:16px 16px 14px;font-family:${FONT};">
        <div style="font-size:28px;line-height:1.1;font-weight:700;color:${colour};">${value}</div>
        <div style="margin-top:5px;font-size:11px;line-height:1.3;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:${COLOUR.muted};">${label}</div>
      </td></tr>
    </table>
  </td>`;
}

function sectionBlock(title, intro, body) {
  return `<tr><td style="padding:30px 32px 0;font-family:${FONT};">
    <div style="font-size:17px;line-height:1.3;font-weight:700;color:${COLOUR.ink};">${title}</div>
    ${intro ? `<div style="margin-top:4px;font-size:13px;line-height:1.5;color:${COLOUR.muted};">${intro}</div>` : ""}
    <div style="margin-top:14px;">${body}</div>
  </td></tr>`;
}

function notice(message, tone) {
  const good = tone === "good";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${good ? COLOUR.greenSoft : COLOUR.soft};border-radius:12px;">
    <tr><td style="padding:14px 16px;font-family:${FONT};font-size:14px;line-height:1.5;color:${good ? COLOUR.green : COLOUR.muted};">${message}</td></tr>
  </table>`;
}

function questionRows(rows, tone) {
  const pillBackground = tone === "warn" ? COLOUR.amberSoft : COLOUR.accentSoft;
  const pillColour = tone === "warn" ? COLOUR.amber : COLOUR.accent;
  const body = rows.map(row => `<tr><td style="padding:12px 0;border-top:1px solid ${COLOUR.line};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td width="48" valign="top" style="padding-top:1px;"><span style="display:inline-block;min-width:22px;padding:3px 8px;border-radius:999px;background:${pillBackground};color:${pillColour};font-family:${FONT};font-size:12px;line-height:1.3;font-weight:700;text-align:center;">${row.asked}&times;</span></td>
        <td valign="top" style="font-family:${FONT};">
          <div style="font-size:15px;line-height:1.45;color:${COLOUR.ink};">${escapeHtml(row.example)}</div>
          <div style="margin-top:3px;font-size:12px;line-height:1.45;color:${COLOUR.muted};">${escapeHtml(searchDescription(row))}</div>
        </td>
      </tr></table>
    </td></tr>`).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${body}</table>`;
}

function topAnswerRows(rows, titles) {
  const most = Math.max(1, ...rows.map(row => Number(row.served) || 0));
  const body = rows.map(row => {
    const width = Math.max(3, Math.round(((Number(row.served) || 0) / most) * 100));
    return `<tr><td style="padding:11px 0;border-top:1px solid ${COLOUR.line};font-family:${FONT};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td valign="top" style="font-size:14px;line-height:1.4;color:${COLOUR.ink};">${escapeHtml(titles.get(row.record_id) || row.record_id)}</td>
        <td width="40" align="right" valign="top" style="font-size:14px;line-height:1.4;font-weight:700;color:${COLOUR.ink};">${Number(row.served) || 0}</td>
      </tr></table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:7px;background:${COLOUR.track};border-radius:3px;"><tr>
        <td width="${width}%" style="height:6px;line-height:6px;font-size:0;background:${COLOUR.accent};border-radius:3px;">&nbsp;</td>
        <td style="height:6px;line-height:6px;font-size:0;">&nbsp;</td>
      </tr></table>
    </td></tr>`;
  }).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${body}</table>`;
}

function chips(ids) {
  return ids.map(id => `<span style="display:inline-block;margin:0 6px 6px 0;padding:4px 10px;border:1px solid ${COLOUR.line};border-radius:999px;background:${COLOUR.soft};color:${COLOUR.muted};font-family:${MONO};font-size:12px;line-height:1.3;">${escapeHtml(id)}</span>`).join("");
}

function renderHtml(summary, rate, titles) {
  const gaps = summary.unanswered.length;
  const range = formatRange(summary.windowStart, summary.generatedAt);
  const preheader = summary.turns
    ? `${summary.turns} ${plural(summary.turns, "question")}, ${gaps} ${plural(gaps, "gap")}, ${rate}% answered from a verified record.`
    : "No questions this week. The digest is still running.";

  const header = `<tr><td style="background:${COLOUR.ink};padding:28px 32px 26px;border-radius:16px 16px 0 0;font-family:${FONT};">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td width="32" height="32" align="center" valign="middle" style="width:32px;height:32px;background:${COLOUR.accent};border-radius:9px;font-size:15px;font-weight:700;color:#ffffff;">M</td>
        <td style="padding-left:10px;font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#9ec0ff;">Ask Mintorian</td>
      </tr></table>
      <div style="margin-top:18px;font-size:26px;line-height:1.2;font-weight:700;color:#ffffff;">Weekly knowledge digest</div>
      <div style="margin-top:6px;font-size:14px;line-height:1.4;color:#b9c7de;">${escapeHtml(range)}</div>
    </td></tr>`;

  let body;
  if (!summary.turns) {
    body = sectionBlock("A quiet week", "", notice("No questions were asked this week, so there is nothing to add to the knowledge base. This note confirms the digest is still running.", "neutral"));
  } else {
    const stats = `<tr><td style="padding:24px 26px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          ${statTile(summary.turns, plural(summary.turns, "Question"), "")}
          ${statTile(`${rate}%`, "Answered", rate >= 90 ? "good" : "")}
          ${statTile(gaps, plural(gaps, "Gap"), gaps ? "warn" : "good")}
        </tr></table>
        ${summary.contactTurns ? `<div style="padding:12px 6px 0;font-family:${FONT};font-size:13px;line-height:1.5;color:${COLOUR.muted};">Includes ${summary.contactTurns} meeting or collaboration ${plural(summary.contactTurns, "request")}, answered with contact routes.</div>` : ""}
      </td></tr>`;

    const unanswered = sectionBlock(
      "Questions it couldn&rsquo;t answer",
      gaps ? "Nothing in the knowledge base matched. Each is a candidate for a new record, unless it was a false premise the assistant was right to decline." : "",
      gaps ? questionRows(summary.unanswered, "warn") : notice("Every question found a verified record this week.", "good")
    );

    const orientation = summary.orientation.length
      ? sectionBlock(
          "Answered from a general category",
          "No specific record matched, so the assistant fell back to the category the question implied.",
          questionRows(summary.orientation, "neutral")
        )
      : "";

    const top = summary.topAnswers.length
      ? sectionBlock(
          "Top answers",
          "The record that best matched each question. Only the first result of a turn is counted.",
          topAnswerRows(summary.topAnswers.slice(0, 8), titles)
        )
      : "";

    const never = summary.neverServed.length
      ? sectionBlock(
          `Never reached (${summary.neverServed.length})`,
          "In the knowledge base, but not retrieved by any question this week.",
          chips(summary.neverServed)
        )
      : "";

    body = stats + unanswered + orientation + top + never;
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ask Mintorian weekly digest</title>
</head>
<body style="margin:0;padding:0;background:${COLOUR.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLOUR.page};">
  <tr><td align="center" style="padding:28px 12px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:${COLOUR.card};border:1px solid ${COLOUR.line};border-radius:16px;">
      ${header}
      ${body}
      <tr><td style="padding:30px 32px 0;"></td></tr>
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">
      <tr><td style="padding:18px 20px 0;font-family:${FONT};font-size:12px;line-height:1.6;color:${COLOUR.muted};text-align:center;">
        Questions are kept for ${RETENTION_DAYS} days, with nothing that identifies the visitor.<br>
        Sent every Monday by the Ask Mintorian worker for <a href="https://mintorian.com" style="color:${COLOUR.accent};text-decoration:none;">mintorian.com</a>.
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

export function renderDigest(summary) {
  const rate = summary.turns ? Math.round((summary.grounded / summary.turns) * 100) : 0;
  const gapCount = summary.unanswered.length;
  const subject = summary.turns
    ? `Ask Mintorian: ${summary.turns} ${plural(summary.turns, "question")}, ${gapCount} ${plural(gapCount, "gap")}`
    : "Ask Mintorian: a quiet week";
  const titles = getRecordTitles();

  return {
    subject,
    text: renderText(summary, rate, titles),
    html: renderHtml(summary, rate, titles)
  };
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

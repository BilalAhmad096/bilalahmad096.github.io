import { ownerAddress, sendOperationalEmail } from "./email.js";
import { cardRow, emailDocument, escapeHtml, multilineHtml, textPanel } from "./email-layout.js";

// Personal reminders the owner adds with `npm run reminder`. Nothing a visitor sends ever
// reaches this table. Each row names a recipient key, never an address: the addresses
// live in Worker secrets, so the table cannot be used to mail anyone else.
export const REMINDER_CRON = "*/5 * * * *";
const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 20;

const RECIPIENTS = {
  me: {
    address: env => ownerAddress(env),
    footer: "A reminder you set with <code>npm run reminder</code>, sent by the Ask Mintorian worker."
  },
  wife: {
    address: env => env?.REMINDER_TO_WIFE,
    footer: "Bilal set this reminder for you. Reply to this email to reach him.",
    repliesToOwner: true
  }
};
export const RECIPIENT_KEYS = Object.keys(RECIPIENTS);

function dueAtLabel(dueAt) {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "full", timeStyle: "short", timeZone: "Europe/London" }).format(new Date(dueAt));
}

export function renderReminderEmail(reminder) {
  const when = dueAtLabel(reminder.due_at);
  const notes = String(reminder.notes || "").trim();
  const recipient = RECIPIENTS[reminder.recipient] || RECIPIENTS.me;
  return {
    subject: `[Reminder] ${reminder.title}`,
    text: [reminder.title, `Due ${when}`, ...(notes ? ["", notes] : [])].join("\n"),
    html: emailDocument({
      preheader: notes || reminder.title,
      titleHtml: escapeHtml(reminder.title),
      subline: `Due ${when}`,
      bodyHtml: notes ? cardRow(textPanel("Notes", multilineHtml(notes)), 24) : "",
      footerHtml: recipient.footer
    })
  };
}

// Each reminder is claimed before sending, so overlapping cron runs cannot send it twice.
// A failed send releases the claim and is retried on later runs, up to MAX_ATTEMPTS.
export async function runDueReminders(env, now = Date.now()) {
  const database = env?.INSIGHTS_DB;
  if (!database) {
    console.error("Reminders skipped: no insights database bound");
    return { due: 0, sent: 0, failed: 0 };
  }

  const result = await database
    .prepare(
      `SELECT id, due_at, title, notes, recipient FROM reminders
        WHERE due_at <= ? AND sent_at IS NULL AND cancelled_at IS NULL AND attempts < ?
        ORDER BY due_at LIMIT ?`
    )
    .bind(now, MAX_ATTEMPTS, BATCH_SIZE)
    .all();
  const due = result?.results || [];

  let sent = 0;
  let failed = 0;
  for (const reminder of due) {
    const claim = await database
      .prepare("UPDATE reminders SET sent_at = ?, attempts = attempts + 1 WHERE id = ? AND sent_at IS NULL")
      .bind(now, reminder.id)
      .run();
    if (!claim?.meta?.changes) continue;

    const recipient = RECIPIENTS[reminder.recipient || "me"];
    const to = recipient?.address(env);
    let delivered = false;
    if (to) {
      delivered = await sendOperationalEmail(env, {
        ...renderReminderEmail(reminder),
        idempotencyKey: `reminder:${reminder.id}`,
        to,
        replyTo: recipient.repliesToOwner ? ownerAddress(env) : undefined
      });
    } else {
      console.error("Reminder recipient is not configured", reminder.recipient);
    }

    if (delivered) {
      sent += 1;
    } else {
      failed += 1;
      await database.prepare("UPDATE reminders SET sent_at = NULL WHERE id = ?").bind(reminder.id).run();
    }
  }
  return { due: due.length, sent, failed };
}

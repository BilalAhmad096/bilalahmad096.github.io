-- Reminders the owner sets for themselves with `npm run reminder`. The five-minute cron
-- emails each one once its due time has passed. Times are UTC epoch milliseconds.
CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  sent_at INTEGER,
  cancelled_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (due_at) WHERE sent_at IS NULL AND cancelled_at IS NULL;

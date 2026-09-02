-- What each turn asked for and what retrieval returned. Deliberately holds no visitor
-- identity: no IP, no session id, no answer text. Rows are purged after 90 days by the
-- Monday digest job.
CREATE TABLE IF NOT EXISTS retrieval_log (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  question TEXT NOT NULL,
  question_key TEXT NOT NULL,
  tool_queries TEXT NOT NULL,
  match_type TEXT NOT NULL,
  result_count INTEGER NOT NULL,
  grounded INTEGER NOT NULL,
  tools TEXT NOT NULL,
  record_ids TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_retrieval_log_created_at ON retrieval_log (created_at);
CREATE INDEX IF NOT EXISTS idx_retrieval_log_question_key ON retrieval_log (question_key);

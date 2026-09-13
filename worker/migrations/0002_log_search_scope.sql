-- Which categories each tool call searched, aligned with the tools column. An empty inner
-- list means the call searched every category. Without this a filtered-out record looks
-- identical to a missing one in the digest.
ALTER TABLE retrieval_log ADD COLUMN categories TEXT NOT NULL DEFAULT '[]';

-- Meeting and collaboration requests are answered with contact routes rather than records,
-- and were logged as unanswered. Reclassify the rows already captured so the digest counts
-- them as answered.
UPDATE retrieval_log
   SET match_type = 'contact', grounded = 1
 WHERE match_type = 'none'
   AND record_ids = '[]'
   AND (tools LIKE '%"get_contact_options"%' OR tools LIKE '%"check_availability"%');

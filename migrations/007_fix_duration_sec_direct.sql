-- Direct ALTER without DO block — migration 005 DO $$ may have failed silently.
-- USING clause handles both integer and numeric source types safely.
ALTER TABLE play_logs
  ALTER COLUMN duration_sec TYPE NUMERIC(10,3)
  USING duration_sec::text::NUMERIC(10,3);

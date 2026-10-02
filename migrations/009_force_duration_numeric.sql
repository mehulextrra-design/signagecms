-- Guaranteed fix for play_logs.duration_sec INTEGER → NUMERIC.
-- Uses rename+add+copy+drop to avoid ALTER TYPE failures on existing data.
-- Safe to run multiple times: checks data_type before acting.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'play_logs'
      AND column_name = 'duration_sec'
      AND data_type IN ('integer','bigint','smallint','int4','int8','int2')
  ) THEN
    ALTER TABLE play_logs RENAME COLUMN duration_sec TO _dur_int_old;
    ALTER TABLE play_logs ADD COLUMN duration_sec NUMERIC(10,3);
    UPDATE play_logs SET duration_sec = _dur_int_old::NUMERIC(10,3) WHERE _dur_int_old IS NOT NULL;
    ALTER TABLE play_logs DROP COLUMN _dur_int_old;
    RAISE NOTICE 'play_logs.duration_sec converted INTEGER -> NUMERIC(10,3)';
  END IF;
END $$;

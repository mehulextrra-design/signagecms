-- Final guaranteed fix for play_logs.duration_sec.
-- Handles all possible states left by prior migrations:
--   a) column is INTEGER/BIGINT/SMALLINT → convert to NUMERIC(10,3)
--   b) migration 009 left column as _dur_int_old (partial rename) → finish the job
--   c) column is already NUMERIC/DECIMAL → no-op
DO $$
DECLARE
  col_typid   oid;
  old_typid   oid;
BEGIN
  -- Check if 009 left a partial rename (_dur_int_old exists, duration_sec missing)
  SELECT atttypid INTO old_typid
  FROM pg_attribute
  WHERE attrelid = 'play_logs'::regclass
    AND attname   = '_dur_int_old'
    AND attnum    > 0
    AND NOT attisdropped;

  IF old_typid IS NOT NULL THEN
    -- 009 partial run: add duration_sec back and copy data
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = 'play_logs'::regclass AND attname = 'duration_sec'
        AND attnum > 0 AND NOT attisdropped
    ) THEN
      ALTER TABLE play_logs ADD COLUMN duration_sec NUMERIC(10,3);
    END IF;
    UPDATE play_logs SET duration_sec = _dur_int_old::NUMERIC(10,3) WHERE _dur_int_old IS NOT NULL;
    ALTER TABLE play_logs DROP COLUMN _dur_int_old;
    RAISE NOTICE 'play_logs: recovered from 009 partial run, duration_sec now NUMERIC(10,3)';
    RETURN;
  END IF;

  -- Normal path: check current type of duration_sec
  SELECT atttypid INTO col_typid
  FROM pg_attribute
  WHERE attrelid = 'play_logs'::regclass
    AND attname   = 'duration_sec'
    AND attnum    > 0
    AND NOT attisdropped;

  IF col_typid IS NULL THEN
    -- Column missing entirely — add it
    ALTER TABLE play_logs ADD COLUMN duration_sec NUMERIC(10,3);
    RAISE NOTICE 'play_logs.duration_sec did not exist — added as NUMERIC(10,3)';
    RETURN;
  END IF;

  -- OIDs: 23=int4, 21=int2, 20=int8, 1700=numeric, 700=float4, 701=float8
  IF col_typid IN (23, 21, 20) THEN
    ALTER TABLE play_logs ALTER COLUMN duration_sec TYPE NUMERIC(10,3)
      USING duration_sec::NUMERIC(10,3);
    RAISE NOTICE 'play_logs.duration_sec converted INTEGER(oid=%) -> NUMERIC(10,3)', col_typid;
  ELSE
    RAISE NOTICE 'play_logs.duration_sec already non-integer (oid=%), no action needed', col_typid;
  END IF;
END $$;

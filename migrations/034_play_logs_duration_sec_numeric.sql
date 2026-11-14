-- Ensure play_logs.duration_sec is NUMERIC(10,3) — idempotent
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'play_logs'::regclass
      AND attname = 'duration_sec'
      AND atttypid IN (23, 21, 20) -- int4, int2, int8
      AND attnum > 0
      AND NOT attisdropped
  ) THEN
    ALTER TABLE play_logs ALTER COLUMN duration_sec TYPE NUMERIC(10,3)
      USING duration_sec::NUMERIC(10,3);
    RAISE NOTICE 'play_logs.duration_sec converted to NUMERIC(10,3)';
  END IF;
END $$;

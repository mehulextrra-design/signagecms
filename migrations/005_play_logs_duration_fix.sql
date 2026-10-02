-- Fix play_logs.duration_sec: change from INTEGER to DECIMAL(10,3)
-- Railway DB had this as INTEGER so decimal values like 16.114 were rejected
-- USING clause safely converts existing integer data to decimal
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'play_logs'
      AND column_name = 'duration_sec'
      AND data_type IN ('integer', 'bigint', 'smallint')
  ) THEN
    ALTER TABLE play_logs
      ALTER COLUMN duration_sec TYPE DECIMAL(10,3)
      USING duration_sec::DECIMAL(10,3);
    RAISE NOTICE 'play_logs.duration_sec changed from INTEGER to DECIMAL(10,3)';
  ELSE
    -- Already decimal, just ensure sufficient precision
    ALTER TABLE play_logs ALTER COLUMN duration_sec TYPE DECIMAL(10,3);
    RAISE NOTICE 'play_logs.duration_sec precision updated to DECIMAL(10,3)';
  END IF;
END $$;

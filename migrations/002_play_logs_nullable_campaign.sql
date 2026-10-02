-- Make play_logs.campaign_id nullable so filler/venue plays can be logged
-- Filler and venue content have no real campaign_id
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'play_logs'
      AND column_name = 'campaign_id'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE play_logs ALTER COLUMN campaign_id DROP NOT NULL;
    RAISE NOTICE 'play_logs.campaign_id made nullable';
  END IF;
END $$;

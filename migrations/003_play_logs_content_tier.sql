-- Add content_tier column to play_logs (required by PoP endpoint)
-- Also ensure campaign_id is nullable and filler_content table exists
ALTER TABLE play_logs ADD COLUMN IF NOT EXISTS content_tier VARCHAR(20) DEFAULT 'paid';

-- Ensure campaign_id is nullable (filler/venue plays have no campaign_id)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'play_logs' AND column_name = 'campaign_id' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE play_logs ALTER COLUMN campaign_id DROP NOT NULL;
    RAISE NOTICE 'play_logs.campaign_id made nullable';
  END IF;
END $$;

-- Create filler_content if it does not exist (needed by schedule endpoint)
CREATE TABLE IF NOT EXISTS filler_content (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title         VARCHAR(200),
  file_url      VARCHAR(500) NOT NULL,
  type          VARCHAR(20) DEFAULT 'image',
  duration_sec  DECIMAL(10,3) DEFAULT 10,
  is_active     BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

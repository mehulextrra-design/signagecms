-- Add source column to play_logs to distinguish APK-reported vs server-generated logs
ALTER TABLE play_logs ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'apk';
-- Index for fast APK-log lookups (used by server-gen dedup check)
CREATE INDEX IF NOT EXISTS idx_play_logs_source ON play_logs(source);
CREATE INDEX IF NOT EXISTS idx_play_logs_screen_campaign_date ON play_logs(screen_id, campaign_id, (played_at::date));

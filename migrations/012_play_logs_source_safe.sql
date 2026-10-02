-- Safe retry: add source column only (no functional indexes that can fail on older PG versions)
ALTER TABLE play_logs ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'apk';

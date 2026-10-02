-- play_logs.content_id FK to content(id) blocks filler plays from being recorded.
-- Filler content lives in filler_content table, not content table.
-- Drop the FK so any UUID (paid content_id OR filler_content_id) can be stored.
ALTER TABLE play_logs DROP CONSTRAINT IF EXISTS play_logs_content_id_fkey;

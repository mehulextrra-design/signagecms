-- 029: Fix wa_contacts deduplication — migration 027 had CREATE INDEX before DELETE,
-- so if duplicates existed at deploy time the index was never created.
-- This migration safely deduplicates first, then ensures the index exists.

-- Step 1: Remove duplicates (keep lowest id per user_id+phone pair)
DELETE FROM wa_contacts a
USING wa_contacts b
WHERE a.id > b.id
  AND a.user_id = b.user_id
  AND a.phone   = b.phone;

-- Step 2: Create unique index (safe now — no duplicates remain)
CREATE UNIQUE INDEX IF NOT EXISTS wa_contacts_unique_phone
  ON wa_contacts(user_id, phone);

DO $$ BEGIN RAISE NOTICE '029: wa_contacts deduplicated and unique index ensured'; END $$;

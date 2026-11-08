-- 027: Add unique index on wa_contacts(user_id, phone)
-- Migration 025 only created a non-unique index; ON CONFLICT DO NOTHING
-- requires a unique constraint to prevent duplicate contact imports.

CREATE UNIQUE INDEX IF NOT EXISTS wa_contacts_unique_phone
  ON wa_contacts(user_id, phone);

-- Remove any existing duplicates first (keep the earliest record per pair)
DELETE FROM wa_contacts a
USING wa_contacts b
WHERE a.id > b.id
  AND a.user_id = b.user_id
  AND a.phone   = b.phone;

DO $$ BEGIN RAISE NOTICE '027: wa_contacts unique index on (user_id, phone) created'; END $$;

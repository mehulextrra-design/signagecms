-- 028: Add wa_caption_template to campaigns
-- Allows advertisers to customize the WhatsApp broadcast message
-- with variable placeholders like {{Name}}, {{Company Name}}, etc.

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS wa_caption_template TEXT;

DO $$ BEGIN RAISE NOTICE '028: wa_caption_template column added to campaigns'; END $$;

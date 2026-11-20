-- Capture the date when agreement status was first set (agreement_pending)
-- This prevents the date from changing on every agreement re-generation
ALTER TABLE leads ADD COLUMN IF NOT EXISTS agreement_date TIMESTAMPTZ;

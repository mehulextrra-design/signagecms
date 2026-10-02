-- Add slot_duration_sec to campaigns (10/15/20/30 seconds based on package)
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS slot_duration_sec INTEGER DEFAULT 15;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS package_name VARCHAR(20) DEFAULT 'regular';

-- Add duration_sec to content (video duration extracted at upload time)
ALTER TABLE content ADD COLUMN IF NOT EXISTS duration_sec DECIMAL(10,3);

-- Update existing campaigns: infer slot from content duration where possible
-- (safe default of 15s for all existing campaigns)
UPDATE campaigns SET slot_duration_sec = 15, package_name = 'regular'
  WHERE slot_duration_sec IS NULL OR slot_duration_sec = 0;

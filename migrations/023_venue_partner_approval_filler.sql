-- 023: Venue partner approval flow + filler quota
ALTER TABLE venue_partners
  ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS filler_quota_sec INT NOT NULL DEFAULT 3600,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- Existing active partners are already onboarded → auto-approve them
UPDATE venue_partners SET approval_status = 'approved' WHERE is_active = true;

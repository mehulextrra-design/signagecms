-- Add approval workflow for venue partner content
ALTER TABLE content
  ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS approval_note   TEXT;

-- Existing content stays approved; index for admin queue
CREATE INDEX IF NOT EXISTS idx_content_approval ON content(approval_status) WHERE approval_status = 'pending_review';

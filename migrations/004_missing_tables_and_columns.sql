-- ── WALLET SYSTEM ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_wallets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  balance     NUMERIC(12,2) NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  type        VARCHAR(30) NOT NULL,
  amount      NUMERIC(12,2) NOT NULL,
  campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
  description TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── SCREEN GROUPS ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS screen_groups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS screen_group_members (
  group_id  UUID REFERENCES screen_groups(id) ON DELETE CASCADE,
  screen_id UUID REFERENCES screens(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, screen_id)
);

-- ── QR SCANS ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS qr_scans (
  id           SERIAL PRIMARY KEY,
  campaign_id  UUID REFERENCES campaigns(id) ON DELETE CASCADE,
  scanned_at   TIMESTAMPTZ DEFAULT NOW(),
  ip           VARCHAR(50),
  user_agent   TEXT
);

-- ── VENUE PARTNER NETWORK ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS venue_partners (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID REFERENCES users(id) ON DELETE SET NULL,
  business_name     VARCHAR(200) NOT NULL,
  venue_category    VARCHAR(50) NOT NULL DEFAULT 'other',
  revenue_share_pct DECIMAL(5,2) NOT NULL DEFAULT 30.0,
  city              VARCHAR(100),
  address           TEXT,
  contact_name      VARCHAR(100),
  contact_phone     VARCHAR(20),
  is_active         BOOLEAN DEFAULT TRUE,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS venue_revenue_logs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_partner_id UUID NOT NULL REFERENCES venue_partners(id),
  screen_id        UUID NOT NULL REFERENCES screens(id),
  campaign_id      UUID NOT NULL REFERENCES campaigns(id),
  date             DATE NOT NULL,
  plays_count      INT DEFAULT 0,
  gross_amount     DECIMAL(10,2) DEFAULT 0,
  venue_share      DECIMAL(10,2) DEFAULT 0,
  platform_share   DECIMAL(10,2) DEFAULT 0,
  settled          BOOLEAN DEFAULT FALSE,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(venue_partner_id, screen_id, campaign_id, date)
);

-- ── IMPRESSION CREDITS ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS impression_credits (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id      UUID NOT NULL REFERENCES campaigns(id),
  date             DATE NOT NULL,
  expected_plays   INT NOT NULL,
  actual_plays     INT NOT NULL,
  shortfall_plays  INT NOT NULL,
  credit_amount    DECIMAL(10,2) NOT NULL,
  credited_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(campaign_id, date)
);

-- ── CAMPAIGNS: additional columns ────────────────────────────────────────────
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS daily_rate NUMERIC(10,2) DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS amount_spent NUMERIC(10,2) DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS last_resumed_at TIMESTAMPTZ;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS pause_started_at TIMESTAMPTZ;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS pending_content_id UUID REFERENCES content(id);
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS creative_change_status VARCHAR(20);
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS creative_change_requested_at TIMESTAMPTZ;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS qr_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS qr_placement VARCHAR(20) DEFAULT 'bot-right';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS qr_phone VARCHAR(20);
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS qr_image_public_id VARCHAR(255);
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS qr_content_url TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS expected_plays_per_day INT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS booking_screen_count INT DEFAULT 0;

-- ── SCREENS: additional columns ───────────────────────────────────────────────
ALTER TABLE screens ADD COLUMN IF NOT EXISTS audio_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE screens ADD COLUMN IF NOT EXISTS venue_partner_id UUID REFERENCES venue_partners(id) ON DELETE SET NULL;
ALTER TABLE screens ADD COLUMN IF NOT EXISTS paid_pct      INT DEFAULT 75;
ALTER TABLE screens ADD COLUMN IF NOT EXISTS venue_own_pct INT DEFAULT 15;
ALTER TABLE screens ADD COLUMN IF NOT EXISTS cross_pct     INT DEFAULT 8;
ALTER TABLE screens ADD COLUMN IF NOT EXISTS blocked_categories TEXT[] DEFAULT '{}';

-- ── CONTENT: content_tier column ─────────────────────────────────────────────
ALTER TABLE content ADD COLUMN IF NOT EXISTS content_tier VARCHAR(20) DEFAULT 'paid';

-- ── USERS: venue_partner_id column ───────────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS venue_partner_id UUID REFERENCES venue_partners(id) ON DELETE SET NULL;

-- ── Fix duration_sec precision ────────────────────────────────────────────────
ALTER TABLE content ALTER COLUMN duration_sec TYPE DECIMAL(10,3);

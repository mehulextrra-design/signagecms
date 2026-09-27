-- SignageCMS — Initial Schema
-- Run: psql -U postgres -d signagecms -f migrations/001_initial_schema.sql

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── USERS (advertisers + admins) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role          VARCHAR(20) NOT NULL DEFAULT 'advertiser', -- advertiser | admin | superadmin
  first_name    VARCHAR(100),
  last_name     VARCHAR(100),
  mobile        VARCHAR(20),
  business_name VARCHAR(200),
  business_type VARCHAR(100),
  gst_number    VARCHAR(20),
  pan_number    VARCHAR(15),
  city          VARCHAR(100),
  is_verified   BOOLEAN DEFAULT FALSE,
  is_active     BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── SCREENS ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS screens (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  screen_code     VARCHAR(20) UNIQUE NOT NULL,  -- e.g. PHX-001
  name            VARCHAR(200) NOT NULL,
  location        VARCHAR(300),
  city            VARCHAR(100),
  zone            VARCHAR(20) DEFAULT 'A',       -- A | B | C
  latitude        DECIMAL(10,8),
  longitude       DECIMAL(11,8),
  width_px        INT DEFAULT 1920,
  height_px       INT DEFAULT 1080,
  status          VARCHAR(20) DEFAULT 'online',  -- online | offline | maintenance
  device_token    VARCHAR(255) UNIQUE,           -- player APK registration token
  last_heartbeat  TIMESTAMPTZ,
  price_per_day   DECIMAL(10,2) DEFAULT 900.00,
  daily_impressions INT DEFAULT 5000,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── CONTENT (uploaded files) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS content (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  original_name VARCHAR(300) NOT NULL,
  stored_name   VARCHAR(300) NOT NULL,
  file_path     VARCHAR(500) NOT NULL,
  file_url      VARCHAR(500),
  mime_type     VARCHAR(100),
  file_size     BIGINT,  -- bytes
  width_px      INT,
  height_px     INT,
  duration_sec  DECIMAL(6,2),  -- for video
  type          VARCHAR(20),   -- video | image
  status        VARCHAR(20) DEFAULT 'active',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── CAMPAIGNS ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS campaigns (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  campaign_code   VARCHAR(20) UNIQUE NOT NULL,  -- e.g. CMP-0089
  user_id         UUID NOT NULL REFERENCES users(id),
  content_id      UUID REFERENCES content(id),
  title           VARCHAR(300) NOT NULL,
  start_date      DATE NOT NULL,
  end_date        DATE NOT NULL,
  start_time      TIME DEFAULT '00:00:00',
  end_time        TIME DEFAULT '23:59:59',
  status          VARCHAR(30) DEFAULT 'pending_payment',
  -- pending_payment | pending_approval | approved | live | paused | completed | cancelled | rejected
  payment_status  VARCHAR(20) DEFAULT 'pending',  -- pending | paid | refunded | partial_refund
  amount_base     DECIMAL(10,2),
  amount_gst      DECIMAL(10,2),
  amount_total    DECIMAL(10,2),
  coupon_code     VARCHAR(20),
  discount_amount DECIMAL(10,2) DEFAULT 0,
  rejection_reason TEXT,
  approved_by     UUID REFERENCES users(id),
  approved_at     TIMESTAMPTZ,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── CAMPAIGN_SCREENS (many-to-many) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS campaign_screens (
  campaign_id   UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  screen_id     UUID NOT NULL REFERENCES screens(id),
  PRIMARY KEY (campaign_id, screen_id)
);

-- ── SLOTS (free slots issued as compensation) ─────────────────────────────
CREATE TABLE IF NOT EXISTS slots (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id),
  screen_id       UUID REFERENCES screens(id),
  days            INT NOT NULL,
  reason          VARCHAR(200),
  campaign_id     UUID REFERENCES campaigns(id),
  is_used         BOOLEAN DEFAULT FALSE,
  used_at         TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,
  issued_by       UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── INVOICES ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_number  VARCHAR(30) UNIQUE NOT NULL,  -- e.g. INV-0089
  campaign_id     UUID NOT NULL REFERENCES campaigns(id),
  user_id         UUID NOT NULL REFERENCES users(id),
  amount_base     DECIMAL(10,2) NOT NULL,
  amount_gst      DECIMAL(10,2) NOT NULL,
  amount_total    DECIMAL(10,2) NOT NULL,
  payment_id      VARCHAR(100),  -- Razorpay payment ID
  payment_method  VARCHAR(50),
  status          VARCHAR(20) DEFAULT 'paid',  -- paid | pending | refunded
  gst_number      VARCHAR(20),
  issued_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ── PROOF OF PLAY ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS play_logs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  screen_id     UUID NOT NULL REFERENCES screens(id),
  campaign_id   UUID NOT NULL REFERENCES campaigns(id),
  content_id    UUID REFERENCES content(id),
  played_at     TIMESTAMPTZ NOT NULL,
  duration_sec  DECIMAL(6,2),
  play_count    INT DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_play_logs_campaign ON play_logs(campaign_id);
CREATE INDEX IF NOT EXISTS idx_play_logs_screen ON play_logs(screen_id);
CREATE INDEX IF NOT EXISTS idx_play_logs_played_at ON play_logs(played_at);

-- ── SCREEN HEARTBEATS ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS heartbeats (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  screen_id   UUID NOT NULL REFERENCES screens(id),
  ip_address  VARCHAR(50),
  app_version VARCHAR(20),
  android_ver VARCHAR(20),
  uptime_sec  BIGINT,
  is_playing  BOOLEAN DEFAULT FALSE,
  current_campaign_id UUID REFERENCES campaigns(id),
  received_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_heartbeats_screen ON heartbeats(screen_id);

-- ── ACTIVITY LOG ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS activity_log (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID REFERENCES users(id),
  action      VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50),
  entity_id   UUID,
  details     JSONB,
  ip_address  VARCHAR(50),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_log_user ON activity_log(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log(created_at);

-- ── COUPONS ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coupons (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code          VARCHAR(30) UNIQUE NOT NULL,
  type          VARCHAR(20) NOT NULL,  -- percent | flat
  value         DECIMAL(10,2) NOT NULL,
  min_order     DECIMAL(10,2) DEFAULT 0,
  max_discount  DECIMAL(10,2),
  usage_limit   INT,
  used_count    INT DEFAULT 0,
  valid_from    DATE NOT NULL,
  valid_until   DATE NOT NULL,
  is_active     BOOLEAN DEFAULT TRUE,
  description   VARCHAR(300),
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── NOTIFICATIONS ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id),
  title       VARCHAR(200) NOT NULL,
  body        TEXT,
  type        VARCHAR(50),  -- info | warning | success | action_required
  is_read     BOOLEAN DEFAULT FALSE,
  action_url  VARCHAR(300),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);

-- ── SEED: admin user ──────────────────────────────────────────────────────
-- Password: Admin@123
INSERT INTO users (email, password_hash, role, first_name, last_name, is_verified, is_active)
VALUES (
  'admin@signagecms.in',
  '$2a$10$n0xZxZPBVjOj66S2sjW2mOI2bxN3WlJZo8FA5zw3oY.rC4PC6A/Lu',
  'superadmin', 'Platform', 'Admin', TRUE, TRUE
) ON CONFLICT (email) DO UPDATE SET password_hash='$2a$10$n0xZxZPBVjOj66S2sjW2mOI2bxN3WlJZo8FA5zw3oY.rC4PC6A/Lu', is_active=TRUE;

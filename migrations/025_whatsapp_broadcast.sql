-- 025: WhatsApp broadcast feature
-- wa_enabled per user, session storage, contacts, broadcast log

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS wa_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS wa_broadcast_enabled BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS wa_sessions (
  id           SERIAL PRIMARY KEY,
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  auth_state   JSONB NOT NULL DEFAULT '{}',
  status       VARCHAR(20) NOT NULL DEFAULT 'disconnected',
  phone_number VARCHAR(20),
  connected_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id)
);

CREATE TABLE IF NOT EXISTS wa_contacts (
  id         SERIAL PRIMARY KEY,
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  name       VARCHAR(100),
  phone      VARCHAR(20) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS wa_contacts_user_idx ON wa_contacts(user_id);

CREATE TABLE IF NOT EXISTS wa_broadcasts (
  id             SERIAL PRIMARY KEY,
  campaign_id    UUID REFERENCES campaigns(id) ON DELETE SET NULL,
  user_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  total_contacts INTEGER NOT NULL DEFAULT 0,
  sent_count     INTEGER NOT NULL DEFAULT 0,
  failed_count   INTEGER NOT NULL DEFAULT 0,
  status         VARCHAR(20) NOT NULL DEFAULT 'pending',
  started_at     TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ
);

DO $$ BEGIN RAISE NOTICE '025: wa_enabled, wa_sessions, wa_contacts, wa_broadcasts created'; END $$;

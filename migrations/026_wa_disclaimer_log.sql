-- 026: WhatsApp disclaimer acceptance audit log
-- Stores every acceptance with timestamp, IP, user-agent, and disclaimer version
-- for legal evidence if challenged

CREATE TABLE IF NOT EXISTS wa_disclaimer_acceptances (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  accepted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address       VARCHAR(45),          -- IPv4 or IPv6
  user_agent       TEXT,
  disclaimer_version VARCHAR(20) NOT NULL DEFAULT 'v1'
);

CREATE INDEX IF NOT EXISTS wa_disclaimer_user_idx ON wa_disclaimer_acceptances(user_id);
CREATE INDEX IF NOT EXISTS wa_disclaimer_time_idx  ON wa_disclaimer_acceptances(accepted_at);

DO $$ BEGIN RAISE NOTICE '026: wa_disclaimer_acceptances table created'; END $$;

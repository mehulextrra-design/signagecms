-- 030: Per-contact WA broadcast message tracking
-- Stores Baileys msgId per contact so ACK events (delivered/read) can update status.

CREATE TABLE IF NOT EXISTS wa_broadcast_messages (
  id           SERIAL PRIMARY KEY,
  broadcast_id INTEGER REFERENCES wa_broadcasts(id) ON DELETE CASCADE,
  message_id   TEXT NOT NULL,        -- Baileys key.id (unique per message)
  phone        VARCHAR(20) NOT NULL,
  contact_name VARCHAR(100),
  status       SMALLINT NOT NULL DEFAULT 1, -- 0=failed 1=sent 3=delivered 4=read
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  read_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS wa_bcast_msg_broadcast_idx ON wa_broadcast_messages(broadcast_id);
CREATE INDEX IF NOT EXISTS wa_bcast_msg_msgid_idx     ON wa_broadcast_messages(message_id);

DO $$ BEGIN RAISE NOTICE '030: wa_broadcast_messages table created'; END $$;

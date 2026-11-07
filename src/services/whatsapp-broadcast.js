/**
 * WhatsApp Broadcast Service (Baileys)
 * Advertisers connect their own WA number via pairing code.
 * Session creds stored in wa_sessions (PostgreSQL JSONB).
 * On campaign live → broadcast image + caption to imported contacts.
 */

const { query } = require('../db');

// Ensure WA tables exist on first use (failsafe if migrations didn't run)
let _tablesEnsured = false;
async function ensureWaTables() {
  if (_tablesEnsured) return;

  // Check if wa_sessions exists and has correct UUID type
  const col = await query(`
    SELECT data_type FROM information_schema.columns
    WHERE table_name='wa_sessions' AND column_name='user_id'
  `);

  if (col.rows.length > 0 && col.rows[0].data_type === 'integer') {
    // One-time migration: old tables had INTEGER user_id, need to recreate with UUID
    // Safe because no valid data was ever inserted (all prior inserts failed with type errors)
    console.log('[WA] Migrating INTEGER tables to UUID...');
    await query(`DELETE FROM wa_broadcasts WHERE 1=1`);
    await query(`DELETE FROM wa_disclaimer_acceptances WHERE 1=1`);
    await query(`DELETE FROM wa_contacts WHERE 1=1`);
    await query(`DELETE FROM wa_sessions WHERE 1=1`);
    await query(`ALTER TABLE wa_sessions ALTER COLUMN user_id TYPE UUID USING NULL`);
    await query(`ALTER TABLE wa_contacts ALTER COLUMN user_id TYPE UUID USING NULL`);
    await query(`ALTER TABLE wa_broadcasts ALTER COLUMN user_id TYPE UUID USING NULL`);
    await query(`ALTER TABLE wa_broadcasts ALTER COLUMN campaign_id TYPE UUID USING NULL`);
    await query(`ALTER TABLE wa_disclaimer_acceptances ALTER COLUMN user_id TYPE UUID USING NULL`);
    console.log('[WA] Migration to UUID done');
  } else if (col.rows.length === 0) {
    // Tables don't exist yet — create fresh with UUID
    await query(`CREATE TABLE IF NOT EXISTS wa_sessions (
      id           SERIAL PRIMARY KEY,
      user_id      UUID,
      auth_state   JSONB NOT NULL DEFAULT '{}',
      status       VARCHAR(20) NOT NULL DEFAULT 'disconnected',
      phone_number VARCHAR(20),
      connected_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_id)
    )`);
    await query(`CREATE TABLE IF NOT EXISTS wa_contacts (
      id         SERIAL PRIMARY KEY,
      user_id    UUID,
      name       VARCHAR(100),
      phone      VARCHAR(20) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await query(`CREATE INDEX IF NOT EXISTS wa_contacts_user_idx ON wa_contacts(user_id)`);
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS wa_contacts_unique_phone ON wa_contacts(user_id, phone)`);
    await query(`CREATE TABLE IF NOT EXISTS wa_broadcasts (
      id             SERIAL PRIMARY KEY,
      campaign_id    UUID,
      user_id        UUID,
      total_contacts INTEGER NOT NULL DEFAULT 0,
      sent_count     INTEGER NOT NULL DEFAULT 0,
      failed_count   INTEGER NOT NULL DEFAULT 0,
      status         VARCHAR(20) NOT NULL DEFAULT 'pending',
      started_at     TIMESTAMPTZ,
      completed_at   TIMESTAMPTZ
    )`);
    await query(`CREATE TABLE IF NOT EXISTS wa_disclaimer_acceptances (
      id                 SERIAL PRIMARY KEY,
      user_id            UUID,
      accepted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ip_address         VARCHAR(45),
      user_agent         TEXT,
      disclaimer_version VARCHAR(20) NOT NULL DEFAULT 'v1'
    )`);
    console.log('[WA] Tables created with UUID user_id');
  }
  // else: tables already exist with correct UUID type — nothing to do

  _tablesEnsured = true;
}

const BROADCAST_CONFIG = {
  delayMs:        4000,  // 4s between messages
  maxPerCampaign: 300,   // max contacts per broadcast
  retryFailed:    1,     // retries per failed number
};

// In-memory map of active Baileys sockets per user
const activeSockets = new Map();

// ── Baileys dynamic import (ESM module in CJS project) ─────────────────────

async function baileys() {
  const mod = await import('@whiskeysockets/baileys');
  return mod;
}

// ── PostgreSQL auth state (persist creds across restarts) ──────────────────

async function makePostgresAuthState(userId) {
  const mod = await baileys();
  // BufferJSON is a top-level export, not nested under proto
  const { BufferJSON } = mod;

  async function readData(key) {
    const r = await query(
      `SELECT auth_state->$2 AS val FROM wa_sessions WHERE user_id=$1`,
      [userId, key]
    );
    if (!r.rows.length || r.rows[0].val == null) return null;
    const val = r.rows[0].val;
    // Revive {type:'Buffer',data:[...]} objects back to Buffer instances
    return JSON.parse(JSON.stringify(val), BufferJSON.reviver);
  }

  async function writeData(key, value) {
    const serialized = JSON.stringify(value, BufferJSON.replacer);
    await query(
      `INSERT INTO wa_sessions (user_id, auth_state, status, updated_at)
       VALUES ($1, jsonb_build_object($2::text, $3::jsonb), 'connected', NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET auth_state = wa_sessions.auth_state || jsonb_build_object($2::text, $3::jsonb),
             status = 'connected',
             updated_at = NOW()`,
      [userId, key, serialized]
    );
  }

  async function removeData(key) {
    await query(
      `UPDATE wa_sessions SET auth_state = auth_state - $2, updated_at=NOW()
       WHERE user_id=$1`,
      [userId, key]
    );
  }

  async function getAllKeys() {
    const r = await query(
      `SELECT auth_state FROM wa_sessions WHERE user_id=$1`,
      [userId]
    );
    if (!r.rows.length || !r.rows[0].auth_state) return {};
    return r.rows[0].auth_state;
  }

  const { initAuthCreds } = mod;

  // Load or init creds
  let creds;
  const rawCreds = await readData('creds');
  creds = rawCreds ?? initAuthCreds();

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const data = {};
        for (const id of ids) {
          const val = await readData(`key:${type}:${id}`);
          if (val) data[id] = val;
        }
        return data;
      },
      set: async (data) => {
        for (const [type, entries] of Object.entries(data)) {
          for (const [id, value] of Object.entries(entries || {})) {
            if (value) await writeData(`key:${type}:${id}`, value);
            else await removeData(`key:${type}:${id}`);
          }
        }
      },
    },
  };

  async function saveCreds() {
    await writeData('creds', state.creds);
  }

  return { state, saveCreds };
}

// ── Session init ────────────────────────────────────────────────────────────

async function initSession(userId) {
  if (activeSockets.has(userId)) return activeSockets.get(userId);

  const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion } = await baileys();
  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await makePostgresAuthState(userId);

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['ExtrraVenue', 'Chrome', '1.0'],
    getMessage: async () => ({ conversation: '' }),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      activeSockets.delete(userId);
      await query(
        `UPDATE wa_sessions SET status=$2, updated_at=NOW() WHERE user_id=$1`,
        [userId, shouldReconnect ? 'disconnected' : 'logged_out']
      );
      if (shouldReconnect) {
        setTimeout(() => initSession(userId).catch(() => {}), 10000);
      }
    } else if (connection === 'open') {
      await query(
        `UPDATE wa_sessions SET status='connected', updated_at=NOW() WHERE user_id=$1`,
        [userId]
      );
      console.log(`[WA] User ${userId} connected`);
    }
  });

  activeSockets.set(userId, sock);
  return sock;
}

// ── Pairing code flow ───────────────────────────────────────────────────────

async function requestPairingCode(userId, phoneNumber) {
  await ensureWaTables();

  // Clear any stale socket so we get a fresh connection with current DB creds
  if (activeSockets.has(userId)) {
    try { activeSockets.get(userId).end(); } catch (_) {}
    activeSockets.delete(userId);
  }

  // Reset to pending so status polling works correctly
  await query(
    `INSERT INTO wa_sessions (user_id, auth_state, status, phone_number)
     VALUES ($1, '{}', 'pending', $2)
     ON CONFLICT (user_id) DO UPDATE
       SET status='pending', phone_number=$2, auth_state='{}', updated_at=NOW()`,
    [userId, phoneNumber]
  );

  const sock = await initSession(userId);

  // Wait briefly for socket handshake
  await new Promise(r => setTimeout(r, 1500));

  // Per official Baileys docs: only request pairing code when NOT already registered
  if (sock.authState.creds.registered) {
    // Creds already valid — socket will auto-connect, no code needed
    return null;
  }

  let digits = phoneNumber.replace(/\D/g, '');
  if (digits.length === 10) digits = '91' + digits;
  const code = await sock.requestPairingCode(digits);
  return code;
}

// ── Status ──────────────────────────────────────────────────────────────────

async function getSessionStatus(userId) {
  await ensureWaTables();
  const r = await query(
    `SELECT status, phone_number FROM wa_sessions WHERE user_id=$1`,
    [userId]
  );
  if (!r.rows.length) return { status: 'not_connected', phone_number: null };
  return r.rows[0];
}

// ── Disconnect ──────────────────────────────────────────────────────────────

async function disconnectSession(userId) {
  const sock = activeSockets.get(userId);
  if (sock) {
    try { await sock.logout(); } catch (_) {}
    activeSockets.delete(userId);
  }
  await query(
    `UPDATE wa_sessions SET status='logged_out', auth_state='{}', updated_at=NOW()
     WHERE user_id=$1`,
    [userId]
  );
}

// ── Send single message ─────────────────────────────────────────────────────

async function sendMessage(sock, phone, imageUrl, caption) {
  const jid = phone.replace(/\D/g, '') + '@s.whatsapp.net';
  await sock.sendMessage(jid, { image: { url: imageUrl }, caption });
}

// ── Broadcast ───────────────────────────────────────────────────────────────

async function sendWaBroadcast(campaignId) {
  await ensureWaTables();
  // Get campaign + user
  const campResult = await query(
    `SELECT c.id, c.user_id, c.name, c.caption, c.wa_broadcast_enabled,
            u.wa_enabled,
            con.media_url AS image_url, u.business_name
     FROM campaigns c
     JOIN users u ON u.id = c.user_id
     LEFT JOIN content con ON con.id = c.content_id
     WHERE c.id = $1`,
    [campaignId]
  );
  if (!campResult.rows.length) return;

  const camp = campResult.rows[0];

  // Guard: feature must be enabled for this user, and campaign opted-in
  if (!camp.wa_enabled) return;
  if (!camp.wa_broadcast_enabled) return;
  if (!camp.image_url) return;

  const userId = camp.user_id;

  // Guard: active session required
  const { status } = await getSessionStatus(userId);
  if (status !== 'connected') return;

  // Load contacts
  const contactsResult = await query(
    `SELECT phone, name FROM wa_contacts WHERE user_id=$1 LIMIT $2`,
    [userId, BROADCAST_CONFIG.maxPerCampaign]
  );
  if (!contactsResult.rows.length) return;

  const contacts = contactsResult.rows;

  // Create broadcast record
  const broadcastResult = await query(
    `INSERT INTO wa_broadcasts (campaign_id, user_id, total_contacts, status, started_at)
     VALUES ($1, $2, $3, 'running', NOW())
     RETURNING id`,
    [campaignId, userId, contacts.length]
  );
  const broadcastId = broadcastResult.rows[0].id;

  const sock = await initSession(userId);

  const caption = `🎉 ${camp.name}\n\n${camp.caption || ''}\n\n📍 ${camp.business_name || 'ExtrraVenue'}\n🔗 extrravenue.com`;

  let sent = 0, failed = 0;

  for (const contact of contacts) {
    try {
      await sendMessage(sock, contact.phone, camp.image_url, caption);
      sent++;
    } catch (err) {
      console.error(`[WA Broadcast] Failed to send to ${contact.phone}:`, err.message);
      // One retry
      try {
        await new Promise(r => setTimeout(r, 2000));
        await sendMessage(sock, contact.phone, camp.image_url, caption);
        sent++;
      } catch (_) {
        failed++;
      }
    }

    await new Promise(r => setTimeout(r, BROADCAST_CONFIG.delayMs));
  }

  await query(
    `UPDATE wa_broadcasts
     SET sent_count=$2, failed_count=$3, status='done', completed_at=NOW()
     WHERE id=$1`,
    [broadcastId, sent, failed]
  );

  console.log(`[WA Broadcast] Campaign ${campaignId}: ${sent} sent, ${failed} failed`);
}

// ── Restore sessions on startup ─────────────────────────────────────────────

async function restoreActiveSessions() {
  try {
    await ensureWaTables();
    const r = await query(
      `SELECT user_id FROM wa_sessions WHERE status='connected'`
    );
    for (const row of r.rows) {
      initSession(row.user_id).catch(e =>
        console.error(`[WA] Restore session user ${row.user_id}:`, e.message)
      );
    }
    if (r.rows.length) console.log(`[WA] Restoring ${r.rows.length} session(s)`);
  } catch (e) {
    console.error('[WA] restoreActiveSessions error:', e.message);
  }
}

module.exports = {
  requestPairingCode,
  getSessionStatus,
  disconnectSession,
  sendWaBroadcast,
  restoreActiveSessions,
  ensureWaTables,
};

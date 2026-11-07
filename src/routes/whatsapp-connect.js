/**
 * WhatsApp Connect Routes
 * All routes require authentication; advertiser-facing only (not admin-only).
 * Admin can toggle wa_enabled per user via PUT /api/users/:id/wa-toggle.
 */

const express = require('express');
const multer  = require('multer');
const csv     = require('csv-parse/sync');
const { query } = require('../db');
const { authenticate } = require('../middleware/auth');
const {
  requestPairingCode,
  getSessionStatus,
  disconnectSession,
  ensureWaTables,
} = require('../services/whatsapp-broadcast');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ── Guard: wa_enabled must be true for this user ────────────────────────────

async function requireWaEnabled(req, res, next) {
  const r = await query(`SELECT wa_enabled FROM users WHERE id=$1`, [req.user.id]);
  if (!r.rows.length || !r.rows[0].wa_enabled) {
    return res.status(403).json({ error: 'WhatsApp feature not enabled for your account' });
  }
  next();
}

// POST /api/wa/disclaimer-accept  — log user's acceptance for legal audit
// Called BEFORE connect; no wa_enabled guard needed (just auth)
router.post('/disclaimer-accept', authenticate, async (req, res) => {
  try {
    await ensureWaTables();
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const ua = req.headers['user-agent'] || '';
    const version = req.body.version || 'v1';
    await query(
      `INSERT INTO wa_disclaimer_acceptances (user_id, ip_address, user_agent, disclaimer_version)
       VALUES ($1,$2,$3,$4)`,
      [req.user.id, ip, ua, version]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[WA] disclaimer log error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/wa/connect  — request pairing code
router.post('/connect', authenticate, requireWaEnabled, async (req, res) => {
  try {
    const { phone_number } = req.body;
    if (!phone_number) return res.status(400).json({ error: 'phone_number required' });

    const digits = phone_number.replace(/\D/g, '');
    if (digits.length < 10) return res.status(400).json({ error: 'Invalid phone number' });

    const code = await requestPairingCode(req.user.id, digits);
    res.json({ code });
  } catch (err) {
    console.error('[WA] connect error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/wa/status
router.get('/status', authenticate, requireWaEnabled, async (req, res) => {
  try {
    const status = await getSessionStatus(req.user.id);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/wa/disconnect
router.post('/disconnect', authenticate, requireWaEnabled, async (req, res) => {
  try {
    await disconnectSession(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/wa/contacts/import  — CSV upload (Name,Phone columns)
router.post('/contacts/import', authenticate, requireWaEnabled, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'CSV file required' });

    const records = csv.parse(req.file.buffer.toString(), {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    if (!records.length) return res.status(400).json({ error: 'No records found in CSV' });

    // Accept columns: Name/name/NAME, Phone/phone/PHONE/mobile/Mobile/number/Number
    let imported = 0;
    for (const row of records) {
      const name  = row.Name || row.name || row.NAME || null;
      const phone = (row.Phone || row.phone || row.PHONE || row.mobile || row.Mobile || row.number || row.Number || '').replace(/\D/g, '');
      if (!phone || phone.length < 10) continue;

      await query(
        `INSERT INTO wa_contacts (user_id, name, phone)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [req.user.id, name, phone]
      );
      imported++;
    }

    res.json({ imported, total: records.length });
  } catch (err) {
    console.error('[WA] contacts import error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/wa/contacts  — add single OR bulk contacts
// Single: {name, phone}   Bulk: {contacts: [{name, phone}]}
router.post('/contacts', authenticate, requireWaEnabled, async (req, res) => {
  try {
    await ensureWaTables();

    // Bulk insert (mobile contact picker)
    if (Array.isArray(req.body.contacts)) {
      let added = 0;
      for (const c of req.body.contacts) {
        const digits = (c.phone || '').replace(/\D/g, '');
        if (!digits || digits.length < 10) continue;
        await query(
          `INSERT INTO wa_contacts (user_id, name, phone) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [req.user.id, c.name || null, digits]
        );
        added++;
      }
      return res.json({ ok: true, added });
    }

    // Single insert
    const { name, phone } = req.body;
    const digits = (phone || '').replace(/\D/g, '');
    if (!digits || digits.length < 10) return res.status(400).json({ error: 'Invalid phone number' });
    await query(
      `INSERT INTO wa_contacts (user_id, name, phone) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [req.user.id, name || null, digits]
    );
    res.json({ ok: true, added: 1 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/wa/contacts
router.get('/contacts', authenticate, requireWaEnabled, async (req, res) => {
  try {
    await ensureWaTables();
    const r = await query(
      `SELECT id, name, phone, created_at FROM wa_contacts
       WHERE user_id=$1 ORDER BY created_at DESC LIMIT 500`,
      [req.user.id]
    );
    res.json({ contacts: r.rows, total: r.rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/wa/contacts  — clear all
router.delete('/contacts', authenticate, requireWaEnabled, async (req, res) => {
  try {
    await query(`DELETE FROM wa_contacts WHERE user_id=$1`, [req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/wa/contacts/:id  — remove one
router.delete('/contacts/:id', authenticate, requireWaEnabled, async (req, res) => {
  try {
    await query(`DELETE FROM wa_contacts WHERE id=$1 AND user_id=$2`, [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/wa/broadcast/:campaignId  — broadcast status
router.get('/broadcast/:campaignId', authenticate, requireWaEnabled, async (req, res) => {
  try {
    const r = await query(
      `SELECT id, total_contacts, sent_count, failed_count, status, started_at, completed_at
       FROM wa_broadcasts
       WHERE campaign_id=$1 AND user_id=$2
       ORDER BY id DESC LIMIT 1`,
      [req.params.campaignId, req.user.id]
    );
    res.json(r.rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

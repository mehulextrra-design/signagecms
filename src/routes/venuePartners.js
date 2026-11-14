const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// ── LIST all venue partners (admin) ──────────────────────────────────────────
router.get('/', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const result = await query(`
      SELECT vp.*,
        u.email, u.is_active AS user_active,
        COUNT(DISTINCT s.id) AS screen_count,
        COALESCE(SUM(vrl.venue_share),0) AS total_revenue_earned
      FROM venue_partners vp
      LEFT JOIN users u ON u.id = vp.user_id
      LEFT JOIN screens s ON s.venue_partner_id = vp.id
      LEFT JOIN venue_revenue_logs vrl ON vrl.venue_partner_id = vp.id
      GROUP BY vp.id, u.email, u.is_active
      ORDER BY vp.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) { next(err); }
});

// ── APPROVE venue partner (admin) ────────────────────────────────────────────
router.post('/:id/approve', authenticate, requireAdmin, async (req, res, next) => {
  const { filler_quota_sec } = req.body;
  try {
    const result = await query(
      `UPDATE venue_partners SET
         approval_status = 'approved',
         is_active = true,
         approved_at = NOW(),
         approved_by = $2
         ${filler_quota_sec != null ? ', filler_quota_sec = $3' : ''}
       WHERE id = $1 RETURNING *`,
      filler_quota_sec != null
        ? [req.params.id, req.user.id, parseInt(filler_quota_sec)]
        : [req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    // Activate the linked user account
    await query('UPDATE users SET is_active = true WHERE venue_partner_id = $1', [req.params.id]);
    res.json({ ok: true, ...result.rows[0] });
  } catch (err) { next(err); }
});

// ── REJECT venue partner (admin) ─────────────────────────────────────────────
router.post('/:id/reject', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const result = await query(
      `UPDATE venue_partners SET approval_status = 'rejected', is_active = false WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    await query('UPDATE users SET is_active = false WHERE venue_partner_id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── GET single venue partner ──────────────────────────────────────────────────
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const vp = await query(
      `SELECT vp.*, u.email,
         (SELECT agreement_date FROM leads WHERE venue_partner_id = vp.id
          ORDER BY agreement_date DESC NULLS LAST LIMIT 1) AS agreement_date
       FROM venue_partners vp
       LEFT JOIN users u ON u.id = vp.user_id
       WHERE vp.id = $1`, [req.params.id]
    );
    if (!vp.rows.length) return res.status(404).json({ error: 'Venue partner not found' });

    // Check access: admin OR the venue partner themselves
    const row = vp.rows[0];
    if (!['admin','superadmin'].includes(req.user.role) && req.user.venue_partner_id !== req.params.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const screens = await query(
      `SELECT id, screen_code, name, location, city, status, paid_pct, venue_own_pct, cross_pct, blocked_categories
       FROM screens WHERE venue_partner_id = $1`, [req.params.id]
    );
    res.json({ ...row, screens: screens.rows });
  } catch (err) { next(err); }
});

const CITY_CAP = 50; // max active venue partners per city

// ── CITY CAPACITY check (admin) ───────────────────────────────────────────────
router.get('/city-cap', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { city } = req.query;
    if (!city) return res.json({ count: 0, cap: CITY_CAP, remaining: CITY_CAP });
    const r = await query(
      `SELECT COUNT(*) AS count FROM venue_partners
       WHERE LOWER(TRIM(city)) = LOWER(TRIM($1))
         AND approval_status IN ('pending','approved')`,
      [city]
    );
    const count = parseInt(r.rows[0].count);
    res.json({ count, cap: CITY_CAP, remaining: CITY_CAP - count, at_cap: count >= CITY_CAP });
  } catch (err) { next(err); }
});

// ── DYNAMIC REACH estimate for a venue partner ────────────────────────────────
router.get('/:id/reach', authenticate, async (req, res, next) => {
  if (!['admin','superadmin'].includes(req.user.role) && req.user.venue_partner_id !== req.params.id) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const vpRes = await query('SELECT city FROM venue_partners WHERE id = $1', [req.params.id]);
    if (!vpRes.rows.length) return res.status(404).json({ error: 'Not found' });
    const city = vpRes.rows[0].city;
    if (!city) return res.json({ estimated_plays_day: null, reason: 'no_city' });

    const SCREEN_RUNTIME = 54000; // 15h × 3600s
    const VP_SLOT_SEC    = 10;    // each VP gets 10s in filler loop

    const [screenRes, paidRes, vpCountRes] = await Promise.all([
      // screens in this city
      query(`SELECT COUNT(*) AS count FROM screens WHERE LOWER(TRIM(city)) = LOWER(TRIM($1))`, [city]),
      // avg paid loop per screen in city (sum of active campaign slot durations per screen, averaged)
      query(`
        SELECT AVG(paid_loop) AS avg_paid_loop FROM (
          SELECT s.id, COALESCE(SUM(c.slot_duration_sec), 0) AS paid_loop
          FROM screens s
          LEFT JOIN campaign_screens cs ON cs.screen_id = s.id
          LEFT JOIN campaigns c ON c.id = cs.campaign_id
            AND c.status IN ('approved','live')
            AND c.start_date <= CURRENT_DATE AND c.end_date >= CURRENT_DATE
          WHERE LOWER(TRIM(s.city)) = LOWER(TRIM($1))
          GROUP BY s.id
        ) t`, [city]),
      // active venue partners in city (excluding self)
      query(`
        SELECT COUNT(*) AS count FROM venue_partners
        WHERE LOWER(TRIM(city)) = LOWER(TRIM($1))
          AND approval_status = 'approved' AND is_active = TRUE`, [city]),
    ]);

    const screen_count  = parseInt(screenRes.rows[0].count) || 0;
    const avg_paid_loop = parseFloat(paidRes.rows[0].avg_paid_loop) || 0;
    const vp_count      = Math.max(1, parseInt(vpCountRes.rows[0].count) || 1);

    const free_time_per_screen = Math.max(0, SCREEN_RUNTIME - avg_paid_loop);
    const vp_loop_sec          = vp_count * VP_SLOT_SEC;
    const plays_per_screen     = vp_loop_sec > 0 ? Math.floor(free_time_per_screen / vp_loop_sec) : 0;
    const estimated_plays_day  = plays_per_screen * screen_count;

    res.json({
      estimated_plays_day,
      screen_count,
      vp_count_in_city: vp_count,
      free_time_per_screen_sec: Math.round(free_time_per_screen),
      avg_paid_loop_sec: Math.round(avg_paid_loop),
      city,
    });
  } catch (err) { next(err); }
});

// ── CREATE venue partner + user account (admin) ───────────────────────────────
router.post('/', authenticate, requireAdmin, async (req, res, next) => {
  const {
    business_name, venue_category, city, address,
    contact_name, contact_phone, revenue_share_pct,
    email, password
  } = req.body;

  if (!business_name || !email) {
    return res.status(400).json({ error: 'business_name and email are required' });
  }

  try {
    // Check email not already used
    const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length) return res.status(409).json({ error: 'Email already registered' });

    // ── City cap check ────────────────────────────────────────────────────────
    if (city) {
      const capRes = await query(
        `SELECT COUNT(*) AS count FROM venue_partners
         WHERE LOWER(TRIM(city)) = LOWER(TRIM($1))
           AND approval_status IN ('pending','approved')`,
        [city]
      );
      if (parseInt(capRes.rows[0].count) >= CITY_CAP) {
        return res.status(400).json({
          error: `City capacity reached — ${CITY_CAP} venue partners already registered in ${city}. Contact admin to review waitlist.`
        });
      }
    }

    const plain = password || Math.random().toString(36).slice(-8) + 'V1!';
    const hash = await bcrypt.hash(plain, 10);

    // Create venue_partner record first (pending approval by default)
    const vp = await query(
      `INSERT INTO venue_partners (business_name, venue_category, city, address, contact_name, contact_phone, revenue_share_pct, approval_status, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',false) RETURNING *`,
      [business_name, venue_category || 'other', city || null, address || null,
       contact_name || null, contact_phone || null, revenue_share_pct || 30]
    );
    const venuePartner = vp.rows[0];

    // Create user account linked to venue_partner (inactive until approved)
    const user = await query(
      `INSERT INTO users (email, password_hash, role, first_name, business_name, city, is_verified, is_active, venue_partner_id)
       VALUES ($1,$2,'venue_partner',$3,$4,$5,TRUE,FALSE,$6) RETURNING id, email, role`,
      [email, hash, contact_name || business_name, business_name, city || null, venuePartner.id]
    );

    // Link user back to venue_partner
    await query('UPDATE venue_partners SET user_id = $1 WHERE id = $2', [user.rows[0].id, venuePartner.id]);

    res.status(201).json({
      venue_partner: { ...venuePartner, user_id: user.rows[0].id },
      user: user.rows[0],
      generated_password: password ? null : plain,
      note: 'Account created with pending approval. Approve from Venue Partners list to activate portal access.'
    });
  } catch (err) { next(err); }
});

// ── UPDATE venue partner (admin) ──────────────────────────────────────────────
router.put('/:id', authenticate, requireAdmin, async (req, res, next) => {
  const { business_name, venue_category, city, address, contact_name, contact_phone, revenue_share_pct, is_active, filler_quota_sec } = req.body;
  try {
    const result = await query(
      `UPDATE venue_partners SET
        business_name=$1, venue_category=$2, city=$3, address=$4,
        contact_name=$5, contact_phone=$6, revenue_share_pct=$7, is_active=$8,
        filler_quota_sec=COALESCE($9, filler_quota_sec)
       WHERE id=$10 RETURNING *`,
      [business_name, venue_category, city, address, contact_name, contact_phone,
       revenue_share_pct, is_active !== false,
       filler_quota_sec != null ? parseInt(filler_quota_sec) : null,
       req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// ── REVENUE summary for a venue partner ──────────────────────────────────────
router.get('/:id/revenue', authenticate, async (req, res, next) => {
  if (!['admin','superadmin'].includes(req.user.role) && req.user.venue_partner_id !== req.params.id) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const summary = await query(
      `SELECT
         COALESCE(SUM(venue_share),0) AS total_earned,
         COALESCE(SUM(CASE WHEN settled THEN venue_share ELSE 0 END),0) AS total_settled,
         COALESCE(SUM(CASE WHEN NOT settled THEN venue_share ELSE 0 END),0) AS pending_settlement,
         COUNT(DISTINCT campaign_id) AS campaigns_contributed,
         COUNT(DISTINCT screen_id) AS screens_active
       FROM venue_revenue_logs WHERE venue_partner_id = $1`,
      [req.params.id]
    );
    const monthly = await query(
      `SELECT TO_CHAR(date,'YYYY-MM') AS month,
         SUM(venue_share) AS earned, SUM(plays_count) AS plays
       FROM venue_revenue_logs WHERE venue_partner_id = $1
       GROUP BY month ORDER BY month DESC LIMIT 12`,
      [req.params.id]
    );
    res.json({ summary: summary.rows[0], monthly: monthly.rows });
  } catch (err) { next(err); }
});

// ── MARK revenue as settled (admin) ──────────────────────────────────────────
router.post('/:id/settle', authenticate, requireAdmin, async (req, res, next) => {
  const { month } = req.body; // 'YYYY-MM' format
  if (!month) return res.status(400).json({ error: 'month required (YYYY-MM)' });
  try {
    const result = await query(
      `UPDATE venue_revenue_logs SET settled=TRUE
       WHERE venue_partner_id=$1 AND TO_CHAR(date,'YYYY-MM')=$2 AND settled=FALSE
       RETURNING id`,
      [req.params.id, month]
    );
    res.json({ settled_rows: result.rows.length, month });
  } catch (err) { next(err); }
});

// ── GET venue partner's own content (cross-network + own) ─────────────────────
router.get('/:id/content', authenticate, async (req, res, next) => {
  if (!['admin','superadmin'].includes(req.user.role) && req.user.venue_partner_id !== req.params.id) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const vp = await query('SELECT user_id FROM venue_partners WHERE id = $1', [req.params.id]);
    if (!vp.rows.length) return res.status(404).json({ error: 'Not found' });
    const content = await query(
      `SELECT * FROM content WHERE user_id = $1 AND status = 'active' AND content_tier IS NOT NULL ORDER BY created_at DESC`,
      [vp.rows[0].user_id]
    );
    res.json(content.rows);
  } catch (err) { next(err); }
});

// ── PROOF OF PLAY for venue partner ──────────────────────────────────────────
router.get('/:id/pop', authenticate, async (req, res, next) => {
  if (!['admin','superadmin'].includes(req.user.role) && req.user.venue_partner_id !== req.params.id) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const vp = await query('SELECT user_id FROM venue_partners WHERE id = $1', [req.params.id]);
    if (!vp.rows.length) return res.status(404).json({ error: 'Not found' });

    const { start, end, format } = req.query;
    const params = [vp.rows[0].user_id];
    let dateCond = '';
    if (start) { params.push(start); dateCond += ` AND pl.played_at >= $${params.length}::date`; }
    if (end)   { params.push(end);   dateCond += ` AND pl.played_at < ($${params.length}::date + interval '1 day')`; }

    // Plays of venue partner's own content (venue_own + venue_cross)
    const result = await query(
      `SELECT pl.id, pl.screen_id, pl.content_id, pl.played_at, pl.play_count,
              pl.duration_sec, pl.content_tier,
              s.screen_code, s.name AS screen_name, s.city AS screen_city,
              ct.original_name AS content_name, ct.type AS content_type, ct.file_url
       FROM play_logs pl
       JOIN content ct ON ct.id = pl.content_id
       JOIN screens s ON s.id = pl.screen_id
       WHERE ct.user_id = $1
         AND pl.content_tier IN ('venue_own','venue_cross')
         ${dateCond}
       ORDER BY pl.played_at DESC
       LIMIT 2000`,
      params
    );

    const rows = result.rows;
    const totalPlays = rows.reduce((s, r) => s + (parseInt(r.play_count) || 1), 0);

    if (format === 'csv') {
      const headers = ['Screen Code','Screen Name','City','Content','Type','Tier','Played At','Duration (s)','Play Count'];
      const csvRows = rows.map(r => [
        r.screen_code||'', r.screen_name||'', r.screen_city||'',
        r.content_name||'', r.content_type||'', r.content_tier||'',
        r.played_at ? new Date(r.played_at).toISOString() : '',
        r.duration_sec||'', r.play_count||1,
      ].map(v => `"${String(v).replace(/"/g,'""')}"`).join(','));
      const csv = [headers.join(','), ...csvRows].join('\r\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="venue-pop-${new Date().toISOString().slice(0,10)}.csv"`);
      return res.send(csv);
    }

    res.json({ rows, total_plays: totalPlays, total_records: rows.length });
  } catch (err) { next(err); }
});

module.exports = router;

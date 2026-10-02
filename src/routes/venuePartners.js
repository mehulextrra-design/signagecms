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

// ── GET single venue partner ──────────────────────────────────────────────────
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const vp = await query(
      `SELECT vp.*, u.email FROM venue_partners vp
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

    const plain = password || Math.random().toString(36).slice(-8) + 'V1!';
    const hash = await bcrypt.hash(plain, 10);

    // Create venue_partner record first
    const vp = await query(
      `INSERT INTO venue_partners (business_name, venue_category, city, address, contact_name, contact_phone, revenue_share_pct)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [business_name, venue_category || 'other', city || null, address || null,
       contact_name || null, contact_phone || null, revenue_share_pct || 30]
    );
    const venuePartner = vp.rows[0];

    // Create user account linked to venue_partner
    const user = await query(
      `INSERT INTO users (email, password_hash, role, first_name, business_name, city, is_verified, is_active, venue_partner_id)
       VALUES ($1,$2,'venue_partner',$3,$4,$5,TRUE,TRUE,$6) RETURNING id, email, role`,
      [email, hash, contact_name || business_name, business_name, city || null, venuePartner.id]
    );

    // Link user back to venue_partner
    await query('UPDATE venue_partners SET user_id = $1 WHERE id = $2', [user.rows[0].id, venuePartner.id]);

    res.status(201).json({
      venue_partner: { ...venuePartner, user_id: user.rows[0].id },
      user: user.rows[0],
      generated_password: password ? null : plain  // only send if auto-generated
    });
  } catch (err) { next(err); }
});

// ── UPDATE venue partner (admin) ──────────────────────────────────────────────
router.put('/:id', authenticate, requireAdmin, async (req, res, next) => {
  const { business_name, venue_category, city, address, contact_name, contact_phone, revenue_share_pct, is_active } = req.body;
  try {
    const result = await query(
      `UPDATE venue_partners SET
        business_name=$1, venue_category=$2, city=$3, address=$4,
        contact_name=$5, contact_phone=$6, revenue_share_pct=$7, is_active=$8
       WHERE id=$9 RETURNING *`,
      [business_name, venue_category, city, address, contact_name, contact_phone, revenue_share_pct, is_active !== false, req.params.id]
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
      `SELECT * FROM content WHERE user_id = $1 AND status = 'active' ORDER BY created_at DESC`,
      [vp.rows[0].user_id]
    );
    res.json(content.rows);
  } catch (err) { next(err); }
});

module.exports = router;

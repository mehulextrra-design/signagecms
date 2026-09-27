const express = require('express');
const { query } = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// GET /api/reports/proof-of-play?campaign_id=...&start=...&end=...
router.get('/proof-of-play', authenticate, async (req, res, next) => {
  try {
    const { campaign_id, start, end } = req.query;
    const isAdmin = ['admin', 'superadmin'].includes(req.user.role);
    let sql = `
      SELECT pl.*, s.screen_code, s.name AS screen_name, c.title AS campaign_title
      FROM play_logs pl
      JOIN screens s ON s.id = pl.screen_id
      JOIN campaigns c ON c.id = pl.campaign_id
      WHERE 1=1
    `;
    const params = [];
    if (!isAdmin) { params.push(req.user.id); sql += ` AND c.user_id = $${params.length}`; }
    if (campaign_id) { params.push(campaign_id); sql += ` AND pl.campaign_id = $${params.length}`; }
    if (start) { params.push(start); sql += ` AND pl.played_at >= $${params.length}`; }
    if (end) { params.push(end); sql += ` AND pl.played_at <= $${params.length}`; }
    sql += ' ORDER BY pl.played_at DESC LIMIT 1000';
    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) { next(err); }
});

// GET /api/reports/dashboard — admin summary stats
router.get('/dashboard', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const [revenue, campaigns, screens, users, pending] = await Promise.all([
      query("SELECT COALESCE(SUM(amount_total),0) AS total FROM invoices WHERE status='paid' AND issued_at >= date_trunc('month', NOW())"),
      query("SELECT status, COUNT(*) AS count FROM campaigns GROUP BY status"),
      query("SELECT status, COUNT(*) AS count FROM screens GROUP BY status"),
      query("SELECT COUNT(*) AS count FROM users WHERE role='advertiser' AND is_active=TRUE"),
      query("SELECT COUNT(*) AS count FROM campaigns WHERE status='pending_approval'"),
    ]);
    res.json({
      revenue_this_month: parseFloat(revenue.rows[0].total),
      campaigns: campaigns.rows,
      screens: screens.rows,
      active_advertisers: parseInt(users.rows[0].count),
      pending_approvals: parseInt(pending.rows[0].count),
    });
  } catch (err) { next(err); }
});

// GET /api/reports/screens — screen utilization
router.get('/screens', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT s.screen_code, s.name, s.status, s.last_heartbeat,
         COUNT(DISTINCT cs.campaign_id) FILTER (WHERE c.status='live') AS active_campaigns,
         COUNT(pl.id) AS plays_today
       FROM screens s
       LEFT JOIN campaign_screens cs ON cs.screen_id = s.id
       LEFT JOIN campaigns c ON c.id = cs.campaign_id
       LEFT JOIN play_logs pl ON pl.screen_id = s.id AND pl.played_at::date = CURRENT_DATE
       GROUP BY s.id ORDER BY s.screen_code`
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// GET /api/reports/activity?limit=50
router.get('/activity', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const result = await query(
      `SELECT al.*, u.email, u.first_name FROM activity_log al
       LEFT JOIN users u ON u.id = al.user_id
       ORDER BY al.created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

module.exports = router;

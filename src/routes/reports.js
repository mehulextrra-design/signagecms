const express = require('express');
const { query } = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { sendWeeklyReports, sendReportForUser, buildWeeklyReport } = require('../services/whatsapp');

const router = express.Router();

// GET /api/reports/proof-of-play?campaign_id=&screen_id=&user_id=&start=&end=&format=csv
router.get('/proof-of-play', authenticate, async (req, res, next) => {
  try {
    const { campaign_id, screen_id, user_id, start, end, format } = req.query;
    const isAdmin = ['admin', 'superadmin'].includes(req.user.role);
    let sql = `
      SELECT pl.id, pl.screen_id, pl.campaign_id, pl.content_id,
             pl.played_at,
             (pl.played_at + (COALESCE(pl.duration_sec,0) || ' seconds')::interval) AS played_until,
             pl.duration_sec, pl.play_count,
             COALESCE(pl.content_tier,'paid') AS content_tier,
             COALESCE(pl.source,'apk') AS source,
             s.screen_code, s.name AS screen_name, s.city AS screen_city,
             c.title AS campaign_title, c.campaign_code,
             u.first_name AS advertiser_name, u.email AS user_email
      FROM play_logs pl
      LEFT JOIN screens s ON s.id = pl.screen_id
      LEFT JOIN campaigns c ON c.id = pl.campaign_id
      LEFT JOIN users u ON u.id = c.user_id
      WHERE 1=1
    `;
    const params = [];
    if (!isAdmin) {
      // Show logs where campaign belongs to this user, OR where screen is assigned to their campaign
      params.push(req.user.id);
      sql += ` AND (c.user_id = $${params.length} OR pl.screen_id IN (
        SELECT DISTINCT cs.screen_id FROM campaign_screens cs
        JOIN campaigns cc ON cc.id = cs.campaign_id
        WHERE cc.user_id = $${params.length}
      ))`;
    }
    if (campaign_id) { params.push(campaign_id); sql += ` AND pl.campaign_id = $${params.length}`; }
    if (screen_id)   { params.push(screen_id);   sql += ` AND pl.screen_id = $${params.length}`; }
    if (user_id)     { params.push(user_id);      sql += ` AND c.user_id = $${params.length}`; }
    if (start) { params.push(start); sql += ` AND pl.played_at >= $${params.length}::date`; }
    if (end)   { params.push(end);   sql += ` AND pl.played_at < ($${params.length}::date + interval '1 day')`; }
    sql += ' ORDER BY pl.played_at DESC LIMIT 5000';

    const [result, totalRes] = await Promise.all([
      query(sql, params),
      query('SELECT COUNT(*) AS total, COALESCE(SUM(play_count),0) AS total_plays FROM play_logs'),
    ]);

    const rows = result.rows;
    const totalPlays = rows.reduce((s, r) => s + (parseInt(r.play_count) || 1), 0);

    // CSV export
    if (format === 'csv') {
      const headers = ['Play ID','Screen Code','Screen Name','City','Advertiser','Campaign','Campaign Code','Played At','Played Until','Duration (s)','Play Count','Tier'];
      const csvRows = rows.map(r => [
        r.id, r.screen_code||'', r.screen_name||'', r.screen_city||'',
        r.advertiser_name||r.user_email||'', r.campaign_title||'', r.campaign_code||'',
        r.played_at ? new Date(r.played_at).toISOString() : '',
        r.played_until ? new Date(r.played_until).toISOString() : '',
        r.duration_sec||'', r.play_count||1, r.content_tier||'paid',
      ].map(v => `"${String(v).replace(/"/g,'""')}"`).join(','));
      const csv = [headers.join(','), ...csvRows].join('\r\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="proof-of-play-${new Date().toISOString().slice(0,10)}.csv"`);
      return res.send(csv);
    }

    res.json({
      rows,
      total_records: rows.length,
      total_plays: totalPlays,
      total_in_db: parseInt(totalRes.rows[0].total),
      total_plays_in_db: parseInt(totalRes.rows[0].total_plays),
    });
  } catch (err) { next(err); }
});

// GET /api/reports/analytics?period=week&start=&end=
router.get('/analytics', authenticate, async (req, res, next) => {
  try {
    const { period = 'week', start, end } = req.query;
    const isAdmin = ['admin', 'superadmin'].includes(req.user.role);
    const params = [];
    const conditions = [];

    if (!isAdmin) {
      params.push(req.user.id);
      conditions.push(`c.user_id = $${params.length}`);
    }

    if (period === 'custom' && start && end) {
      params.push(start); conditions.push(`pl.played_at >= $${params.length}::date`);
      params.push(end);   conditions.push(`pl.played_at < ($${params.length}::date + interval '1 day')`);
    } else {
      const ranges = {
        day:     "pl.played_at >= CURRENT_DATE",
        week:    "pl.played_at >= CURRENT_DATE - INTERVAL '6 days'",
        month:   "pl.played_at >= date_trunc('month', CURRENT_DATE)",
        quarter: "pl.played_at >= date_trunc('quarter', CURRENT_DATE)",
        year:    "pl.played_at >= date_trunc('year', CURRENT_DATE)",
      };
      conditions.push(ranges[period] || ranges.week);
    }

    const where = 'WHERE ' + conditions.join(' AND ');
    const trunc = period === 'day' ? 'hour' : period === 'year' ? 'month' : period === 'quarter' ? 'week' : 'day';
    const base = `FROM play_logs pl LEFT JOIN campaigns c ON c.id = pl.campaign_id ${where}`;

    const projParams = isAdmin ? [] : [req.user.id];
    const projWhere = isAdmin ? '' : 'AND c.user_id = $1';

    const [chartRes, statsRes, campRes, projRes] = await Promise.all([
      query(`SELECT DATE_TRUNC('${trunc}', pl.played_at) AS bucket, COUNT(*) AS plays ${base} GROUP BY bucket ORDER BY bucket`, params),
      query(`SELECT COUNT(*) AS total_plays, COUNT(DISTINCT pl.screen_id) AS screens_used, COUNT(DISTINCT pl.campaign_id) AS campaigns_active ${base}`, params),
      query(`SELECT c.id, c.title, c.campaign_code, c.status, c.qr_enabled,
              COUNT(pl.id) AS plays, COUNT(DISTINCT pl.screen_id) AS screens,
              0 AS qr_scans
              ${base} GROUP BY c.id ORDER BY plays DESC LIMIT 10`, params),
      query(`SELECT c.id, c.title, c.campaign_code, c.status, c.start_date, c.end_date,
              c.slot_duration_sec, c.package_name, c.amount_total,
              COUNT(DISTINCT cs.screen_id) AS screen_count
             FROM campaigns c
             JOIN campaign_screens cs ON cs.campaign_id = c.id
             WHERE c.status IN ('approved','live','completed','pending_approval') ${projWhere}
             GROUP BY c.id ORDER BY c.start_date DESC LIMIT 30`, projParams),
    ]);

    res.json({ stats: statsRes.rows[0], chart: chartRes.rows, campaigns: campRes.rows, projected: projRes.rows });
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

// GET /api/reports/schedule-preview/:screen_id — admin: preview what player would receive
router.get('/schedule-preview/:screen_id', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const screenId = req.params.screen_id;
    const todayStr = new Date().toISOString().split('T')[0];

    const [screenRes, paidRes, fillerRes] = await Promise.all([
      query(`SELECT s.id, s.name, s.screen_code, s.city, s.paid_pct, s.venue_own_pct, s.cross_pct, s.status, s.last_heartbeat
             FROM screens s WHERE s.id = $1`, [screenId]),
      query(`SELECT c.id, c.title, c.campaign_code, c.status, c.start_date, c.end_date,
                    c.start_time, c.end_time, ct.file_url, ct.type AS content_type, ct.duration_sec
             FROM campaigns c
             JOIN campaign_screens cs ON cs.campaign_id = c.id
             JOIN content ct ON ct.id = c.content_id
             WHERE cs.screen_id = $1
               AND c.status IN ('approved','live')
               AND c.start_date <= $2
               AND c.end_date   >= $2
             ORDER BY c.start_date ASC`, [screenId, todayStr]),
      query(`SELECT id, title, file_url, type, duration_sec, is_active FROM filler_content WHERE is_active=TRUE`).catch(() => ({ rows: [] })),
    ]);

    if (!screenRes.rows.length) return res.status(404).json({ error: 'Screen not found' });

    const allCampsRes = await query(
      `SELECT c.id, c.title, c.campaign_code, c.status, c.start_date, c.end_date
       FROM campaigns c
       JOIN campaign_screens cs ON cs.campaign_id = c.id
       WHERE cs.screen_id = $1 ORDER BY c.start_date DESC LIMIT 10`, [screenId]
    );

    res.json({
      screen: screenRes.rows[0],
      today: todayStr,
      active_campaigns_in_schedule: paidRes.rows,
      all_assigned_campaigns: allCampsRes.rows,
      filler_items: fillerRes.rows,
      diagnosis: {
        paid_count: paidRes.rows.length,
        filler_count: fillerRes.rows.length,
        screen_online: screenRes.rows[0].status === 'online',
        last_heartbeat: screenRes.rows[0].last_heartbeat,
      }
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

// POST /api/reports/whatsapp/send-all — admin: trigger weekly report for all live advertisers
router.post('/whatsapp/send-all', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const result = await sendWeeklyReports();
    res.json({ message: 'WhatsApp reports triggered', ...result });
  } catch (err) { next(err); }
});

// POST /api/reports/whatsapp/send/:user_id — admin: send report for one advertiser
router.post('/whatsapp/send/:user_id', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const preview = await buildWeeklyReport(req.params.user_id);
    if (!preview) return res.status(404).json({ error: 'No active campaigns or data for this user' });

    if (req.query.preview === '1') {
      return res.json({ preview: true, phone: preview.phone, message: preview.message });
    }

    const result = await sendReportForUser(req.params.user_id);
    res.json({ sent: true, ...result });
  } catch (err) { next(err); }
});

module.exports = router;

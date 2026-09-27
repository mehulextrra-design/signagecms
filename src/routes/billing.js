const express = require('express');
const { query } = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// GET /api/billing/invoices — advertiser's invoices
router.get('/invoices', authenticate, async (req, res, next) => {
  try {
    const isAdmin = ['admin', 'superadmin'].includes(req.user.role);
    let sql = `SELECT i.*, c.title AS campaign_title, c.campaign_code FROM invoices i
               JOIN campaigns c ON c.id = i.campaign_id WHERE 1=1`;
    const params = [];
    if (!isAdmin) { params.push(req.user.id); sql += ` AND i.user_id = $${params.length}`; }
    sql += ' ORDER BY i.issued_at DESC';
    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) { next(err); }
});

// GET /api/billing/invoices/:id
router.get('/invoices/:id', authenticate, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT i.*, c.title, c.campaign_code, c.start_date, c.end_date,
              u.first_name, u.last_name, u.business_name, u.gst_number, u.email, u.mobile, u.city
       FROM invoices i JOIN campaigns c ON c.id = i.campaign_id JOIN users u ON u.id = i.user_id
       WHERE i.id = $1`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Invoice not found' });
    const inv = result.rows[0];
    if (!['admin', 'superadmin'].includes(req.user.role) && inv.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    res.json(inv);
  } catch (err) { next(err); }
});

// GET /api/billing/overview — admin revenue overview
router.get('/overview', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT
         date_trunc('month', issued_at) AS month,
         COUNT(*) AS invoice_count,
         SUM(amount_total) AS total,
         SUM(amount_gst) AS gst_collected
       FROM invoices WHERE status='paid'
       GROUP BY 1 ORDER BY 1 DESC LIMIT 12`
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// POST /api/billing/refund — admin issues refund
router.post('/refund', authenticate, requireAdmin, async (req, res, next) => {
  const { campaign_id, reason, amount } = req.body;
  try {
    await query(
      `UPDATE invoices SET status='refunded' WHERE campaign_id=$1`,
      [campaign_id]
    );
    await query(
      `UPDATE campaigns SET payment_status='refunded', notes=$1, updated_at=NOW() WHERE id=$2`,
      [reason, campaign_id]
    );
    await query(
      `INSERT INTO activity_log (user_id, action, entity_type, entity_id, details)
       VALUES ($1,'refund_issued','campaign',$2,$3)`,
      [req.user.id, campaign_id, JSON.stringify({ reason, amount })]
    );
    res.json({ message: 'Refund processed', amount });
  } catch (err) { next(err); }
});

module.exports = router;

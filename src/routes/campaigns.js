const express = require('express');
const { query, getClient } = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { reviewCampaign } = require('../services/aiReview');

const router = express.Router();

const generateCampaignCode = async () => {
  const result = await query("SELECT COUNT(*) FROM campaigns");
  const num = parseInt(result.rows[0].count) + 1;
  return `CMP-${String(num).padStart(4, '0')}`;
};

const generateInvoiceNumber = async () => {
  const result = await query("SELECT COUNT(*) FROM invoices");
  const num = parseInt(result.rows[0].count) + 1;
  return `INV-${String(num).padStart(4, '0')}`;
};

// GET /api/campaigns — advertiser sees own, admin sees all
router.get('/', authenticate, async (req, res, next) => {
  try {
    const isAdmin = ['admin', 'superadmin'].includes(req.user.role);
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let sql = `
      SELECT c.*, u.first_name, u.last_name, u.business_name, u.email,
        ARRAY_AGG(DISTINCT s.screen_code) FILTER (WHERE s.id IS NOT NULL) AS screens,
        c.rejection_reason, c.ai_review_status, c.ai_review_notes,
        ct.file_url AS creative_url, ct.type AS creative_type, ct.original_name AS creative_name
      FROM campaigns c
      JOIN users u ON u.id = c.user_id
      LEFT JOIN campaign_screens cs ON cs.campaign_id = c.id
      LEFT JOIN screens s ON s.id = cs.screen_id
      LEFT JOIN content ct ON ct.id = c.content_id
      WHERE 1=1
    `;
    const params = [];

    if (!isAdmin) { params.push(req.user.id); sql += ` AND c.user_id = $${params.length}`; }
    if (status) { params.push(status); sql += ` AND c.status = $${params.length}`; }

    sql += ` GROUP BY c.id, u.first_name, u.last_name, u.business_name, u.email
             ORDER BY c.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) { next(err); }
});

// GET /api/campaigns/:id
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT c.*, u.first_name, u.business_name, u.email, u.gst_number,
        ARRAY_AGG(s.id) AS screen_ids,
        ARRAY_AGG(s.screen_code) AS screen_codes,
        ARRAY_AGG(s.name) AS screen_names
       FROM campaigns c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN campaign_screens cs ON cs.campaign_id = c.id
       LEFT JOIN screens s ON s.id = cs.screen_id
       WHERE c.id = $1 GROUP BY c.id, u.first_name, u.business_name, u.email, u.gst_number`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Campaign not found' });
    const campaign = result.rows[0];
    // Restrict advertiser to own campaigns
    if (!['admin', 'superadmin'].includes(req.user.role) && campaign.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    res.json(campaign);
  } catch (err) { next(err); }
});

// POST /api/campaigns — create + pay
router.post('/', authenticate, async (req, res, next) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { screen_ids, content_id, title, start_date, end_date, start_time, end_time, coupon_code } = req.body;

    if (!screen_ids?.length) throw { status: 400, message: 'At least one screen required' };

    // Fetch screens + calculate price
    const screenResult = await client.query(
      'SELECT id, price_per_day FROM screens WHERE id = ANY($1)', [screen_ids]
    );
    if (screenResult.rows.length !== screen_ids.length) throw { status: 400, message: 'Invalid screen IDs' };

    const days = Math.ceil((new Date(end_date) - new Date(start_date)) / 86400000) + 1;
    let amount_base = screenResult.rows.reduce((sum, s) => sum + parseFloat(s.price_per_day), 0) * days;
    let discount = 0;

    // Apply coupon
    if (coupon_code) {
      const cpn = await client.query(
        `SELECT * FROM coupons WHERE code = $1 AND is_active = TRUE AND valid_from <= NOW() AND valid_until >= NOW()
         AND (usage_limit IS NULL OR used_count < usage_limit) AND min_order <= $2`,
        [coupon_code.toUpperCase(), amount_base]
      );
      if (cpn.rows.length) {
        const c = cpn.rows[0];
        discount = c.type === 'percent' ? (amount_base * c.value / 100) : parseFloat(c.value);
        if (c.max_discount) discount = Math.min(discount, parseFloat(c.max_discount));
        amount_base -= discount;
        await client.query('UPDATE coupons SET used_count = used_count + 1 WHERE id = $1', [c.id]);
      }
    }

    const gstRate = parseFloat(process.env.GST_RATE || 18) / 100;
    const amount_gst = parseFloat((amount_base * gstRate).toFixed(2));
    const amount_total = parseFloat((amount_base + amount_gst).toFixed(2));

    const code = await generateCampaignCode();
    const campResult = await client.query(
      `INSERT INTO campaigns (campaign_code, user_id, content_id, title, start_date, end_date, start_time, end_time,
        amount_base, amount_gst, amount_total, coupon_code, discount_amount, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending_payment') RETURNING *`,
      [code, req.user.id, content_id, title, start_date, end_date, start_time || '00:00:00', end_time || '23:59:59',
       amount_base, amount_gst, amount_total, coupon_code, discount]
    );
    const campaign = campResult.rows[0];

    // Link screens
    for (const sid of screen_ids) {
      await client.query('INSERT INTO campaign_screens (campaign_id, screen_id) VALUES ($1,$2)', [campaign.id, sid]);
    }

    await client.query('COMMIT');
    res.status(201).json(campaign);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

// POST /api/campaigns/:id/confirm-payment — mark paid + submit for approval
router.post('/:id/confirm-payment', authenticate, async (req, res, next) => {
  const { payment_id, payment_method } = req.body;
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE campaigns SET status='pending_approval', payment_status='paid', updated_at=NOW()
       WHERE id=$1 AND user_id=$2 AND status='pending_payment' RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (!result.rows.length) throw { status: 404, message: 'Campaign not found or already paid' };
    const campaign = result.rows[0];

    // Create invoice
    const invNum = await generateInvoiceNumber();
    await client.query(
      `INSERT INTO invoices (invoice_number, campaign_id, user_id, amount_base, amount_gst, amount_total, payment_id, payment_method, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'paid')`,
      [invNum, campaign.id, req.user.id, campaign.amount_base, campaign.amount_gst, campaign.amount_total, payment_id, payment_method]
    );

    await client.query('COMMIT');
    res.json({ campaign, invoice_number: invNum });

    // Async AI content review — runs after response sent
    reviewCampaign(campaign.id).catch(err =>
      console.error('[AI Review] Background review failed:', err.message)
    );
  } catch (err) { await client.query('ROLLBACK'); next(err); }
  finally { client.release(); }
});

// POST /api/campaigns/:id/approve — admin only
router.post('/:id/approve', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const result = await query(
      `UPDATE campaigns SET status='approved', approved_by=$1, approved_at=NOW(), updated_at=NOW()
       WHERE id=$2 AND status='pending_approval' RETURNING *`,
      [req.user.id, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Campaign not found or not pending approval' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// POST /api/campaigns/:id/reject — admin only
router.post('/:id/reject', authenticate, requireAdmin, async (req, res, next) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ error: 'Rejection reason required' });
  try {
    const result = await query(
      `UPDATE campaigns SET status='rejected', rejection_reason=$1, updated_at=NOW()
       WHERE id=$2 AND status='pending_approval' RETURNING *`,
      [reason, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Campaign not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// POST /api/campaigns/:id/pause
router.post('/:id/pause', authenticate, async (req, res, next) => {
  try {
    const result = await query(
      `UPDATE campaigns SET status='paused', updated_at=NOW()
       WHERE id=$1 AND user_id=$2 AND status='live' RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Campaign not found or not live' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// POST /api/campaigns/:id/resume
router.post('/:id/resume', authenticate, async (req, res, next) => {
  try {
    const result = await query(
      `UPDATE campaigns SET status='live', updated_at=NOW()
       WHERE id=$1 AND user_id=$2 AND status='paused' RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Campaign not found or not paused' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/campaigns/:id — cancel + refund logic
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const { reason } = req.body;
    const result = await query(
      `UPDATE campaigns SET status='cancelled', notes=$1, updated_at=NOW()
       WHERE id=$2 AND user_id=$3 AND status NOT IN ('cancelled','completed') RETURNING *`,
      [reason || 'Cancelled by advertiser', req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Cannot cancel this campaign' });
    res.json({ message: 'Campaign cancelled', campaign: result.rows[0] });
  } catch (err) { next(err); }
});

module.exports = router;

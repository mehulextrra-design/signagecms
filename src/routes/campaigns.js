const express = require('express');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const { query, getClient } = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { reviewCampaign } = require('../services/aiReview');
const { sendInvoiceEmail, sendApprovedEmail, sendRejectedEmail } = require('../services/email');

const getRzp = () => new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

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
        ct.file_url AS creative_url, ct.type AS creative_type, ct.original_name AS creative_name,
        COALESCE((SELECT SUM(pl.play_count) FROM play_logs pl WHERE pl.campaign_id = c.id), 0) AS play_count
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

    sql += ` GROUP BY c.id, u.first_name, u.last_name, u.business_name, u.email, ct.file_url, ct.type, ct.original_name
             ORDER BY c.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) { next(err); }
});

// GET /api/campaigns/:id/qr — UPI payment details for pending_payment campaigns
router.get('/:id/qr', authenticate, async (req, res, next) => {
  try {
    const result = await query(
      'SELECT id, amount_total, campaign_code, title, user_id, status FROM campaigns WHERE id = $1',
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Campaign not found' });
    const campaign = result.rows[0];
    if (!['admin', 'superadmin'].includes(req.user.role) && campaign.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const upiId = process.env.UPI_ID || 'signagecms@upi';
    const amount = parseFloat(campaign.amount_total).toFixed(2);
    const ref = campaign.campaign_code;
    const upiString = `upi://pay?pa=${upiId}&am=${amount}&tn=${encodeURIComponent(ref)}&cu=INR`;
    res.json({
      upi_id: upiId,
      amount: parseFloat(amount),
      reference: ref,
      campaign_id: campaign.id,
      status: campaign.status,
      upi_string: upiString,
    });
  } catch (err) { next(err); }
});

// PUT /api/campaigns/:id/qr — save WhatsApp QR overlay settings
router.put('/:id/qr', authenticate, async (req, res, next) => {
  try {
    const { qr_enabled, qr_placement, qr_phone } = req.body;
    const check = await query('SELECT id, user_id FROM campaigns WHERE id = $1', [req.params.id]);
    if (!check.rows.length) return res.status(404).json({ error: 'Campaign not found' });
    if (!['admin', 'superadmin'].includes(req.user.role) && check.rows[0].user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const qrContentUrl = qr_enabled && qr_phone
      ? `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(`https://wa.me/${qr_phone.replace(/\D/g, '')}`)}&size=250x250`
      : null;
    const result = await query(
      `UPDATE campaigns SET qr_enabled=$1, qr_placement=$2, qr_content_url=$3, updated_at=NOW()
       WHERE id=$4 RETURNING id, qr_enabled, qr_placement, qr_content_url`,
      [!!qr_enabled, qr_placement || 'bot-right', qrContentUrl, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// GET /api/campaigns/:id
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT c.*, u.first_name, u.business_name, u.email, u.gst_number,
        ARRAY_AGG(DISTINCT s.id)          FILTER (WHERE s.id IS NOT NULL) AS screen_ids,
        ARRAY_AGG(DISTINCT s.screen_code) FILTER (WHERE s.id IS NOT NULL) AS screen_codes,
        ARRAY_AGG(DISTINCT s.name)        FILTER (WHERE s.id IS NOT NULL) AS screen_names,
        ct.file_url       AS creative_url,
        ct.type           AS creative_type,
        ct.original_name  AS creative_name,
        ct.duration_sec   AS creative_duration,
        ct.file_size      AS creative_size
       FROM campaigns c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN campaign_screens cs ON cs.campaign_id = c.id
       LEFT JOIN screens s ON s.id = cs.screen_id
       LEFT JOIN content ct ON ct.id = c.content_id
       WHERE c.id = $1
       GROUP BY c.id, u.first_name, u.business_name, u.email, u.gst_number,
                ct.file_url, ct.type, ct.original_name, ct.duration_sec, ct.file_size`,
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

// Slot duration + flat-rate pricing (entire network, not per-screen)
const PACKAGES = {
  trial:     { slot_duration_sec: 10, name: 'trial',     ppd: 285,  flat: 1999, fixedDays: 7 },
  spot:      { slot_duration_sec: 10, name: 'spot',      ppd: 267,  monthly: 8000 },
  regular:   { slot_duration_sec: 15, name: 'regular',   ppd: 433,  monthly: 13000 },
  premium:   { slot_duration_sec: 20, name: 'premium',   ppd: 600,  monthly: 18000 },
  exclusive: { slot_duration_sec: 30, name: 'exclusive', ppd: 833,  monthly: 25000 },
};

// POST /api/campaigns — create + pay
router.post('/', authenticate, async (req, res, next) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { screen_ids, content_id, title, start_date, end_date, start_time, end_time, coupon_code, package_name } = req.body;

    if (!screen_ids?.length) throw { status: 400, message: 'At least one screen required' };

    // Resolve package → slot duration
    const pkg = PACKAGES[(package_name || 'regular').toLowerCase()] || PACKAGES.regular;
    const slot_duration_sec = pkg.slot_duration_sec;

    // Validate video content duration against slot
    if (content_id) {
      const contentRow = await client.query('SELECT type, duration_sec FROM content WHERE id=$1', [content_id]);
      if (contentRow.rows.length) {
        const { type, duration_sec } = contentRow.rows[0];
        if (type === 'video' && duration_sec != null) {
          const minSec = slot_duration_sec * 0.8;
          const maxSec = slot_duration_sec * 1.2;
          if (duration_sec > maxSec) {
            throw { status: 400, message: `Video too long for ${pkg.name} package (${slot_duration_sec}s slot). Your video is ${duration_sec}s — max allowed: ${maxSec}s. Please trim or choose a longer slot package.` };
          }
          if (duration_sec < minSec) {
            throw { status: 400, message: `Video too short for ${pkg.name} package (${slot_duration_sec}s slot). Your video is ${duration_sec}s — min allowed: ${minSec}s.` };
          }
        }
      }
    }

    // Validate screens exist
    const screenResult = await client.query(
      'SELECT id FROM screens WHERE id = ANY($1)', [screen_ids]
    );
    if (screenResult.rows.length !== screen_ids.length) throw { status: 400, message: 'Invalid screen IDs' };

    // Package flat-rate pricing (entire network — not per screen)
    const days = Math.ceil((new Date(end_date) - new Date(start_date)) / 86400000) + 1;
    let amount_base = pkg.fixedDays ? pkg.flat : pkg.ppd * days;
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
        amount_base, amount_gst, amount_total, coupon_code, discount_amount, slot_duration_sec, package_name, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pending_payment') RETURNING *`,
      [code, req.user.id, content_id, title, start_date, end_date, start_time || '00:00:00', end_time || '23:59:59',
       amount_base, amount_gst, amount_total, coupon_code, discount, slot_duration_sec, pkg.name]
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

// POST /api/campaigns/:id/create-order — create Razorpay order
router.post('/:id/create-order', authenticate, async (req, res, next) => {
  try {
    const result = await query(
      'SELECT id, amount_total, campaign_code, title, user_id, status FROM campaigns WHERE id = $1',
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Campaign not found' });
    const campaign = result.rows[0];
    if (campaign.user_id !== req.user.id && !['admin', 'superadmin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (campaign.status !== 'pending_payment') {
      return res.status(400).json({ error: 'Campaign is not awaiting payment' });
    }
    const order = await getRzp().orders.create({
      amount: Math.round(parseFloat(campaign.amount_total) * 100),
      currency: 'INR',
      receipt: campaign.campaign_code,
      notes: { campaign_id: campaign.id, title: campaign.title },
    });
    res.json({ order_id: order.id, amount: order.amount, currency: order.currency, key_id: process.env.RAZORPAY_KEY_ID });
  } catch (err) { next(err); }
});

// POST /api/campaigns/:id/confirm-payment — verify Razorpay signature + mark paid
router.post('/:id/confirm-payment', authenticate, async (req, res, next) => {
  const { payment_id, order_id, signature, payment_method } = req.body;
  // Verify Razorpay signature when present
  if (order_id && signature) {
    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${order_id}|${payment_id}`).digest('hex');
    if (expected !== signature) return res.status(400).json({ error: 'Payment verification failed' });
  }
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

    // Async tasks after response — AI review + invoice email
    reviewCampaign(campaign.id).catch(err =>
      console.error('[AI Review] Background review failed:', err.message)
    );
    sendInvoiceEmail(campaign.id, invNum).catch(() => {});
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
    sendApprovedEmail(result.rows[0].id).catch(() => {});
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
    sendRejectedEmail(result.rows[0].id, reason).catch(() => {});
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

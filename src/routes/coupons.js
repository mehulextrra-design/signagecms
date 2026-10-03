const express = require('express');
const { query } = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// GET /api/coupons — admin: all coupons
router.get('/', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const result = await query('SELECT * FROM coupons ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) { next(err); }
});

// POST /api/coupons/validate — check if coupon is valid for given amount
router.post('/validate', authenticate, async (req, res, next) => {
  const { code, order_amount, amount } = req.body;
  const orderAmt = order_amount || amount;
  if (!code) return res.status(400).json({ error: 'Coupon code required' });
  try {
    const result = await query(
      `SELECT * FROM coupons WHERE code = $1 AND is_active = TRUE
       AND valid_from <= CURRENT_DATE AND valid_until >= CURRENT_DATE
       AND (usage_limit IS NULL OR used_count < usage_limit)`,
      [code.toUpperCase()]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Invalid or expired coupon' });
    const c = result.rows[0];
    if (orderAmt && parseFloat(orderAmt) < parseFloat(c.min_order)) {
      return res.status(400).json({ error: `Minimum order amount ₹${c.min_order} required` });
    }
    let discount = c.type === 'percent'
      ? (parseFloat(orderAmt || 0) * parseFloat(c.value) / 100)
      : parseFloat(c.value);
    if (c.max_discount) discount = Math.min(discount, parseFloat(c.max_discount));
    res.json({ valid: true, coupon: c, discount: parseFloat(discount.toFixed(2)), discount_amount: parseFloat(discount.toFixed(2)) });
  } catch (err) { next(err); }
});

// POST /api/coupons — admin: create
router.post('/', authenticate, requireAdmin, async (req, res, next) => {
  const { code, type, value, min_order, max_discount, usage_limit, valid_from, valid_until, description } = req.body;
  if (!code || !type || !value || !valid_from || !valid_until) {
    return res.status(400).json({ error: 'code, type, value, valid_from, valid_until required' });
  }
  try {
    const result = await query(
      `INSERT INTO coupons (code, type, value, min_order, max_discount, usage_limit, valid_from, valid_until, description, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [code.toUpperCase(), type, value, min_order || 0, max_discount, usage_limit, valid_from, valid_until, description, req.user.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Coupon code already exists' });
    next(err);
  }
});

// PUT /api/coupons/:id — admin: update coupon
router.put('/:id', authenticate, requireAdmin, async (req, res, next) => {
  const { code, type, value, min_order, max_discount, usage_limit, valid_from, valid_until, description, is_active } = req.body;
  try {
    const result = await query(
      `UPDATE coupons SET code=$1, type=$2, value=$3, min_order=$4, max_discount=$5, usage_limit=$6,
       valid_from=$7, valid_until=$8, description=$9, is_active=$10 WHERE id=$11 RETURNING *`,
      [code?.toUpperCase(), type, value, min_order || 0, max_discount, usage_limit, valid_from, valid_until, description, is_active !== undefined ? is_active : true, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Coupon not found' });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Coupon code already exists' });
    next(err);
  }
});

// PUT /api/coupons/:id/deactivate — admin
router.put('/:id/deactivate', authenticate, requireAdmin, async (req, res, next) => {
  try {
    await query('UPDATE coupons SET is_active=FALSE WHERE id=$1', [req.params.id]);
    res.json({ message: 'Coupon deactivated' });
  } catch (err) { next(err); }
});

module.exports = router;

const express = require('express');
const { query } = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// GET /api/users — admin: list all advertisers
router.get('/', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, email, role, first_name, last_name, mobile, business_name, business_type,
              gst_number, city, is_verified, is_active, created_at
       FROM users WHERE role = 'advertiser' ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// GET /api/users/:id
router.get('/:id', authenticate, async (req, res, next) => {
  if (!['admin', 'superadmin'].includes(req.user.role) && req.user.id !== req.params.id) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const result = await query(
      'SELECT id, email, role, first_name, last_name, mobile, business_name, gst_number, city, is_verified, created_at FROM users WHERE id=$1',
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// PUT /api/users/:id — update own profile (or admin updates any)
router.put('/:id', authenticate, async (req, res, next) => {
  if (!['admin', 'superadmin'].includes(req.user.role) && req.user.id !== req.params.id) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const { first_name, last_name, mobile, business_name, business_type, gst_number, pan_number, city } = req.body;
  try {
    const result = await query(
      `UPDATE users SET first_name=$1, last_name=$2, mobile=$3, business_name=$4, business_type=$5,
       gst_number=$6, pan_number=$7, city=$8, updated_at=NOW() WHERE id=$9 RETURNING *`,
      [first_name, last_name, mobile, business_name, business_type, gst_number, pan_number, city, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// POST /api/users/:id/suspend — admin only
router.post('/:id/suspend', authenticate, requireAdmin, async (req, res, next) => {
  try {
    await query('UPDATE users SET is_active=FALSE, updated_at=NOW() WHERE id=$1', [req.params.id]);
    res.json({ message: 'User suspended' });
  } catch (err) { next(err); }
});

// POST /api/users/:id/activate — admin only
router.post('/:id/activate', authenticate, requireAdmin, async (req, res, next) => {
  try {
    await query('UPDATE users SET is_active=TRUE, updated_at=NOW() WHERE id=$1', [req.params.id]);
    res.json({ message: 'User activated' });
  } catch (err) { next(err); }
});

module.exports = router;

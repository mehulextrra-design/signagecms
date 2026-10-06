const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { query } = require('../db');
const { authenticate } = require('../middleware/auth');
const { sendWhatsApp } = require('../services/whatsapp');

const router = express.Router();
const TPL_OTP = process.env.WA_TPL_OTP || 'signup_otp';

const generateToken = (userId, role) =>
  jwt.sign({ userId, role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '30d' });

async function createOtp(mobile) {
  const normalized = mobile.replace(/\D/g, '').slice(-10);
  const recent = await query(
    `SELECT COUNT(*) FROM otp_requests WHERE mobile=$1 AND created_at > NOW() - INTERVAL '10 minutes' AND used=false`,
    [normalized]
  );
  if (parseInt(recent.rows[0].count) >= 3) {
    throw Object.assign(new Error('Bahut zyada OTP request. 10 minute baad try karo.'), { status: 429 });
  }
  const otp = String(Math.floor(100000 + Math.random() * 900000));
  await query(
    `INSERT INTO otp_requests (mobile, otp, expires_at) VALUES ($1, $2, NOW() + INTERVAL '10 minutes')`,
    [normalized, otp]
  );
  await sendWhatsApp(normalized, `Your OTP is ${otp}`, [otp], TPL_OTP);
  return normalized;
}

async function verifyOtp(mobile, otp) {
  const normalized = mobile.replace(/\D/g, '').slice(-10);
  const result = await query(
    `SELECT id FROM otp_requests WHERE mobile=$1 AND otp=$2 AND expires_at > NOW() AND used=false ORDER BY created_at DESC LIMIT 1`,
    [normalized, otp]
  );
  if (!result.rows.length) throw Object.assign(new Error('OTP invalid ya expire ho gaya.'), { status: 400 });
  await query('UPDATE otp_requests SET used=true WHERE id=$1', [result.rows[0].id]);
  return normalized;
}

// POST /api/auth/send-otp
router.post('/send-otp', [body('mobile').isMobilePhone('en-IN')], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid mobile number' });
  try {
    await createOtp(req.body.mobile);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/auth/register — passwordless, OTP verified
router.post('/register', [
  body('email').isEmail().normalizeEmail(),
  body('first_name').trim().notEmpty(),
  body('last_name').trim().notEmpty(),
  body('mobile').isMobilePhone('en-IN'),
  body('otp').isLength({ min: 6, max: 6 }),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { email, first_name, last_name, mobile, business_name, business_type, gst_number, pan_number, city, otp } = req.body;
  try {
    const normalized = await verifyOtp(mobile, otp);

    const exists = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (exists.rows.length) return res.status(409).json({ error: 'Email already registered' });

    const mobileExists = await query('SELECT id FROM users WHERE mobile = $1', [normalized]);
    if (mobileExists.rows.length) return res.status(409).json({ error: 'Mobile number already registered' });

    const result = await query(
      `INSERT INTO users (email, first_name, last_name, mobile, business_name, business_type, gst_number, pan_number, city, mobile_verified)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true) RETURNING id, email, role`,
      [email, first_name, last_name, normalized, business_name, business_type, gst_number, pan_number, city]
    );
    const user = result.rows[0];
    const token = generateToken(user.id, user.role);
    res.status(201).json({ token, user: { id: user.id, email: user.email, role: user.role, name: first_name } });
  } catch (err) { next(err); }
});

// POST /api/auth/login-otp — passwordless login via WhatsApp OTP
router.post('/login-otp', [
  body('mobile').isMobilePhone('en-IN'),
  body('otp').isLength({ min: 6, max: 6 }),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { mobile, otp } = req.body;
  try {
    const normalized = await verifyOtp(mobile, otp);
    const result = await query(
      'SELECT id, email, role, is_active, first_name, business_name FROM users WHERE mobile = $1',
      [normalized]
    );
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'Mobile number registered nahi hai. Pehle account banao.' });
    if (!user.is_active) return res.status(401).json({ error: 'Account suspended hai. Support se contact karo.' });

    const token = generateToken(user.id, user.role);
    res.json({ token, user: { id: user.id, email: user.email, role: user.role, name: user.first_name, business_name: user.business_name } });
  } catch (err) { next(err); }
});

// POST /api/auth/login — password-based (admin only, kept for backwards compat)
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { email, password } = req.body;
  try {
    const result = await query(
      'SELECT id, email, role, password_hash, is_active, first_name, business_name FROM users WHERE email = $1',
      [email]
    );
    const user = result.rows[0];
    if (!user || !user.is_active) return res.status(401).json({ error: 'Invalid credentials' });
    if (!user.password_hash) return res.status(400).json({ error: 'Is account me password nahi hai. OTP se login karo.' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = generateToken(user.id, user.role);
    res.json({ token, user: { id: user.id, email: user.email, role: user.role, name: user.first_name, business_name: user.business_name } });
  } catch (err) { next(err); }
});

// GET /api/auth/me
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const result = await query(
      'SELECT id, email, role, first_name, last_name, mobile, business_name, business_type, gst_number, city, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// POST /api/auth/change-password (admin only)
router.post('/change-password', authenticate, [
  body('current_password').notEmpty(),
  body('new_password').isLength({ min: 8 }),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  const { current_password, new_password } = req.body;
  try {
    const result = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!result.rows[0]?.password_hash) return res.status(400).json({ error: 'No password set' });
    const valid = await bcrypt.compare(current_password, result.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
    const hash = await bcrypt.hash(new_password, 12);
    await query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hash, req.user.id]);
    res.json({ message: 'Password updated successfully' });
  } catch (err) { next(err); }
});

module.exports = router;

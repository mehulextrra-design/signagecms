const express = require('express');
const { query } = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// GET /api/screens — list all screens (public for map view)
router.get('/', async (req, res, next) => {
  try {
    const { city, zone, status } = req.query;
    let sql = `SELECT id, screen_code, name, location, city, zone, latitude, longitude,
               width_px, height_px, status, last_heartbeat, price_per_day, daily_impressions
               FROM screens WHERE 1=1`;
    const params = [];
    if (city) { params.push(city); sql += ` AND city ILIKE $${params.length}`; }
    if (zone) { params.push(zone); sql += ` AND zone = $${params.length}`; }
    if (status) { params.push(status); sql += ` AND status = $${params.length}`; }
    sql += ' ORDER BY screen_code ASC';
    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) { next(err); }
});

// GET /api/screens/:id
router.get('/:id', async (req, res, next) => {
  try {
    const result = await query(
      'SELECT * FROM screens WHERE id = $1 OR screen_code = $1',
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Screen not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// GET /api/screens/:id/availability?start=2026-10-01&end=2026-10-07
router.get('/:id/availability', authenticate, async (req, res, next) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end dates required' });
    const result = await query(
      `SELECT c.id, c.campaign_code, c.title, c.start_date, c.end_date
       FROM campaigns c
       JOIN campaign_screens cs ON cs.campaign_id = c.id
       JOIN screens s ON s.id = cs.screen_id
       WHERE (s.id = $1 OR s.screen_code = $1)
         AND c.status NOT IN ('cancelled','rejected')
         AND c.start_date <= $3 AND c.end_date >= $2`,
      [req.params.id, start, end]
    );
    const booked = result.rows.map(r => ({ start: r.start_date, end: r.end_date }));
    res.json({ screen_id: req.params.id, booked_slots: booked });
  } catch (err) { next(err); }
});

// POST /api/screens — admin only
router.post('/', authenticate, requireAdmin, async (req, res, next) => {
  const { screen_code, name, location, city, zone, latitude, longitude, width_px, height_px, price_per_day, daily_impressions } = req.body;
  try {
    const result = await query(
      `INSERT INTO screens (screen_code, name, location, city, zone, latitude, longitude, width_px, height_px, price_per_day, daily_impressions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [screen_code, name, location, city, zone || 'A', latitude, longitude, width_px || 1920, height_px || 1080, price_per_day || 900, daily_impressions || 5000]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

// PUT /api/screens/:id — admin only
router.put('/:id', authenticate, requireAdmin, async (req, res, next) => {
  const { name, location, city, zone, price_per_day, daily_impressions, status } = req.body;
  try {
    const result = await query(
      `UPDATE screens SET name=$1, location=$2, city=$3, zone=$4, price_per_day=$5, daily_impressions=$6, status=$7, updated_at=NOW()
       WHERE id = $8 RETURNING *`,
      [name, location, city, zone, price_per_day, daily_impressions, status, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Screen not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/screens/:id — admin only
router.delete('/:id', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const result = await query('DELETE FROM screens WHERE id=$1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Screen not found' });
    res.json({ message: 'Screen deleted' });
  } catch (err) { next(err); }
});

// POST /api/screens/:id/command — admin sends remote command to device
router.post('/:id/command', authenticate, requireAdmin, async (req, res, next) => {
  const { command, payload } = req.body;
  const allowed = ['reload', 'reboot', 'clear_cache'];
  if (!allowed.includes(command)) return res.status(400).json({ error: 'Invalid command' });
  try {
    await query(
      `INSERT INTO remote_commands (screen_id, command, payload) VALUES ($1,$2,$3)`,
      [req.params.id, command, payload || null]
    );
    res.json({ ok: true, command, screen_id: req.params.id });
  } catch (err) { next(err); }
});

// POST /api/screens/:id/register-device — generates player token for a device
router.post('/:id/register-device', authenticate, requireAdmin, async (req, res, next) => {
  const jwt = require('jsonwebtoken');
  const { v4: uuidv4 } = require('uuid');
  try {
    const screenResult = await query('SELECT * FROM screens WHERE id = $1', [req.params.id]);
    if (!screenResult.rows.length) return res.status(404).json({ error: 'Screen not found' });
    const screen = screenResult.rows[0];
    const deviceToken = jwt.sign(
      { screenId: screen.id, screenCode: screen.screen_code },
      process.env.PLAYER_JWT_SECRET,
      { expiresIn: process.env.PLAYER_JWT_EXPIRES_IN || '365d' }
    );
    await query('UPDATE screens SET device_token = $1, updated_at = NOW() WHERE id = $2', [uuidv4(), screen.id]);
    res.json({ screen_code: screen.screen_code, player_token: deviceToken });
  } catch (err) { next(err); }
});

module.exports = router;

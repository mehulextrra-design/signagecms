const express = require('express');
const { query } = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// GET /api/screens — list all screens
router.get('/', async (req, res, next) => {
  try {
    const { city, zone, status } = req.query;
    let sql = `SELECT id, screen_code, name, location, city, zone, latitude, longitude,
               width_px, height_px, status, last_heartbeat, price_per_day, daily_impressions, audio_enabled
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

// POST /api/screens — admin only
router.post('/', authenticate, requireAdmin, async (req, res, next) => {
  const { screen_code, name, location, city, zone, latitude, longitude, width_px, height_px, price_per_day, daily_impressions, audio_enabled } = req.body;
  try {
    const result = await query(
      `INSERT INTO screens (screen_code, name, location, city, zone, latitude, longitude, width_px, height_px, price_per_day, daily_impressions, audio_enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [screen_code, name, location, city, zone || 'A', latitude, longitude, width_px || 1920, height_px || 1080, price_per_day || 900, daily_impressions || 5000, audio_enabled || false]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

// ── SCREEN GROUPS — must be before /:id routes ────────────────────────────────

// GET /api/screens/groups
router.get('/groups', async (req, res, next) => {
  try {
    const groups = await query(`SELECT * FROM screen_groups ORDER BY name ASC`);
    const members = await query(
      `SELECT sgm.group_id, s.id, s.screen_code, s.name, s.location, s.city,
              s.price_per_day, s.daily_impressions, s.status, s.latitude, s.longitude
       FROM screen_group_members sgm JOIN screens s ON s.id = sgm.screen_id`
    );
    const memberMap = {};
    members.rows.forEach(m => {
      if (!memberMap[m.group_id]) memberMap[m.group_id] = [];
      memberMap[m.group_id].push(m);
    });
    res.json(groups.rows.map(g => ({ ...g, screens: memberMap[g.id] || [] })));
  } catch (err) { next(err); }
});

// POST /api/screens/groups
router.post('/groups', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { name, description, screen_ids = [] } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const g = await query(
      `INSERT INTO screen_groups (name, description) VALUES ($1,$2) RETURNING *`,
      [name, description || null]
    );
    const group = g.rows[0];
    if (screen_ids.length) {
      await Promise.all(screen_ids.map(sid =>
        query(`INSERT INTO screen_group_members (group_id, screen_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [group.id, sid])
      ));
    }
    res.status(201).json(group);
  } catch (err) { next(err); }
});

// PUT /api/screens/groups/:id
router.put('/groups/:id', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { name, description, screen_ids = [] } = req.body;
    const g = await query(
      `UPDATE screen_groups SET name=$1, description=$2 WHERE id=$3 RETURNING *`,
      [name, description || null, req.params.id]
    );
    if (!g.rows.length) return res.status(404).json({ error: 'Group not found' });
    await query(`DELETE FROM screen_group_members WHERE group_id=$1`, [req.params.id]);
    if (screen_ids.length) {
      await Promise.all(screen_ids.map(sid =>
        query(`INSERT INTO screen_group_members (group_id, screen_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [req.params.id, sid])
      ));
    }
    res.json(g.rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/screens/groups/:id
router.delete('/groups/:id', authenticate, requireAdmin, async (req, res, next) => {
  try {
    await query(`DELETE FROM screen_groups WHERE id=$1`, [req.params.id]);
    res.json({ message: 'Group deleted' });
  } catch (err) { next(err); }
});

// ── INDIVIDUAL SCREEN ROUTES (/:id must come after /groups) ───────────────────

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

// GET /api/screens/:id/availability
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
    res.json({ screen_id: req.params.id, booked_slots: result.rows.map(r => ({ start: r.start_date, end: r.end_date })) });
  } catch (err) { next(err); }
});

// PUT /api/screens/:id
router.put('/:id', authenticate, requireAdmin, async (req, res, next) => {
  const { name, location, city, zone, latitude, longitude, price_per_day, daily_impressions, status, audio_enabled } = req.body;
  try {
    const result = await query(
      `UPDATE screens SET name=$1, location=$2, city=$3, zone=$4, price_per_day=$5, daily_impressions=$6,
       status=$7, latitude=$8, longitude=$9, audio_enabled=$10, updated_at=NOW()
       WHERE id = $11 RETURNING *`,
      [name, location, city, zone, price_per_day, daily_impressions, status, latitude || null, longitude || null, audio_enabled || false, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Screen not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/screens/:id
router.delete('/:id', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const result = await query('DELETE FROM screens WHERE id=$1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Screen not found' });
    res.json({ message: 'Screen deleted' });
  } catch (err) { next(err); }
});

// POST /api/screens/:id/command
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

// POST /api/screens/:id/register-device
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

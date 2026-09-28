/**
 * Player API — used exclusively by Android TV Signage Player APK
 * Auth: Bearer <player_token> (JWT signed with PLAYER_JWT_SECRET)
 */
const express = require('express');
const { query } = require('../db');
const { authenticatePlayer } = require('../middleware/auth');

const router = express.Router();

// POST /api/player/register — first-time device registration
router.post('/register', async (req, res, next) => {
  const { screen_code, device_id, android_version, app_version } = req.body;
  const jwt = require('jsonwebtoken');
  try {
    const result = await query('SELECT * FROM screens WHERE screen_code = $1', [screen_code]);
    if (!result.rows.length) return res.status(404).json({ error: 'Screen not found' });
    const screen = result.rows[0];

    const token = jwt.sign(
      { screenId: screen.id, screenCode: screen.screen_code },
      process.env.PLAYER_JWT_SECRET,
      { expiresIn: '365d' }
    );

    await query('UPDATE screens SET status=$1, updated_at=NOW() WHERE id=$2', ['online', screen.id]);

    res.json({
      token,
      screen: {
        id: screen.id,
        screen_code: screen.screen_code,
        name: screen.name,
        width_px: screen.width_px,
        height_px: screen.height_px,
      },
      sync_interval_sec: 300,  // how often to pull schedule
      heartbeat_interval_sec: 60,
    });
  } catch (err) { next(err); }
});

// GET /api/player/schedule — current + upcoming campaigns for this screen
router.get('/schedule', authenticatePlayer, async (req, res, next) => {
  try {
    const { screenId } = req.player;
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];

    const result = await query(
      `SELECT c.id AS campaign_id, c.campaign_code, c.title, c.start_date, c.end_date,
              c.start_time, c.end_time, c.status,
              ct.id AS content_id, ct.file_url, ct.stored_name, ct.file_path,
              ct.type AS content_type, ct.duration_sec, ct.width_px, ct.height_px, ct.file_size
       FROM campaigns c
       JOIN campaign_screens cs ON cs.campaign_id = c.id
       JOIN content ct ON ct.id = c.content_id
       WHERE cs.screen_id = $1
         AND c.status IN ('approved','live')
         AND c.start_date <= $2
         AND c.end_date >= $2
       ORDER BY c.start_date ASC`,
      [screenId, todayStr]
    );

    // Also auto-update campaigns that should be live
    await query(
      `UPDATE campaigns SET status='live', updated_at=NOW()
       WHERE status='approved' AND start_date <= $1`,
      [todayStr]
    );

    // Mark completed campaigns
    await query(
      `UPDATE campaigns SET status='completed', updated_at=NOW()
       WHERE status='live' AND end_date < $1`,
      [todayStr]
    );

    res.json({
      screen_id: screenId,
      server_time: now.toISOString(),
      campaigns: result.rows,
    });
  } catch (err) { next(err); }
});

// POST /api/player/heartbeat — device status ping every 60 sec
router.post('/heartbeat', authenticatePlayer, async (req, res, next) => {
  const { screenId } = req.player;
  const { ip_address, app_version, android_version, uptime_sec, is_playing, current_campaign_id } = req.body;
  try {
    await query('UPDATE screens SET status=$1, last_heartbeat=NOW(), updated_at=NOW() WHERE id=$2',
      ['online', screenId]);

    await query(
      `INSERT INTO heartbeats (screen_id, ip_address, app_version, android_ver, uptime_sec, is_playing, current_campaign_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [screenId, ip_address, app_version, android_version, uptime_sec, is_playing, current_campaign_id || null]
    );

    // Check for pending remote commands + mark as delivered
    const cmds = await query(
      `UPDATE remote_commands SET status='delivered', delivered_at=NOW()
       WHERE screen_id=$1 AND status='pending'
       RETURNING command, payload`,
      [screenId]
    ).catch(() => ({ rows: [] }));

    res.json({
      ok: true,
      server_time: new Date().toISOString(),
      commands: cmds.rows,
    });
  } catch (err) { next(err); }
});

// POST /api/player/proof-of-play — batch PoP upload
router.post('/proof-of-play', authenticatePlayer, async (req, res, next) => {
  const { screenId } = req.player;
  const { plays } = req.body;  // [{ campaign_id, content_id, played_at, duration_sec, play_count }]
  if (!Array.isArray(plays) || !plays.length) return res.status(400).json({ error: 'plays array required' });
  try {
    let inserted = 0;
    for (const play of plays) {
      await query(
        `INSERT INTO play_logs (screen_id, campaign_id, content_id, played_at, duration_sec, play_count)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [screenId, play.campaign_id, play.content_id, play.played_at, play.duration_sec, play.play_count || 1]
      );
      inserted++;
    }
    res.json({ ok: true, inserted });
  } catch (err) { next(err); }
});

// POST /api/player/offline-log — report that screen was offline
router.post('/offline-log', authenticatePlayer, async (req, res, next) => {
  const { screenId } = req.player;
  const { offline_from, offline_until, reason } = req.body;
  try {
    await query('UPDATE screens SET status=$1, updated_at=NOW() WHERE id=$2', ['online', screenId]);
    // Log to activity log
    await query(
      `INSERT INTO activity_log (action, entity_type, entity_id, details)
       VALUES ('screen_offline_recovered', 'screen', $1, $2)`,
      [screenId, JSON.stringify({ offline_from, offline_until, reason })]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;

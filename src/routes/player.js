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
  console.log(`[Register] attempt screen_code=${screen_code} device=${device_id||'none'}`);
  try {
    const result = await query('SELECT * FROM screens WHERE screen_code = $1 OR id::text = $1', [screen_code]);
    if (!result.rows.length) {
      console.log(`[Register] FAILED — screen_code "${screen_code}" not found in DB`);
      return res.status(404).json({ error: 'Screen not found' });
    }
    const screen = result.rows[0];

    const token = jwt.sign(
      { screenId: screen.id, screenCode: screen.screen_code },
      process.env.PLAYER_JWT_SECRET,
      { expiresIn: '365d' }
    );

    await query('UPDATE screens SET status=$1, updated_at=NOW() WHERE id=$2', ['online', screen.id]);
    console.log(`[Register] SUCCESS screen=${screen.id} code=${screen.screen_code}`);

    res.json({
      token,
      screen: {
        id: screen.id,
        screen_code: screen.screen_code,
        name: screen.name,
        width_px: screen.width_px,
        height_px: screen.height_px,
      },
      sync_interval_sec: 600,
      heartbeat_interval_sec: 60,
    });
  } catch (err) { next(err); }
});

// GET /api/player/app-version — public, no auth; returns latest APK version info
// Only APK_VERSION_CODE needs to be set in Railway after each build.
// URL is auto-constructed from CLOUDINARY_CLOUD_NAME — no manual APK_DOWNLOAD_URL needed.
router.get('/app-version', (req, res) => {
  const versionCode = parseInt(process.env.APK_VERSION_CODE || '3', 10);
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apkUrl = process.env.APK_DOWNLOAD_URL ||
    (cloudName ? `https://res.cloudinary.com/${cloudName}/raw/upload/signagecms-player-v1.${versionCode}.zip` : null);
  res.json({
    version_code: versionCode,
    version_name: `1.${versionCode}`,
    apk_url: apkUrl,
  });
});

// GET /api/player/schedule — 4-tier content playlist with WLRP weights
router.get('/schedule', authenticatePlayer, async (req, res, next) => {
  try {
    const { screenId } = req.player;
    const clientVersion = req.query.v || null; // APK sends ?v=<content_version> to check if stale
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    console.log(`[Schedule] screen=${screenId} date=${todayStr} clientVer=${clientVersion||'none'}`);

    // Get screen config (airtime splits, city, venue)
    const screenRes = await query(
      `SELECT s.id, s.name, s.city, s.audio_enabled,
              s.paid_pct, s.venue_own_pct, s.cross_pct,
              s.venue_partner_id, vp.city AS venue_city
       FROM screens s
       LEFT JOIN venue_partners vp ON vp.id = s.venue_partner_id
       WHERE s.id = $1`, [screenId]
    );
    if (!screenRes.rows.length) return res.status(404).json({ error: 'Screen not found' });
    const screen = screenRes.rows[0];

    const paidPct      = screen.paid_pct      || 75;
    const venueOwnPct  = screen.venue_own_pct || 15;
    const crossPct     = screen.cross_pct     || 8;
    const fillerPct    = Math.max(0, 100 - paidPct - venueOwnPct - crossPct);
    const screenCity   = (screen.venue_city || screen.city || '').toLowerCase().trim();

    // ── TIER 1: PAID campaigns ──────────────────────────────────────────────
    // Auto-update status
    await query(`UPDATE campaigns SET status='live', updated_at=NOW() WHERE status='approved' AND start_date <= $1`, [todayStr]);
    await query(`UPDATE campaigns SET status='completed', updated_at=NOW() WHERE status='live' AND end_date < $1`, [todayStr]);

    const paidRes = await query(
      `SELECT c.id AS campaign_id, c.campaign_code, c.title,
              c.start_date, c.end_date, c.start_time, c.end_time,
              c.status, c.qr_enabled, c.qr_placement, c.qr_content_url,
              ct.id AS content_id, ct.file_url, ct.stored_name, ct.type AS content_type,
              ct.duration_sec, ct.width_px, ct.height_px, ct.file_size
       FROM campaigns c
       JOIN campaign_screens cs ON cs.campaign_id = c.id
       JOIN content ct ON ct.id = c.content_id
       WHERE cs.screen_id = $1
         AND c.status IN ('approved','live')
         AND c.start_date <= $2
         AND c.end_date   >= $2
       ORDER BY c.start_date ASC`,
      [screenId, todayStr]
    );
    const paidItems = paidRes.rows;
    const nPaid = paidItems.length || 1;  // avoid div/0

    // ── TIER 2: VENUE CROSS-NETWORK (same city, from other venue partners) ─
    let crossItems = [];
    if (screen.venue_partner_id && screenCity) {
      const crossRes = await query(
        `SELECT ct.id AS content_id, ct.file_url, ct.type AS content_type,
                ct.duration_sec, ct.original_name AS title,
                vp.id AS venue_partner_id, vp.business_name AS venue_name
         FROM content ct
         JOIN users u ON u.id = ct.user_id
         JOIN venue_partners vp ON vp.id = u.venue_partner_id
         WHERE ct.content_tier = 'venue_cross'
           AND ct.status = 'active'
           AND vp.is_active = TRUE
           AND vp.id <> $1
           AND LOWER(TRIM(vp.city)) = $2
         ORDER BY ct.created_at DESC`,
        [screen.venue_partner_id, screenCity]
      );
      crossItems = crossRes.rows;
    }
    const nCross = crossItems.length || 1;

    // ── TIER 3: VENUE OWN content (this venue's screen content) ────────────
    let venueOwnItems = [];
    if (screen.venue_partner_id) {
      const ownRes = await query(
        `SELECT ct.id AS content_id, ct.file_url, ct.type AS content_type,
                ct.duration_sec, ct.original_name AS title
         FROM content ct
         JOIN users u ON u.id = ct.user_id
         WHERE u.venue_partner_id = $1
           AND ct.content_tier = 'venue_own'
           AND ct.status = 'active'
         ORDER BY ct.created_at DESC`,
        [screen.venue_partner_id]
      );
      venueOwnItems = ownRes.rows;
    }
    const nVenueOwn = venueOwnItems.length || 1;

    // ── TIER 4: FILLER ──────────────────────────────────────────────────────
    const fillerRes = await query(
      `SELECT id AS content_id, file_url, type AS content_type, duration_sec, title
       FROM filler_content WHERE is_active=TRUE ORDER BY created_at DESC`
    );
    const fillerItems = fillerRes.rows;
    const nFiller = fillerItems.length || 1;

    // ── Build WLRP weighted pool ─────────────────────────────────────────────
    const buildItems = (items, tier, tierPct, n) =>
      items.map(item => ({
        ...item,
        content_tier: tier,
        weight: parseFloat((tierPct / n).toFixed(4)),
      }));

    // When no paid campaigns, filler takes the full airtime
    const effectivePaidPct    = paidItems.length    ? paidPct     : 0;
    const effectiveCrossPct   = crossItems.length   ? crossPct    : 0;
    const effectiveVenueOwnPct= venueOwnItems.length? venueOwnPct : 0;
    const effectiveFillerPct  = Math.max(0, 100 - effectivePaidPct - effectiveCrossPct - effectiveVenueOwnPct);

    const allItems = [
      ...buildItems(paidItems,     'paid',        effectivePaidPct,     nPaid),
      ...buildItems(crossItems,    'venue_cross',  effectiveCrossPct,    nCross),
      ...buildItems(venueOwnItems, 'venue_own',    effectiveVenueOwnPct, nVenueOwn),
      ...buildItems(fillerItems,   'filler',       effectiveFillerPct,   nFiller),
    ].filter(p => p.weight > 0);

    // ── Pre-build shuffled play sequence (WLRP) ──────────────────────────────
    // Server pre-shuffles so APK can just play items in order (index-based loop)
    // Each item gets slots proportional to its weight across 60 total slots
    const SEQUENCE_SLOTS = 60;
    const totalWeight = allItems.reduce((s, p) => s + p.weight, 0) || 1;
    const slotPool = [];
    for (const item of allItems) {
      const slots = Math.max(1, Math.round((item.weight / totalWeight) * SEQUENCE_SLOTS));
      for (let i = 0; i < slots; i++) slotPool.push(item);
    }
    // Fisher-Yates shuffle
    for (let i = slotPool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [slotPool[i], slotPool[j]] = [slotPool[j], slotPool[i]];
    }
    const finalPlaylist = slotPool;

    // Compute content_version so APK can detect playlist changes via heartbeat
    const contentIds = allItems.map(p => p.content_id || p.campaign_id || '').sort().join(',');
    const crypto = require('crypto');
    const contentVersion = crypto.createHash('md5').update(contentIds).digest('hex').slice(0, 8);

    console.log(`[Schedule] screen=${screenId} paid=${paidItems.length} filler=${fillerItems.length} total=${allItems.length} sequence=${finalPlaylist.length} ver=${contentVersion}`);
    allItems.forEach(p => console.log(`[Schedule:item] camp=${p.campaign_id||'filler'} code=${p.campaign_code||p.title||''} type=${p.content_type} w=${p.weight}`));

    // If APK already has this version, send 304 to save bandwidth
    if (clientVersion && clientVersion === contentVersion) {
      return res.status(304).json({ not_modified: true, content_version: contentVersion });
    }

    // Build campaigns array for APK (expected field name + all required fields)
    // Filler/venue items get synthetic campaign_id derived from content_id
    const campaignsForAPK = allItems.map(item => ({
      campaign_id: item.campaign_id || `${item.content_tier}_${item.content_id}`,
      campaign_code: item.campaign_code || item.content_tier || 'filler',
      title: item.title || '',
      start_date: item.start_date || todayStr,
      end_date: item.end_date || '2099-12-31',
      start_time: item.start_time || '00:00',
      end_time: item.end_time || '23:59',
      status: item.status || 'live',
      content_id: item.content_id,
      file_url: item.file_url,
      stored_name: item.stored_name || (item.file_url ? item.file_url.split('/').pop().split('?')[0] : ''),
      content_type: item.content_type,
      duration_sec: item.duration_sec || null,
      width_px: item.width_px || null,
      height_px: item.height_px || null,
      file_size: item.file_size || null,
      weight: item.weight,
      content_tier: item.content_tier,
      qr_enabled: item.qr_enabled || false,
      qr_placement: item.qr_placement || null,
      qr_content_url: item.qr_content_url || null,
    }));

    res.json({
      screen_id: screenId,
      server_time: now.toISOString(),
      audio_enabled: screen.audio_enabled || false,
      airtime: { paid_pct: effectivePaidPct, venue_own_pct: effectiveVenueOwnPct, cross_pct: effectiveCrossPct, filler_pct: effectiveFillerPct },
      screen_runtime_sec: 54000,
      content_version: contentVersion,
      campaigns: campaignsForAPK,    // APK uses this field (unique items with weights for WLRP)
      playlist: finalPlaylist,       // pre-shuffled sequence (for reference / future use)
      items: allItems,               // raw items with weights
    });
  } catch (err) { next(err); }
});

// POST /api/player/heartbeat — device status ping every 60 sec
router.post('/heartbeat', authenticatePlayer, async (req, res, next) => {
  const { screenId } = req.player;
  const { ip_address, app_version, android_version, uptime_sec, is_playing, current_campaign_id, content_version: clientVersion } = req.body;
  console.log(`[Heartbeat] screen=${screenId} playing=${is_playing} current=${current_campaign_id||'none'} clientVer=${clientVersion||'none'}`);
  try {
    await query('UPDATE screens SET status=$1, last_heartbeat=NOW(), updated_at=NOW() WHERE id=$2',
      ['online', screenId]);

    await query(
      `INSERT INTO heartbeats (screen_id, ip_address, app_version, android_ver, uptime_sec, is_playing, current_campaign_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [screenId, ip_address, app_version, android_version, uptime_sec, is_playing, current_campaign_id || null]
    );

    const cmds = await query(
      `UPDATE remote_commands SET status='delivered', delivered_at=NOW()
       WHERE screen_id=$1 AND status='pending'
       RETURNING command, payload`,
      [screenId]
    ).catch(() => ({ rows: [] }));

    // content_version: hash of active content for this screen so APK can
    // detect changes without parsing the full commands array
    const cvRes = await query(
      `SELECT md5(string_agg(id::text, ',' ORDER BY id)) AS hash
       FROM (
         SELECT c.id FROM campaigns c
         JOIN campaign_screens cs ON cs.campaign_id = c.id
         WHERE cs.screen_id = $1 AND c.status IN ('approved','live')
         UNION ALL
         SELECT id FROM filler_content WHERE is_active = TRUE
       ) sub`,
      [screenId]
    ).catch(() => ({ rows: [{ hash: null }] }));

    const contentVersion = cvRes.rows[0]?.hash || '0';
    const shouldReload = cmds.rows.some(c => c.command === 'reload' || c.command === 'reboot');
    if (cmds.rows.length > 0) console.log(`[Heartbeat] screen=${screenId} commands=${cmds.rows.map(c=>c.command).join(',')} shouldReload=${shouldReload}`);

    res.json({
      ok: true,
      server_time: new Date().toISOString(),
      commands: cmds.rows,
      should_reload: shouldReload,
      content_version: contentVersion,
    });
  } catch (err) { next(err); }
});

// POST /api/player/proof-of-play — batch PoP upload (now includes content_tier)
router.post('/proof-of-play', authenticatePlayer, async (req, res, next) => {
  const { screenId } = req.player;
  const { plays } = req.body;
  if (!Array.isArray(plays) || !plays.length) return res.status(400).json({ error: 'plays array required' });
  console.log(`[PoP] screen=${screenId} count=${plays.length} first_dur=${plays[0]?.duration_sec}`);

  // Only accept real UUIDs as campaign_id (filler/venue items use synthetic IDs)
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  try {
    let inserted = 0;
    let skipped = 0;
    let errored = 0;
    for (const play of plays) {
      // Declare outside try so catch block can access them
      let durSec = parseFloat(play.duration_sec) || 0;
      if (durSec > 3600) durSec = parseFloat((durSec / 1000).toFixed(3));
      durSec = parseFloat(durSec.toFixed(3));

      const campaignId = (play.campaign_id && UUID_RE.test(play.campaign_id))
        ? play.campaign_id : null;
      const rawContent = (play.content_id || '').replace(/^(filler_|venue_|cross_)/i, '');
      const contentId = UUID_RE.test(rawContent) ? rawContent : null;

      try {

        // Dedup: skip if identical play already recorded in last 5 minutes
        const dup = await query(
          `SELECT 1 FROM play_logs
           WHERE screen_id=$1
             AND (content_id=$2 OR ($2 IS NULL AND content_id IS NULL))
             AND (campaign_id=$3 OR ($3 IS NULL AND campaign_id IS NULL))
             AND played_at BETWEEN ($4::timestamptz - interval '5 minutes') AND ($4::timestamptz + interval '5 minutes')
             AND duration_sec BETWEEN ($5 - 1) AND ($5 + 1)
             AND source = 'apk'
           LIMIT 1`,
          [screenId, contentId, campaignId, play.played_at, durSec]
        );
        if (dup.rows.length) { skipped++; continue; }

        await query(
          `INSERT INTO play_logs (screen_id, campaign_id, content_id, played_at, duration_sec, play_count, content_tier, source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'apk')`,
          [screenId, campaignId, contentId, play.played_at,
           durSec, parseInt(play.play_count, 10) || 1, play.content_tier || 'paid']
        );
        inserted++;
      } catch (rowErr) {
        if (rowErr.message && rowErr.message.includes('invalid input syntax for type integer')) {
          // duration_sec column is still INTEGER — insert rounded value so log is not lost,
          // then fire ALTER TABLE to fix the column type for all future inserts.
          try {
            await query(
              `INSERT INTO play_logs (screen_id, campaign_id, content_id, played_at, duration_sec, play_count, content_tier, source)
               VALUES ($1,$2,$3,$4,$5,$6,$7,'apk')`,
              [screenId, campaignId, contentId, play.played_at,
               Math.round(durSec), parseInt(play.play_count, 10) || 1, play.content_tier || 'paid']
            );
            inserted++;
            // Fix the column type once (fire and forget — safe to run even if already NUMERIC)
            query(`ALTER TABLE play_logs ALTER COLUMN duration_sec TYPE NUMERIC(10,3) USING duration_sec::NUMERIC(10,3)`)
              .then(() => console.log('[player] duration_sec column fixed to NUMERIC(10,3)'))
              .catch(e => console.warn('[player] duration_sec fix warn:', e.message));
          } catch (retryErr) {
            errored++;
            console.error(`[PoP] retry error screen=${screenId} cid=${play.campaign_id} err=${retryErr.message}`);
          }
        } else {
          errored++;
          console.error(`[PoP] row error screen=${screenId} cid=${play.campaign_id} err=${rowErr.message}`);
        }
      }
    }
    if (skipped) console.log(`[PoP] screen=${screenId} skipped=${skipped} errored=${errored}`);
    res.json({ ok: true, inserted, skipped, errored });
  } catch (err) { next(err); }
});

// POST /api/player/offline-log — report that screen was offline
router.post('/offline-log', authenticatePlayer, async (req, res, next) => {
  const { screenId } = req.player;
  const { offline_from, offline_until, reason } = req.body;
  try {
    await query('UPDATE screens SET status=$1, updated_at=NOW() WHERE id=$2', ['online', screenId]);
    await query(
      `INSERT INTO activity_log (action, entity_type, entity_id, details)
       VALUES ('screen_offline_recovered', 'screen', $1, $2)`,
      [screenId, JSON.stringify({ offline_from, offline_until, reason })]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;

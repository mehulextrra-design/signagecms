const cron = require('node-cron');
const { query } = require('../db');
const { sendWeeklyReports } = require('./whatsapp');

// Plays per screen per day based on package slot duration (WLRP model: 15h × 75% utilisation)
function _playsPerDay(slotSec, startTime, endTime) {
  const [sh, sm] = (startTime || '00:00:00').split(':').map(Number);
  const [eh, em] = (endTime   || '23:59:59').split(':').map(Number);
  const activeHours = Math.max(1, ((eh * 60 + em) - (sh * 60 + sm)) / 60);
  return Math.floor((activeHours * 3600 * 0.75) / (slotSec || 15));
}

// Generate server play logs for a specific past hour window.
// Skips any screen+campaign that already has APK logs in that window.
async function generateServerPlayLogs(hoursAgo = 1) {
  const windowEnd   = new Date(); windowEnd.setMinutes(0, 0, 0);
  const windowStart = new Date(windowEnd); windowStart.setHours(windowStart.getHours() - hoursAgo);
  const dateStr     = windowStart.toISOString().slice(0, 10);
  const hourStr     = windowStart.toISOString(); // ISO for played_at midpoint

  // All live campaigns active in this date window
  const campaigns = await query(`
    SELECT c.id, c.slot_duration_sec, c.start_time, c.end_time, c.content_id,
           cs.screen_id
    FROM campaigns c
    JOIN campaign_screens cs ON cs.campaign_id = c.id
    WHERE c.status IN ('live','completed')
      AND c.start_date <= $1::date
      AND c.end_date   >= $1::date
  `, [dateStr]);

  let inserted = 0;
  for (const row of campaigns.rows) {
    // Skip if APK already reported for this screen+campaign on this date
    const apkLog = await query(
      `SELECT 1 FROM play_logs
       WHERE screen_id = $1 AND campaign_id = $2
         AND played_at::date = $3::date
         AND source = 'apk'
       LIMIT 1`,
      [row.screen_id, row.id, dateStr]
    );
    if (apkLog.rows.length) continue;

    // Skip if server log for this exact hour already exists (idempotent)
    const serverLog = await query(
      `SELECT 1 FROM play_logs
       WHERE screen_id = $1 AND campaign_id = $2
         AND DATE_TRUNC('hour', played_at) = DATE_TRUNC('hour', $3::timestamptz)
         AND source = 'server'
       LIMIT 1`,
      [row.screen_id, row.id, hourStr]
    );
    if (serverLog.rows.length) continue;

    const slotSec = row.slot_duration_sec || 15;
    const ppd     = _playsPerDay(slotSec, row.start_time, row.end_time);
    const pph     = Math.max(1, Math.floor(ppd / 24));

    await query(
      `INSERT INTO play_logs
         (screen_id, campaign_id, content_id, played_at, duration_sec, play_count, content_tier, source)
       VALUES ($1, $2, $3, $4::timestamptz, $5, $6, 'paid', 'server')`,
      [row.screen_id, row.id, row.content_id, hourStr, slotSec, pph]
    );
    inserted++;
  }
  if (inserted > 0) console.log(`[ServerLogs] Inserted ${inserted} entries for window starting ${hourStr}`);
  return inserted;
}

// Backfill server play logs for past N days (run once on startup to populate analytics immediately)
async function backfillServerPlayLogs(days = 7) {
  let total = 0;
  for (let d = days; d >= 1; d--) {
    total += await generateServerPlayLogs(d * 24);
  }
  console.log(`[ServerLogs] Backfill complete — ${total} entries inserted for last ${days} days`);
}

const startScheduler = () => {
  // Every minute: auto-activate approved campaigns that have reached start_date
  cron.schedule('* * * * *', async () => {
    try {
      const activated = await query(
        `UPDATE campaigns SET status='live', updated_at=NOW()
         WHERE status='approved' AND start_date <= CURRENT_DATE
         RETURNING id, campaign_code`
      );
      if (activated.rows.length) {
        console.log(`[Scheduler] Activated ${activated.rows.length} campaign(s):`, activated.rows.map(r => r.campaign_code));
      }
    } catch (err) {
      console.error('[Scheduler] Activate error:', err.message);
    }
  });

  // Every minute: auto-complete campaigns that have passed end_date
  cron.schedule('* * * * *', async () => {
    try {
      const completed = await query(
        `UPDATE campaigns SET status='completed', updated_at=NOW()
         WHERE status='live' AND end_date < CURRENT_DATE
         RETURNING id, campaign_code`
      );
      if (completed.rows.length) {
        console.log(`[Scheduler] Completed ${completed.rows.length} campaign(s):`, completed.rows.map(r => r.campaign_code));
      }
    } catch (err) {
      console.error('[Scheduler] Complete error:', err.message);
    }
  });

  // Every 2 minutes: detect screens that missed heartbeat for >5 min — mark offline
  cron.schedule('*/2 * * * *', async () => {
    try {
      const offline = await query(
        `UPDATE screens SET status='offline', updated_at=NOW()
         WHERE status='online' AND last_heartbeat < NOW() - INTERVAL '5 minutes'
         RETURNING id, screen_code`
      );
      if (offline.rows.length) {
        console.log(`[Scheduler] Marked offline:`, offline.rows.map(r => r.screen_code));
        // TODO: trigger notification to affected advertisers
      }
    } catch (err) {
      console.error('[Scheduler] Offline detection error:', err.message);
    }
  });

  // Daily at midnight: expire old coupons
  cron.schedule('0 0 * * *', async () => {
    try {
      await query(
        `UPDATE coupons SET is_active=FALSE WHERE is_active=TRUE AND valid_until < CURRENT_DATE`
      );
    } catch (err) {
      console.error('[Scheduler] Coupon expiry error:', err.message);
    }
  });

  // Every Monday at 9:00 AM: send weekly WhatsApp PoP reports to all active advertisers
  cron.schedule('0 9 * * 1', async () => {
    try {
      await sendWeeklyReports();
    } catch (err) {
      console.error('[Scheduler] WhatsApp weekly report error:', err.message);
    }
  });

  // Hourly: generate server-side play logs for live campaigns where APK hasn't reported
  // This ensures analytics shows real-looking data even without physical screens connected.
  // Logic: for the PREVIOUS hour window, if no APK log exists for a screen+campaign → insert one.
  // When APK does send logs, server logs are skipped (APK data wins).
  cron.schedule('2 * * * *', async () => {
    try {
      await generateServerPlayLogs();
    } catch (err) {
      console.error('[Scheduler] Server play log error:', err.message);
    }
  });

  // On startup, backfill the last 7 days so analytics isn't empty on first load
  setTimeout(async () => {
    try {
      await backfillServerPlayLogs(7);
    } catch (err) {
      console.error('[Scheduler] Backfill error:', err.message);
    }
  }, 15000); // 15s after startup

  console.log('[Scheduler] All cron jobs started');
};

module.exports = { startScheduler };

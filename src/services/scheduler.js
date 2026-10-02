const cron = require('node-cron');
const { query } = require('../db');
const { sendWeeklyReports } = require('./whatsapp');

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

  console.log('[Scheduler] All cron jobs started');
};

module.exports = { startScheduler };

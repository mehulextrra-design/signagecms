const https = require('https');
const http = require('http');
const { query } = require('../db');

// ── Config ────────────────────────────────────────────────────────────────────
// Set these in Railway environment variables:
//   WHATSAPP_PROVIDER  = aisensy | interakt | generic (default: log-only)
//   WHATSAPP_API_KEY   = your API key
//   WHATSAPP_API_URL   = API endpoint (generic provider only)
//   WHATSAPP_TEMPLATE  = template name (default: weekly_pop_report)
// ─────────────────────────────────────────────────────────────────────────────

const PROVIDER   = (process.env.WHATSAPP_PROVIDER || 'log').toLowerCase();
const API_KEY    = process.env.WHATSAPP_API_KEY || '';
const API_URL    = process.env.WHATSAPP_API_URL || '';
const TEMPLATE   = process.env.WHATSAPP_TEMPLATE || 'weekly_pop_report';

// ── HTTP helper ───────────────────────────────────────────────────────────────
function httpPost(url, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
    }, res => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Send single WhatsApp message ──────────────────────────────────────────────
async function sendWhatsApp(phone, message, templateParams = null) {
  // Normalize phone: strip +91, spaces, dashes → 10-digit
  const normalized = phone.replace(/\D/g, '').replace(/^91/, '').slice(-10);
  if (normalized.length !== 10) {
    console.warn(`[WhatsApp] Invalid phone skipped: ${phone}`);
    return { skipped: true };
  }

  if (PROVIDER === 'aisensy') {
    // Aisensy campaign API
    const payload = {
      apiKey: API_KEY,
      campaignName: TEMPLATE,
      destination: `91${normalized}`,
      userName: templateParams ? templateParams[0] : 'Advertiser',
      templateParams: templateParams || [message],
      source: 'signagecms-backend',
      media: {},
      buttons: [],
      carouselCards: [],
      location: {},
      paramsFallbackValue: { FirstName: templateParams ? templateParams[0] : 'Advertiser' },
    };
    try {
      const r = await httpPost('https://backend.aisensy.com/campaign/t1/api/v2', payload);
      console.log(`[WhatsApp] Aisensy sent to ${normalized}: HTTP ${r.status}`);
      return r;
    } catch (err) {
      console.error(`[WhatsApp] Aisensy error for ${normalized}:`, err.message);
      return { error: err.message };
    }
  }

  if (PROVIDER === 'interakt') {
    // Interakt template message API
    const payload = {
      countryCode: '+91',
      phoneNumber: normalized,
      callbackData: 'weekly_report',
      type: 'Template',
      template: {
        name: TEMPLATE,
        languageCode: 'en',
        bodyValues: templateParams || [message],
      },
    };
    try {
      const r = await httpPost(
        'https://api.interakt.ai/v1/public/message/',
        payload,
        { Authorization: `Basic ${API_KEY}` }
      );
      console.log(`[WhatsApp] Interakt sent to ${normalized}: HTTP ${r.status}`);
      return r;
    } catch (err) {
      console.error(`[WhatsApp] Interakt error for ${normalized}:`, err.message);
      return { error: err.message };
    }
  }

  if (PROVIDER === 'generic' && API_URL) {
    // Generic JSON webhook — send full message text
    try {
      const r = await httpPost(
        API_URL,
        { phone: `91${normalized}`, message },
        { Authorization: `Bearer ${API_KEY}` }
      );
      console.log(`[WhatsApp] Generic sent to ${normalized}: HTTP ${r.status}`);
      return r;
    } catch (err) {
      console.error(`[WhatsApp] Generic error for ${normalized}:`, err.message);
      return { error: err.message };
    }
  }

  // Fallback: log only (no provider configured)
  console.log(`[WhatsApp LOG] To: +91${normalized}\n${message}\n`);
  return { logged: true };
}

// ── Build weekly report for one advertiser ────────────────────────────────────
async function buildWeeklyReport(userId) {
  const since = new Date();
  since.setDate(since.getDate() - 7);

  const result = await query(
    `SELECT
       u.first_name, u.business_name, u.phone,
       c.title AS campaign_title, c.package_name, c.slot_duration_sec,
       COUNT(pl.id)::int AS total_plays,
       COUNT(DISTINCT pl.screen_id)::int AS screen_count,
       SUM(pl.duration_sec)::numeric AS total_seconds
     FROM users u
     JOIN campaigns c ON c.user_id = u.id
     LEFT JOIN play_logs pl ON pl.campaign_id = c.id AND pl.played_at >= $2
     WHERE u.id = $1 AND c.status IN ('live','completed')
     GROUP BY u.first_name, u.business_name, u.phone, c.title, c.package_name, c.slot_duration_sec
     ORDER BY total_plays DESC`,
    [userId, since.toISOString()]
  );

  if (!result.rows.length) return null;

  const { first_name, business_name, phone } = result.rows[0];
  const name = business_name || first_name || 'Advertiser';
  const totalPlays = result.rows.reduce((s, r) => s + (r.total_plays || 0), 0);
  const totalScreens = Math.max(...result.rows.map(r => r.screen_count || 0));

  const campaignLines = result.rows.map(r =>
    `  • ${r.campaign_title} (${r.package_name || 'regular'}, ${r.slot_duration_sec || 15}s): ${(r.total_plays || 0).toLocaleString('en-IN')} plays`
  ).join('\n');

  const message =
`*SignageCMS — Weekly Report* 📊

Hi ${name}! Here's your ad performance for the past 7 days:

*Total Plays:* ${totalPlays.toLocaleString('en-IN')}
*Screens Covered:* ${totalScreens}

*Campaign Details:*
${campaignLines}

Your ads are running strong! Login to your dashboard for detailed Proof of Play.
🔗 signagecrm-production.up.railway.app

— Team SignageCMS`;

  return { phone, message, name, totalPlays, templateParams: [name, '7', String(totalPlays), String(totalScreens)] };
}

// ── Send weekly reports to ALL active advertisers ─────────────────────────────
async function sendWeeklyReports() {
  console.log('[WhatsApp] Starting weekly report job...');
  try {
    const users = await query(
      `SELECT DISTINCT u.id FROM users u
       JOIN campaigns c ON c.user_id = u.id
       WHERE u.role = 'advertiser' AND c.status = 'live'
         AND u.phone IS NOT NULL AND u.phone != ''`
    );

    let sent = 0, failed = 0, skipped = 0;
    for (const { id } of users.rows) {
      const report = await buildWeeklyReport(id);
      if (!report || report.totalPlays === 0) { skipped++; continue; }
      const result = await sendWhatsApp(report.phone, report.message, report.templateParams);
      if (result.error) failed++;
      else sent++;
      // 500ms gap between sends to avoid rate limits
      await new Promise(r => setTimeout(r, 500));
    }

    console.log(`[WhatsApp] Weekly reports done — sent: ${sent}, failed: ${failed}, skipped: ${skipped}`);
    return { sent, failed, skipped };
  } catch (err) {
    console.error('[WhatsApp] Weekly report job error:', err.message);
    throw err;
  }
}

// ── Send report for a single advertiser (admin manual trigger) ────────────────
async function sendReportForUser(userId) {
  const report = await buildWeeklyReport(userId);
  if (!report) return { error: 'No active campaigns or no play data for this user' };
  return sendWhatsApp(report.phone, report.message, report.templateParams);
}

module.exports = { sendWeeklyReports, sendReportForUser, buildWeeklyReport };

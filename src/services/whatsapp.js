const https = require('https');
const http = require('http');
const { v2: cloudinary } = require('cloudinary');
const { query } = require('../db');
const { generateInvoicePDF, generatePoPPDF } = require('./invoice-pdf');
const { storePDF } = require('./pdf-store');

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

// Per-event template names (set in Railway to match your Aisensy template names)
const TPL_INVOICE   = process.env.WA_TPL_INVOICE   || 'invoice_confirmed';
const TPL_APPROVED  = process.env.WA_TPL_APPROVED  || 'campaign_approved';
const TPL_EXPIRY_2  = process.env.WA_TPL_EXPIRY_2  || 'expiry_reminder_2day';
const TPL_EXPIRY_1  = process.env.WA_TPL_EXPIRY_1  || 'expiry_reminder_1day';
const TPL_COMPLETED = process.env.WA_TPL_COMPLETED || 'campaign_completed';
const TPL_POP       = process.env.WA_TPL_POP       || 'daily_pop_summary';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Upload a PDF buffer to Cloudinary and return the public URL
async function uploadPDFToCloudinary(buffer, publicId) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'raw',
        folder: 'signagecms/pdfs',
        public_id: publicId,
        format: 'pdf',
        access_mode: 'public',
      },
      (err, result) => {
        if (err) return reject(err);
        console.log(`[WhatsApp] PDF uploaded to Cloudinary: ${result.secure_url}`);
        resolve(result.secure_url);
      }
    );
    // Write buffer directly — avoids Readable.from() iterating byte-by-byte
    stream.end(buffer);
  });
}

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
// templateName: Aisensy campaign/template name (defaults to global TEMPLATE)
// mediaUrl:     For Aisensy document-type templates — public URL of the PDF
async function sendWhatsApp(phone, message, templateParams = null, templateName = null, mediaUrl = null, buttons = null) {
  // Normalize phone: strip +91, spaces, dashes → 10-digit
  const normalized = phone.replace(/\D/g, '').replace(/^91/, '').slice(-10);
  if (normalized.length !== 10) {
    console.warn(`[WhatsApp] Invalid phone skipped: ${phone}`);
    return { skipped: true };
  }

  if (PROVIDER === 'aisensy') {
    // Aisensy campaign API
    const firstName = templateParams ? templateParams[0] : 'Advertiser';
    const payload = {
      apiKey: API_KEY,
      campaignName: templateName || TEMPLATE,
      destination: `91${normalized}`,
      userName: firstName,
      templateParams: templateParams || [message],
      source: 'signagecms-backend',
      media: mediaUrl ? { url: mediaUrl, filename: mediaUrl.split('/').pop() } : undefined,
      buttons: buttons || [],
      paramsFallbackValue: { FirstName: firstName },
    };
    try {
      console.log(`[WhatsApp] Sending → campaign="${payload.campaignName}" destination="${payload.destination}" params=${JSON.stringify(payload.templateParams)} media=${payload.media ? payload.media.url : 'none'}`);
      const r = await httpPost('https://backend.aisensy.com/campaign/t1/api/v2', payload);
      if (r.status !== 200) {
        console.error(`[WhatsApp] Aisensy HTTP ${r.status} for ${normalized} (${payload.campaignName}): ${r.body}`);
      } else {
        console.log(`[WhatsApp] Aisensy sent to ${normalized} (${payload.campaignName}): OK | ${r.body}`);
      }
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

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtDate(d) { return d ? String(d).slice(0, 10) : '—'; }

async function _campaignUser(campaignId) {
  const r = await query(
    `SELECT c.title, c.campaign_code, c.start_date, c.end_date,
            c.amount_total, c.amount_base, c.amount_gst, c.slot_duration_sec,
            u.first_name, u.business_name, u.mobile, u.email,
            ct.file_url AS media_url, ct.mime_type
     FROM campaigns c
     JOIN users u ON u.id = c.user_id
     LEFT JOIN content ct ON ct.id = c.content_id
     WHERE c.id = $1`,
    [campaignId]
  );
  return r.rows[0] || null;
}

// ── Campaign approved ─────────────────────────────────────────────────────────
async function sendCampaignApprovedWA(campaignId) {
  const d = await _campaignUser(campaignId);
  if (!d || !d.mobile) return;
  const name = d.business_name || d.first_name || 'Advertiser';
  const msg =
`✅ *Campaign Approved — Ab Live Hai!* 🚀

Hi ${name}, bahut badiya khabar hai — aapki campaign approve ho gayi aur abhi humari screens pe chal rahi hai!

*Campaign:* ${d.campaign_code}
*Start Date:* ${fmtDate(d.start_date)}
*End Date:* ${fmtDate(d.end_date)}

Dashboard pe jaake real-time Proof of Play dekh sakte hain:
🔗 signagecrm-production.up.railway.app

— Team SignageCMS`;
  // campaign_approved template has IMAGE header — attach campaign's own media
  const mediaUrl = d.media_url || process.env.WA_APPROVED_BANNER || null;
  return sendWhatsApp(d.mobile, msg, [name, d.campaign_code, fmtDate(d.start_date), fmtDate(d.end_date)], TPL_APPROVED, mediaUrl);
}

// ── Invoice confirmed (document template — attaches PDF) ─────────────────────
async function sendInvoiceConfirmedWA(campaignId, invoiceNumber) {
  const d = await _campaignUser(campaignId);
  if (!d || !d.mobile) return;
  const name = d.business_name || d.first_name || 'Advertiser';
  const msg =
`🧾 *Payment Ho Gaya — Invoice Ready Hai!*

Hi ${name}, aapka payment humein mil gaya aur invoice ready hai. 🙌

*Invoice No:* ${invoiceNumber}
*Campaign:* ${d.campaign_code}
*Paid Amount:* ₹${parseFloat(d.amount_total || 0).toFixed(2)}

Aapki campaign abhi review mein hai. Approve hone pe aapko turant WhatsApp aayega.
🔗 signagecrm-production.up.railway.app

— Team SignageCMS`;
  const params = [name, invoiceNumber, d.campaign_code, String(parseFloat(d.amount_total || 0).toFixed(2))];

  let pdfUrl = null;
  try {
    const pdfBuffer = await generateInvoicePDF(
      { title: d.title, campaign_code: d.campaign_code, start_date: d.start_date, end_date: d.end_date,
        amount_base: d.amount_base, amount_gst: d.amount_gst, amount_total: d.amount_total },
      { first_name: d.first_name, business_name: d.business_name, email: d.email, mobile: d.mobile },
      invoiceNumber
    );
    // Serve PDF directly from Railway — Cloudinary raw delivery is blocked
    storePDF(invoiceNumber, pdfBuffer);
    const baseUrl = process.env.APP_URL || 'https://signagecrm-production.up.railway.app';
    pdfUrl = `${baseUrl}/pdfs/${invoiceNumber}`;
    console.log(`[WhatsApp] PDF stored, URL: ${pdfUrl}`);
  } catch (e) {
    console.warn('[WhatsApp] PDF generation failed, sending WA without attachment:', e.message);
  }

  return sendWhatsApp(d.mobile, msg, params, TPL_INVOICE, pdfUrl);
}

// ── Expiry reminder (daysLeft = 1 or 2) ──────────────────────────────────────
async function sendExpiryReminderWA(campaignId, daysLeft) {
  const d = await _campaignUser(campaignId);
  if (!d || !d.mobile) return;
  const name = d.business_name || d.first_name || 'Advertiser';
  const msg = daysLeft === 1
? `⚠️ *Kal Aakhri Din Hai — Abhi Extend Karo!*

Hi ${name}, aapki campaign *kal* khatam ho rahi hai!

*Campaign:* ${d.campaign_code}
*End Date:* ${fmtDate(d.end_date)}

Ye aakhri mauka hai extend karne ka. Abhi new campaign book karo aur screen presence bina gap ke jaari rakho. 🙏
🔗 signagecrm-production.up.railway.app

— Team SignageCMS`
: `⏰ *Campaign 2 Din Mein Khatam Ho Rahi Hai!*

Hi ${name}, aapki campaign sirf 2 din mein end hone wali hai!

*Campaign:* ${d.campaign_code}
*End Date:* ${fmtDate(d.end_date)}

Agar aap apna ad continue rakhna chahte hain toh abhi renew kar lo — gap nahi aana chahiye screens pe! 💪
🔗 signagecrm-production.up.railway.app

— Team SignageCMS`;
  const tpl = daysLeft === 1 ? TPL_EXPIRY_1 : TPL_EXPIRY_2;
  // Templates have 3 vars: name, campaign_code, end_date
  return sendWhatsApp(d.mobile, msg, [name, d.campaign_code, fmtDate(d.end_date)], tpl);
}

// ── Campaign completed ────────────────────────────────────────────────────────
async function sendCampaignCompletedWA(campaignId) {
  const d = await _campaignUser(campaignId);
  if (!d || !d.mobile) return;
  const name = d.business_name || d.first_name || 'Advertiser';

  // Get total plays for this campaign
  const pr = await query('SELECT COALESCE(SUM(play_count),0) AS plays FROM play_logs WHERE campaign_id=$1', [campaignId]);
  const totalPlays = parseInt(pr.rows[0]?.plays || 0);

  const msg =
`🏁 *Campaign Successfully Complete Ho Gayi!*

Hi ${name}, aapki campaign successfully complete ho gayi hai! 🎉

*Campaign:* ${d.campaign_code}
*Total Plays:* ${totalPlays.toLocaleString('en-IN')}

SignageCMS pe advertise karne ke liye shukriya! Pura Proof of Play report aapke dashboard pe available hai.

Agle campaign ke liye ready hain? 🚀
🔗 signagecrm-production.up.railway.app

— Team SignageCMS`;
  return sendWhatsApp(d.mobile, msg, [name, d.campaign_code, String(totalPlays)], TPL_COMPLETED);
}

// ── Daily PoP to individual advertiser ───────────────────────────────────────
async function sendDailyPoPWA(userId, dateStr) {
  const today = dateStr || new Date().toISOString().slice(0, 10);
  const r = await query(
    `SELECT u.first_name, u.business_name, u.mobile,
            c.title, c.campaign_code,
            COALESCE(SUM(pl.play_count), 0) AS plays,
            COUNT(DISTINCT pl.screen_id) AS screens
     FROM users u
     JOIN campaigns c ON c.user_id = u.id
     LEFT JOIN play_logs pl ON pl.campaign_id = c.id AND (pl.played_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date
     WHERE u.id = $1 AND c.status IN ('live','completed')
       AND c.start_date <= $2::date AND c.end_date >= $2::date
     GROUP BY u.first_name, u.business_name, u.mobile, c.title, c.campaign_code
     ORDER BY plays DESC`,
    [userId, today]
  );
  if (!r.rows.length || !r.rows[0].mobile) return;
  const { first_name, business_name, mobile } = r.rows[0];
  const name = business_name || first_name || 'Advertiser';
  const totalPlays = r.rows.reduce((s, x) => s + parseInt(x.plays), 0);
  const lines = r.rows.map(x => `  • ${x.campaign_code}: ${x.plays} plays on ${x.screens} screen(s)`).join('\n');

  const msg =
`📊 *Aaj Ka Proof of Play Report*

Hi ${name}! ${today} ki aapki ad performance ye rahi:

*Aaj Ke Total Plays:* ${totalPlays.toLocaleString('en-IN')}

${lines}

Aapke ads hamare poore network mein customers tak pahunch rahe hain. Detailed analytics ke liye dashboard check karo.
🔗 signagecrm-production.up.railway.app

— Team SignageCMS`;

  let pdfUrl = null;
  try {
    const pdfBuffer = await generatePoPPDF(name, today, r.rows.map(x => ({
      campaign_code: x.campaign_code, title: x.title,
      plays: x.plays, screens: x.screens,
    })));
    const popId = `pop-${userId}-${today}`;
    storePDF(popId, pdfBuffer);
    const baseUrl = process.env.APP_URL || 'https://signagecrm-production.up.railway.app';
    pdfUrl = `${baseUrl}/pdfs/${popId}`;
    console.log(`[WhatsApp] PoP PDF stored, URL: ${pdfUrl}`);
  } catch (e) {
    console.warn('[WhatsApp] PoP PDF generation failed, sending without attachment:', e.message);
  }

  return sendWhatsApp(mobile, msg, [name, today, String(totalPlays)], TPL_POP, pdfUrl);
}

// ── Send daily PoP WA to ALL advertisers with live campaigns ──────────────────
async function sendDailyPoPAllWA() {
  const today = new Date().toISOString().slice(0, 10);
  const users = await query(
    `SELECT DISTINCT u.id FROM users u
     JOIN campaigns c ON c.user_id = u.id
     WHERE c.status = 'live' AND c.start_date <= $1::date AND c.end_date >= $1::date
       AND u.mobile IS NOT NULL AND u.mobile != ''`,
    [today]
  );
  let sent = 0;
  for (const { id } of users.rows) {
    try {
      await sendDailyPoPWA(id, today);
      sent++;
      await new Promise(r => setTimeout(r, 400));
    } catch (e) {
      console.error(`[WhatsApp] Daily PoP WA error for user ${id}:`, e.message);
    }
  }
  console.log(`[WhatsApp] Daily PoP WA sent to ${sent} advertisers`);
  return sent;
}

module.exports = {
  sendWhatsApp,
  sendWeeklyReports, sendReportForUser, buildWeeklyReport,
  sendCampaignApprovedWA, sendInvoiceConfirmedWA,
  sendExpiryReminderWA, sendCampaignCompletedWA,
  sendDailyPoPWA, sendDailyPoPAllWA,
};

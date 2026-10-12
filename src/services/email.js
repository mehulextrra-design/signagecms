const { query } = require('../db');
const { generateInvoicePDF } = require('./invoice-pdf');

const FROM_EMAIL = process.env.FROM_EMAIL || 'onboarding@resend.dev';
const REPLY_TO  = process.env.GMAIL_USER || undefined;
const FROM = `SignageCMS <${FROM_EMAIL}>`;

async function sendMail({ to, subject, html, attachments = [] }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('[Email] RESEND_API_KEY not set');
    return;
  }
  const payload = { from: FROM, to: [to], subject, html };
  if (REPLY_TO) payload.reply_to = REPLY_TO;
  if (attachments.length) {
    payload.attachments = attachments.map(a => ({
      filename: a.filename,
      content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : a.content,
    }));
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API ${res.status}: ${body}`);
  }
  return res.json();
}

// ── HTML wrapper ──────────────────────────────────────────────────────────
function wrap(title, body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  body{margin:0;padding:0;background:#f2efe9;font-family:'Helvetica Neue',Arial,sans-serif;}
  .shell{max-width:560px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e0dbd3;}
  .hd{background:#1e1e1e;padding:24px 32px;display:flex;align-items:center;gap:10px;}
  .hd-dot{width:28px;height:28px;background:#ff5c00;border-radius:50%;display:flex;align-items:center;justify-content:center;}
  .hd-name{color:#fafafa;font-size:17px;font-weight:700;letter-spacing:-.5px;}
  .bd{padding:32px;}
  h2{margin:0 0 8px;font-size:22px;font-weight:700;color:#1e1e1e;letter-spacing:-.04em;}
  p{margin:0 0 16px;font-size:15px;color:#787068;line-height:1.6;}
  .tag{display:inline-block;background:#ebe6dd;border-radius:8px;padding:4px 10px;font-size:12px;font-weight:600;color:#787068;letter-spacing:.03em;text-transform:uppercase;margin-bottom:20px;}
  .card{background:#f7f4ef;border-radius:12px;padding:20px;margin:20px 0;}
  .row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #e8e4de;}
  .row:last-child{border-bottom:none;}
  .rl{font-size:13px;color:#aaa8a2;}
  .rv{font-size:14px;font-weight:600;color:#1e1e1e;}
  .btn{display:inline-block;background:#ff5c00;color:#fff;text-decoration:none;padding:12px 28px;border-radius:100px;font-size:15px;font-weight:600;margin:8px 0;}
  .ft{padding:20px 32px;border-top:1px solid #f0ece6;font-size:12px;color:#b0aba4;text-align:center;}
  .status-ok{color:#16a34a;font-weight:700;}
  .status-err{color:#dc2626;font-weight:700;}
</style></head><body>
<div class="shell">
  <div class="hd">
    <div class="hd-dot">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="2" y="3" width="20" height="14" rx="2" stroke="white" stroke-width="2"/><path d="M8 21h8M12 17v4" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>
    </div>
    <span class="hd-name">SignageCMS</span>
  </div>
  <div class="bd">${body}</div>
  <div class="ft">SignageCMS · India's OOH Advertising Network<br>This is an automated email. Do not reply.</div>
</div></body></html>`;
}

// ── Invoice email (after payment confirmed) ───────────────────────────────
async function sendInvoiceEmail(campaignId, invoiceNumber) {
  try {
    const { rows } = await query(
      `SELECT c.title, c.campaign_code, c.start_date, c.end_date,
              c.amount_base, c.amount_gst, c.amount_total, c.coupon_code, c.discount_amount,
              u.email, u.first_name, u.last_name, u.business_name, u.gst_number, u.mobile, u.city
       FROM campaigns c JOIN users u ON u.id = c.user_id WHERE c.id = $1`,
      [campaignId]
    );
    if (!rows.length) return;
    const c = rows[0];
    const name = c.business_name || `${c.first_name} ${c.last_name}`;

    const body = `
      <div class="tag">Invoice</div>
      <h2>Payment Confirmed ✓</h2>
      <p>Hi ${name}, your payment has been received and your invoice is ready.</p>
      <div class="card">
        <div class="row"><span class="rl">Invoice No.</span><span class="rv">${invoiceNumber}</span></div>
        <div class="row"><span class="rl">Campaign</span><span class="rv">${c.title}</span></div>
        <div class="row"><span class="rl">Code</span><span class="rv">${c.campaign_code}</span></div>
        <div class="row"><span class="rl">Period</span><span class="rv">${c.start_date} – ${c.end_date}</span></div>
        ${c.coupon_code ? `<div class="row"><span class="rl">Coupon (${c.coupon_code})</span><span class="rv">−₹${parseFloat(c.discount_amount).toFixed(2)}</span></div>` : ''}
        <div class="row"><span class="rl">Subtotal</span><span class="rv">₹${parseFloat(c.amount_base).toFixed(2)}</span></div>
        <div class="row"><span class="rl">GST (18%)</span><span class="rv">₹${parseFloat(c.amount_gst).toFixed(2)}</span></div>
        <div class="row"><span class="rl" style="font-weight:700;color:#1e1e1e">Total Paid</span><span class="rv" style="color:#ff5c00;font-size:16px">₹${parseFloat(c.amount_total).toFixed(2)}</span></div>
      </div>
      <p>Your campaign is now under review. You will receive another email once it is approved and goes live.</p>
      <a class="btn" href="${process.env.APP_URL || 'https://signagecrm-production.up.railway.app'}">View Campaign</a>`;

    let pdfBuffer = null;
    try { pdfBuffer = await generateInvoicePDF(c, { email: c.email, first_name: c.first_name, last_name: c.last_name, business_name: c.business_name, gst_number: c.gst_number, mobile: c.mobile, city: c.city }, invoiceNumber); } catch (e) { console.error('[Email] PDF gen error:', e.message); }

    await sendMail({
      to: c.email,
      subject: `Invoice ${invoiceNumber} – ${c.campaign_code} | SignageCMS`,
      html: wrap('Invoice', body),
      attachments: pdfBuffer ? [{ filename: `${invoiceNumber}.pdf`, content: pdfBuffer }] : [],
    });
    console.log(`[Email] Invoice sent to ${c.email} — ${invoiceNumber}${pdfBuffer ? ' (with PDF)' : ''}`);
  } catch (err) {
    console.error('[Email] sendInvoiceEmail error:', err.message);
  }
}

// ── Campaign approved email ───────────────────────────────────────────────
async function sendApprovedEmail(campaignId) {
  try {
    const { rows } = await query(
      `SELECT c.title, c.campaign_code, c.start_date, c.end_date,
              u.email, u.first_name, u.last_name, u.business_name
       FROM campaigns c JOIN users u ON u.id = c.user_id WHERE c.id = $1`,
      [campaignId]
    );
    if (!rows.length) return;
    const c = rows[0];
    const name = c.business_name || `${c.first_name} ${c.last_name}`;

    const body = `
      <div class="tag">Campaign Approved</div>
      <h2>Your Campaign is Live! 🚀</h2>
      <p>Hi ${name}, great news — your campaign has been approved and is now live on our screens.</p>
      <div class="card">
        <div class="row"><span class="rl">Campaign</span><span class="rv">${c.title}</span></div>
        <div class="row"><span class="rl">Code</span><span class="rv">${c.campaign_code}</span></div>
        <div class="row"><span class="rl">Period</span><span class="rv">${c.start_date} – ${c.end_date}</span></div>
        <div class="row"><span class="rl">Status</span><span class="rv status-ok">APPROVED ✓</span></div>
      </div>
      <p>You can track real-time impressions and play counts from your dashboard.</p>
      <a class="btn" href="${process.env.APP_URL || 'https://signagecrm-production.up.railway.app'}">View Live Campaign</a>`;

    await sendMail({
      to: c.email,
      subject: `Campaign Approved – ${c.campaign_code} is now live | SignageCMS`,
      html: wrap('Campaign Approved', body),
    });
    console.log(`[Email] Approval sent to ${c.email} — ${c.campaign_code}`);
  } catch (err) {
    console.error('[Email] sendApprovedEmail error:', err.message);
  }
}

// ── Campaign rejected email ───────────────────────────────────────────────
async function sendRejectedEmail(campaignId, reason) {
  try {
    const { rows } = await query(
      `SELECT c.title, c.campaign_code, u.email, u.first_name, u.last_name, u.business_name
       FROM campaigns c JOIN users u ON u.id = c.user_id WHERE c.id = $1`,
      [campaignId]
    );
    if (!rows.length) return;
    const c = rows[0];
    const name = c.business_name || `${c.first_name} ${c.last_name}`;

    const body = `
      <div class="tag">Campaign Rejected</div>
      <h2>Campaign Requires Revision</h2>
      <p>Hi ${name}, unfortunately your campaign could not be approved at this time.</p>
      <div class="card">
        <div class="row"><span class="rl">Campaign</span><span class="rv">${c.title}</span></div>
        <div class="row"><span class="rl">Code</span><span class="rv">${c.campaign_code}</span></div>
        <div class="row"><span class="rl">Status</span><span class="rv status-err">REJECTED</span></div>
        <div class="row"><span class="rl">Reason</span><span class="rv" style="color:#dc2626">${reason}</span></div>
      </div>
      <p>Please update your creative or contact us to resubmit your campaign.</p>
      <a class="btn" href="${process.env.APP_URL || 'https://signagecrm-production.up.railway.app'}">Update Campaign</a>`;

    await sendMail({
      to: c.email,
      subject: `Campaign Update Required – ${c.campaign_code} | SignageCMS`,
      html: wrap('Campaign Rejected', body),
    });
    console.log(`[Email] Rejection sent to ${c.email} — ${c.campaign_code}`);
  } catch (err) {
    console.error('[Email] sendRejectedEmail error:', err.message);
  }
}

// ── Daily PoP summary email to admin ─────────────────────────────────────
async function sendDailyPoPReport() {
  try {
    const adminEmail = process.env.ADMIN_EMAIL || process.env.GMAIL_USER;
    const today = new Date().toISOString().slice(0, 10);

    const { rows: summary } = await query(`
      SELECT c.campaign_code, c.title,
             u.business_name, u.email AS adv_email,
             COALESCE(SUM(pl.play_count), 0) AS plays,
             COUNT(DISTINCT pl.screen_id) AS screens
      FROM campaigns c
      JOIN users u ON u.id = c.user_id
      LEFT JOIN play_logs pl ON pl.campaign_id = c.id AND (pl.played_at AT TIME ZONE 'Asia/Kolkata')::date = $1::date
      WHERE c.status IN ('live','completed')
        AND c.start_date <= $1::date AND c.end_date >= $1::date
      GROUP BY c.campaign_code, c.title, u.business_name, u.email
      ORDER BY plays DESC
    `, [today]);

    if (!summary.length) return;

    const totalPlays = summary.reduce((s, r) => s + parseInt(r.plays), 0);

    const rows = summary.map(r => `
      <div class="row">
        <span class="rl">${r.campaign_code} · ${r.title}</span>
        <span class="rv">${r.plays} plays · ${r.screens} screens</span>
      </div>`).join('');

    const body = `
      <div class="tag">Daily PoP Report</div>
      <h2>Proof of Play — ${today}</h2>
      <p>Here is a summary of all campaign plays recorded today across the SignageCMS network.</p>
      <div class="card">
        <div class="row"><span class="rl">Date</span><span class="rv">${today}</span></div>
        <div class="row"><span class="rl">Active Campaigns</span><span class="rv">${summary.length}</span></div>
        <div class="row"><span class="rl">Total Plays Today</span><span class="rv" style="color:#ff5c00;font-size:16px">${totalPlays.toLocaleString()}</span></div>
      </div>
      <div class="card">${rows}</div>
      <a class="btn" href="${process.env.APP_URL || 'https://signagecrm-production.up.railway.app'}/admin">View Admin Dashboard</a>`;

    await sendMail({
      to: adminEmail,
      subject: `Daily PoP Report – ${today} · ${totalPlays} plays | SignageCMS`,
      html: wrap('Daily PoP Report', body),
    });
    console.log(`[Email] Daily PoP report sent — ${today}, ${totalPlays} plays`);
  } catch (err) {
    console.error('[Email] sendDailyPoPReport error:', err.message);
  }
}

// ── Daily PoP email to individual advertiser ──────────────────────────────
async function sendDailyPoPEmailToUser(userId, dateStr) {
  try {
    const today = dateStr || new Date().toISOString().slice(0, 10);
    const { rows } = await query(`
      SELECT u.first_name, u.last_name, u.business_name, u.email,
             c.title, c.campaign_code,
             COALESCE(SUM(pl.play_count), 0) AS plays,
             COUNT(DISTINCT pl.screen_id) AS screens
      FROM users u
      JOIN campaigns c ON c.user_id = u.id
      LEFT JOIN play_logs pl ON pl.campaign_id = c.id
        AND (pl.played_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date
      WHERE u.id = $1 AND c.status IN ('live','completed')
        AND c.start_date <= $2::date AND c.end_date >= $2::date
      GROUP BY u.first_name, u.last_name, u.business_name, u.email,
               c.title, c.campaign_code
      ORDER BY plays DESC
    `, [userId, today]);

    if (!rows.length || !rows[0].email) return;
    const { first_name, last_name, business_name, email } = rows[0];
    const name = business_name || `${first_name} ${last_name}`.trim() || 'Advertiser';
    const totalPlays = rows.reduce((s, r) => s + parseInt(r.plays), 0);

    const campaignRows = rows.map(r => `
      <div class="row">
        <span class="rl">${r.campaign_code} · ${r.title}</span>
        <span class="rv">${parseInt(r.plays).toLocaleString()} plays · ${r.screens} screen(s)</span>
      </div>`).join('');

    const body = `
      <div class="tag">Daily Proof of Play</div>
      <h2>Aaj Ka Report — ${today}</h2>
      <p>Hi ${name}, yeh raha aapka aaj ka ad performance summary.</p>
      <div class="card">
        <div class="row"><span class="rl">Date</span><span class="rv">${today}</span></div>
        <div class="row"><span class="rl">Active Campaigns</span><span class="rv">${rows.length}</span></div>
        <div class="row"><span class="rl" style="font-weight:700;color:#1e1e1e">Total Plays Today</span><span class="rv" style="color:#ff5c00;font-size:16px">${totalPlays.toLocaleString('en-IN')}</span></div>
      </div>
      <div class="card">${campaignRows}</div>
      <p style="font-size:13px;color:#aaa;">Detailed analytics aur screen-wise breakdown ke liye dashboard check karein.</p>
      <a class="btn" href="${process.env.APP_URL || 'https://signagecrm-production.up.railway.app'}">Dashboard Dekhein</a>`;

    await sendMail({
      to: email,
      subject: `Aaj Ka Proof of Play — ${today} · ${totalPlays.toLocaleString('en-IN')} plays | SignageCMS`,
      html: wrap('Daily Proof of Play', body),
    });
    console.log(`[Email] Daily PoP sent to ${email} — ${today}, ${totalPlays} plays`);
  } catch (err) {
    console.error(`[Email] sendDailyPoPEmailToUser error (user ${userId}):`, err.message);
  }
}

// ── Daily PoP email to ALL active advertisers ─────────────────────────────
async function sendDailyPoPEmailAll() {
  const today = new Date().toISOString().slice(0, 10);
  const { rows: users } = await query(
    `SELECT DISTINCT u.id FROM users u
     JOIN campaigns c ON c.user_id = u.id
     WHERE c.status = 'live' AND c.start_date <= $1::date AND c.end_date >= $1::date
       AND u.email IS NOT NULL AND u.email != ''`,
    [today]
  );
  let sent = 0;
  for (const { id } of users) {
    await sendDailyPoPEmailToUser(id, today);
    sent++;
  }
  console.log(`[Email] Daily PoP email sent to ${sent} advertisers`);
  return sent;
}

// ── New user signup alert to admin ───────────────────────────────────────
async function sendNewUserAlertEmail({ first_name, last_name, email, mobile, business_name, business_type, city }) {
  try {
    const adminEmail = process.env.ADMIN_EMAIL || process.env.GMAIL_USER;
    if (!adminEmail) return;
    const name = business_name || `${first_name} ${last_name}`.trim() || 'New User';
    const joinedAt = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });

    const body = `
      <div class="tag">New Signup</div>
      <h2>Naya User Register Hua! 👤</h2>
      <p>Ek naya advertiser aapke platform pe register hua hai. Details yahan hain:</p>
      <div class="card">
        <div class="row"><span class="rl">Name</span><span class="rv">${name}</span></div>
        ${business_name ? `<div class="row"><span class="rl">Business</span><span class="rv">${business_name}</span></div>` : ''}
        ${business_type ? `<div class="row"><span class="rl">Type</span><span class="rv">${business_type}</span></div>` : ''}
        <div class="row"><span class="rl">Email</span><span class="rv">${email}</span></div>
        <div class="row"><span class="rl">Mobile</span><span class="rv">+91 ${mobile}</span></div>
        ${city ? `<div class="row"><span class="rl">City</span><span class="rv">${city}</span></div>` : ''}
        <div class="row"><span class="rl">Joined At</span><span class="rv">${joinedAt}</span></div>
      </div>
      <p>Admin dashboard pe jaake is user ka account manage karo.</p>
      <a class="btn" href="${process.env.APP_URL || 'https://signagecrm-production.up.railway.app'}/admin">Admin Dashboard</a>`;

    await sendMail({
      to: adminEmail,
      subject: `New Signup: ${name} (${email}) | SignageCMS`,
      html: wrap('New User Signup', body),
    });
    console.log(`[Email] New user alert sent to admin — ${email}`);
  } catch (err) {
    console.error('[Email] sendNewUserAlertEmail error:', err.message);
  }
}

module.exports = { sendInvoiceEmail, sendApprovedEmail, sendRejectedEmail, sendDailyPoPReport, sendDailyPoPEmailAll, sendNewUserAlertEmail };

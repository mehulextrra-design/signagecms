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

// ── Shared CSS + HTML shell ───────────────────────────────────────────────
// Brand colors from landing page: --orange:#7b68c8, grad: #c94baa→#7b68c8→#2ca6d4
const BRAND   = '#7b68c8';
const BRAND_G = 'linear-gradient(135deg,#c94baa 0%,#7b68c8 55%,#2ca6d4 100%)';

const CSS = `
  body{margin:0;padding:0;background:#f2efe9;font-family:'Helvetica Neue',Arial,sans-serif;}
  .shell{max-width:560px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e0dbd3;}
  .hd{background:#1e1e1e;padding:22px 32px;display:flex;align-items:center;gap:10px;}
  .hd-dot{width:28px;height:28px;background:${BRAND_G};border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
  .hd-name{color:#fafafa;font-size:17px;font-weight:700;letter-spacing:-.5px;}
  .bd{padding:28px 32px;}
  .tag{display:inline-block;background:#ebe6dd;border-radius:8px;padding:4px 10px;font-size:12px;font-weight:600;color:#787068;letter-spacing:.03em;text-transform:uppercase;margin-bottom:16px;}
  h2{margin:0 0 6px;font-size:22px;font-weight:700;color:#1e1e1e;letter-spacing:-.04em;}
  .sub{font-size:14px;color:#888;margin:0 0 20px;line-height:1.5;}
  p{margin:0 0 16px;font-size:15px;color:#787068;line-height:1.6;}
  .stats-row{display:grid;gap:10px;margin-bottom:22px;}
  .stats-row.cols-2{grid-template-columns:1fr 1fr;}
  .stats-row.cols-3{grid-template-columns:1fr 1fr 1fr;}
  .stat-card{background:#f7f4ef;border-radius:12px;padding:14px 16px;text-align:center;}
  .stat-num{font-size:28px;font-weight:700;color:#1e1e1e;line-height:1;}
  .stat-num.brand{color:${BRAND};}
  .stat-num.green{color:#16a34a;}
  .stat-num.red{color:#dc2626;}
  .stat-num.amber{color:#d97706;}
  .stat-label{font-size:11px;color:#aaa8a2;margin-top:5px;text-transform:uppercase;letter-spacing:.04em;font-weight:600;}
  .info-card{background:#f7f4ef;border-radius:12px;padding:18px 20px;margin-bottom:16px;}
  .info-row{display:flex;justify-content:space-between;align-items:flex-start;padding:7px 0;border-bottom:1px solid #e8e4de;}
  .info-row:last-child{border-bottom:none;}
  .ir-label{font-size:13px;color:#aaa8a2;padding-right:12px;}
  .ir-value{font-size:14px;font-weight:600;color:#1e1e1e;text-align:right;}
  .code-badge{display:inline-block;background:#ebe6dd;border-radius:6px;padding:3px 9px;font-size:11px;font-weight:700;color:#9e9890;letter-spacing:.04em;}
  .camp-card{background:#f7f4ef;border-radius:12px;padding:16px 20px;margin-bottom:10px;display:flex;align-items:center;gap:16px;}
  .camp-plays{text-align:center;min-width:70px;}
  .camp-plays-num{font-size:26px;font-weight:700;color:${BRAND};line-height:1;}
  .camp-plays-label{font-size:11px;color:#aaa;text-transform:uppercase;letter-spacing:.04em;font-weight:600;margin-top:2px;}
  .camp-info{flex:1;min-width:0;border-left:2px solid #e8e4de;padding-left:16px;}
  .camp-title{font-size:15px;font-weight:700;color:#1e1e1e;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .camp-meta{font-size:12px;color:#aaa8a2;}
  .section-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#bbb;margin:0 0 10px;}
  .btn{display:inline-block;background:${BRAND_G};color:#fff;text-decoration:none;padding:12px 28px;border-radius:100px;font-size:15px;font-weight:600;margin-top:8px;}
  .divider{border:none;border-top:1px solid #f0ece6;margin:20px 0;}
  .ft{padding:18px 32px;border-top:1px solid #f0ece6;font-size:12px;color:#b0aba4;text-align:center;}
  .status-badge{display:inline-flex;align-items:center;gap:6px;border-radius:8px;padding:6px 14px;font-size:13px;font-weight:700;letter-spacing:.02em;}
  .status-approved{background:#dcfce7;color:#15803d;}
  .status-rejected{background:#fee2e2;color:#dc2626;}
  .status-paused{background:#fef9c3;color:#a16207;}
  .status-live{background:#dcfce7;color:#15803d;}
  .status-hold{background:#fff7ed;color:#c2410c;}
`;

function wrap(body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
<div class="shell">
  <div class="hd">
    <div class="hd-dot">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="2" y="3" width="20" height="14" rx="2" stroke="white" stroke-width="2"/><path d="M8 21h8M12 17v4" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>
    </div>
    <span class="hd-name">SignageCMS</span>
  </div>
  <div class="bd">${body}</div>
  <div class="ft">SignageCMS &middot; India's OOH Advertising Network<br>This is an automated email. Do not reply.</div>
</div></body></html>`;
}

function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ── Invoice email ─────────────────────────────────────────────────────────
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
    const name = c.business_name || `${c.first_name} ${c.last_name}`.trim();

    const body = `
      <div class="tag">Invoice · ${invoiceNumber}</div>
      <h2>Payment Confirmed</h2>
      <p class="sub">Hi ${name}, your payment is received. Invoice is attached below.</p>

      <div class="stats-row cols-2">
        <div class="stat-card">
          <div class="stat-num brand">₹${parseFloat(c.amount_total).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</div>
          <div class="stat-label">Total Paid</div>
        </div>
        <div class="stat-card">
          <div class="stat-num" style="font-size:16px;padding-top:4px"><span class="code-badge" style="font-size:13px">${c.campaign_code}</span></div>
          <div class="stat-label">Campaign Code</div>
        </div>
      </div>

      <div class="info-card">
        <div class="info-row"><span class="ir-label">Campaign</span><span class="ir-value">${c.title}</span></div>
        <div class="info-row"><span class="ir-label">Period</span><span class="ir-value">${fmtDate(c.start_date)} – ${fmtDate(c.end_date)}</span></div>
        ${c.coupon_code ? `<div class="info-row"><span class="ir-label">Coupon (${c.coupon_code})</span><span class="ir-value" style="color:#16a34a">−₹${parseFloat(c.discount_amount).toFixed(2)}</span></div>` : ''}
        <div class="info-row"><span class="ir-label">Subtotal</span><span class="ir-value">₹${parseFloat(c.amount_base).toFixed(2)}</span></div>
        <div class="info-row"><span class="ir-label">GST (18%)</span><span class="ir-value">₹${parseFloat(c.amount_gst).toFixed(2)}</span></div>
        <div class="info-row"><span class="ir-label" style="font-weight:700;color:#1e1e1e">Total</span><span class="ir-value" style="color:#7b68c8;font-size:16px">₹${parseFloat(c.amount_total).toFixed(2)}</span></div>
      </div>

      <p style="font-size:14px;color:#aaa">Your campaign is now under review. You'll get another email once it's approved and goes live.</p>
      <a class="btn" href="${process.env.APP_URL || 'https://signagecrm-production.up.railway.app'}">View Campaign</a>`;

    let pdfBuffer = null;
    try { pdfBuffer = await generateInvoicePDF(c, { email: c.email, first_name: c.first_name, last_name: c.last_name, business_name: c.business_name, gst_number: c.gst_number, mobile: c.mobile, city: c.city }, invoiceNumber); } catch (e) { console.error('[Email] PDF gen error:', e.message); }

    await sendMail({
      to: c.email,
      subject: `Invoice ${invoiceNumber} – Payment confirmed for ${c.campaign_code} | SignageCMS`,
      html: wrap(body),
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
    const name = c.business_name || `${c.first_name} ${c.last_name}`.trim();

    const body = `
      <div class="tag">Campaign Approved</div>
      <h2>Your Ad is Live!</h2>
      <p class="sub">Hi ${name}, great news — your campaign has been approved.</p>

      <div class="stats-row cols-2">
        <div class="stat-card">
          <div class="stat-num green" style="font-size:20px;padding-top:4px">
            <span class="status-badge status-approved">&#10003; Approved</span>
          </div>
          <div class="stat-label" style="margin-top:8px">Status</div>
        </div>
        <div class="stat-card">
          <div class="stat-num" style="font-size:16px;padding-top:4px"><span class="code-badge" style="font-size:13px">${c.campaign_code}</span></div>
          <div class="stat-label">Campaign Code</div>
        </div>
      </div>

      <div class="info-card">
        <div class="info-row"><span class="ir-label">Campaign</span><span class="ir-value">${c.title}</span></div>
        <div class="info-row"><span class="ir-label">Start Date</span><span class="ir-value">${fmtDate(c.start_date)}</span></div>
        <div class="info-row"><span class="ir-label">End Date</span><span class="ir-value">${fmtDate(c.end_date)}</span></div>
      </div>

      <p style="font-size:14px;color:#aaa">Track real-time impressions and play counts from your dashboard.</p>
      <a class="btn" href="${process.env.APP_URL || 'https://signagecrm-production.up.railway.app'}">View Live Campaign</a>`;

    await sendMail({
      to: c.email,
      subject: `Campaign Approved – ${c.campaign_code} is now live | SignageCMS`,
      html: wrap(body),
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
      `SELECT c.title, c.campaign_code, c.amount_total, c.payment_status,
              u.email, u.first_name, u.last_name, u.business_name
       FROM campaigns c JOIN users u ON u.id = c.user_id WHERE c.id = $1`,
      [campaignId]
    );
    if (!rows.length) return;
    const c = rows[0];
    const name = c.business_name || `${c.first_name} ${c.last_name}`.trim();
    const refundAmt = parseFloat(c.amount_total || 0);
    const hasRefund = refundAmt > 0 && c.payment_status === 'paid';

    const body = `
      <div class="tag">Campaign Rejected</div>
      <h2>Campaign Requires Revision</h2>
      <p class="sub">Hi ${name}, your campaign could not be approved at this time.</p>

      <div class="stats-row ${hasRefund ? 'cols-2' : 'cols-2'}">
        <div class="stat-card">
          <div class="stat-num red" style="font-size:20px;padding-top:4px">
            <span class="status-badge status-rejected">&#10005; Rejected</span>
          </div>
          <div class="stat-label" style="margin-top:8px">Status</div>
        </div>
        ${hasRefund ? `
        <div class="stat-card">
          <div class="stat-num green">₹${refundAmt.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</div>
          <div class="stat-label">Refunded to Wallet</div>
        </div>` : `
        <div class="stat-card">
          <div class="stat-num" style="font-size:16px;padding-top:4px"><span class="code-badge" style="font-size:13px">${c.campaign_code}</span></div>
          <div class="stat-label">Campaign Code</div>
        </div>`}
      </div>

      <div class="info-card">
        <div class="info-row"><span class="ir-label">Campaign</span><span class="ir-value">${c.title}</span></div>
        <div class="info-row"><span class="ir-label">Code</span><span class="ir-value"><span class="code-badge">${c.campaign_code}</span></span></div>
        <div class="info-row"><span class="ir-label">Reason</span><span class="ir-value" style="color:#dc2626;max-width:260px;text-align:right">${reason}</span></div>
        ${hasRefund ? `<div class="info-row"><span class="ir-label">Refund</span><span class="ir-value" style="color:#16a34a">₹${refundAmt.toFixed(2)} added to wallet</span></div>` : ''}
      </div>

      <p style="font-size:14px;color:#aaa">Please update your creative or contact us to resubmit your campaign.</p>
      <a class="btn" href="${process.env.APP_URL || 'https://signagecrm-production.up.railway.app'}">Update Campaign</a>`;

    await sendMail({
      to: c.email,
      subject: `Action Required – ${c.campaign_code} needs revision | SignageCMS`,
      html: wrap(body),
    });
    console.log(`[Email] Rejection sent to ${c.email} — ${c.campaign_code}`);
  } catch (err) {
    console.error('[Email] sendRejectedEmail error:', err.message);
  }
}

// ── Campaign paused email ─────────────────────────────────────────────────
async function sendPausedEmail(campaignId) {
  try {
    const { rows } = await query(
      `SELECT c.title, c.campaign_code, c.start_date, c.end_date,
              u.email, u.first_name, u.last_name, u.business_name
       FROM campaigns c JOIN users u ON u.id = c.user_id WHERE c.id = $1`,
      [campaignId]
    );
    if (!rows.length) return;
    const c = rows[0];
    const name = c.business_name || `${c.first_name} ${c.last_name}`.trim();

    const body = `
      <div class="tag">Campaign Paused</div>
      <h2>Your Campaign is Paused</h2>
      <p class="sub">Hi ${name}, your campaign has been temporarily paused.</p>

      <div class="stats-row cols-2">
        <div class="stat-card">
          <div class="stat-num amber" style="font-size:20px;padding-top:4px">
            <span class="status-badge status-paused">&#9646;&#9646; Paused</span>
          </div>
          <div class="stat-label" style="margin-top:8px">Status</div>
        </div>
        <div class="stat-card">
          <div class="stat-num" style="font-size:16px;padding-top:4px"><span class="code-badge" style="font-size:13px">${c.campaign_code}</span></div>
          <div class="stat-label">Campaign Code</div>
        </div>
      </div>

      <div class="info-card">
        <div class="info-row"><span class="ir-label">Campaign</span><span class="ir-value">${c.title}</span></div>
        <div class="info-row"><span class="ir-label">Period</span><span class="ir-value">${fmtDate(c.start_date)} – ${fmtDate(c.end_date)}</span></div>
      </div>

      <p style="font-size:14px;color:#aaa">While paused, your ad will not be displayed on screens. You can resume anytime from your dashboard.</p>
      <a class="btn" href="${process.env.APP_URL || 'https://signagecrm-production.up.railway.app'}">Manage Campaign</a>`;

    await sendMail({
      to: c.email,
      subject: `Campaign Paused – ${c.campaign_code} | SignageCMS`,
      html: wrap(body),
    });
    console.log(`[Email] Paused email sent to ${c.email} — ${c.campaign_code}`);
  } catch (err) {
    console.error('[Email] sendPausedEmail error:', err.message);
  }
}

// ── Campaign resumed email ────────────────────────────────────────────────
async function sendResumedEmail(campaignId) {
  try {
    const { rows } = await query(
      `SELECT c.title, c.campaign_code, c.start_date, c.end_date,
              u.email, u.first_name, u.last_name, u.business_name
       FROM campaigns c JOIN users u ON u.id = c.user_id WHERE c.id = $1`,
      [campaignId]
    );
    if (!rows.length) return;
    const c = rows[0];
    const name = c.business_name || `${c.first_name} ${c.last_name}`.trim();

    const body = `
      <div class="tag">Campaign Resumed</div>
      <h2>Your Ad is Live Again!</h2>
      <p class="sub">Hi ${name}, your campaign has been resumed and is now live on screens.</p>

      <div class="stats-row cols-2">
        <div class="stat-card">
          <div class="stat-num green" style="font-size:20px;padding-top:4px">
            <span class="status-badge status-live">&#9654; Live</span>
          </div>
          <div class="stat-label" style="margin-top:8px">Status</div>
        </div>
        <div class="stat-card">
          <div class="stat-num" style="font-size:16px;padding-top:4px"><span class="code-badge" style="font-size:13px">${c.campaign_code}</span></div>
          <div class="stat-label">Campaign Code</div>
        </div>
      </div>

      <div class="info-card">
        <div class="info-row"><span class="ir-label">Campaign</span><span class="ir-value">${c.title}</span></div>
        <div class="info-row"><span class="ir-label">End Date</span><span class="ir-value">${fmtDate(c.end_date)}</span></div>
      </div>

      <p style="font-size:14px;color:#aaa">Your ad is now being displayed on screens. Track live impressions from your dashboard.</p>
      <a class="btn" href="${process.env.APP_URL || 'https://signagecrm-production.up.railway.app'}">View Live Campaign</a>`;

    await sendMail({
      to: c.email,
      subject: `Campaign Resumed – ${c.campaign_code} is live again | SignageCMS`,
      html: wrap(body),
    });
    console.log(`[Email] Resumed email sent to ${c.email} — ${c.campaign_code}`);
  } catch (err) {
    console.error('[Email] sendResumedEmail error:', err.message);
  }
}

// ── Campaign on-hold email ────────────────────────────────────────────────
async function sendOnHoldEmail(campaignId, reason) {
  try {
    const { rows } = await query(
      `SELECT c.title, c.campaign_code, c.start_date, c.end_date,
              u.email, u.first_name, u.last_name, u.business_name
       FROM campaigns c JOIN users u ON u.id = c.user_id WHERE c.id = $1`,
      [campaignId]
    );
    if (!rows.length) return;
    const c = rows[0];
    const name = c.business_name || `${c.first_name} ${c.last_name}`.trim();

    const body = `
      <div class="tag">Campaign On Hold</div>
      <h2>Campaign Placed On Hold</h2>
      <p class="sub">Hi ${name}, our team has placed your campaign on hold. Please review the details below.</p>

      <div class="stats-row cols-2">
        <div class="stat-card">
          <div class="stat-num" style="font-size:20px;padding-top:4px">
            <span class="status-badge status-hold">&#9679; On Hold</span>
          </div>
          <div class="stat-label" style="margin-top:8px">Status</div>
        </div>
        <div class="stat-card">
          <div class="stat-num" style="font-size:16px;padding-top:4px"><span class="code-badge" style="font-size:13px">${c.campaign_code}</span></div>
          <div class="stat-label">Campaign Code</div>
        </div>
      </div>

      <div class="info-card">
        <div class="info-row"><span class="ir-label">Campaign</span><span class="ir-value">${c.title}</span></div>
        <div class="info-row"><span class="ir-label">Period</span><span class="ir-value">${fmtDate(c.start_date)} – ${fmtDate(c.end_date)}</span></div>
        ${reason ? `<div class="info-row"><span class="ir-label">Reason</span><span class="ir-value" style="color:#c2410c;max-width:260px;text-align:right">${reason}</span></div>` : ''}
      </div>

      <p style="font-size:14px;color:#aaa">Please contact us or update your campaign details. We'll review and resume as soon as possible.</p>
      <a class="btn" href="${process.env.APP_URL || 'https://signagecrm-production.up.railway.app'}">Contact Support</a>`;

    await sendMail({
      to: c.email,
      subject: `Campaign On Hold – ${c.campaign_code} needs attention | SignageCMS`,
      html: wrap(body),
    });
    console.log(`[Email] On-hold email sent to ${c.email} — ${c.campaign_code}`);
  } catch (err) {
    console.error('[Email] sendOnHoldEmail error:', err.message);
  }
}

// ── Wallet balance update email ───────────────────────────────────────────
async function sendWalletCreditEmail(userId, amount, newBalance, description) {
  try {
    const { rows } = await query(
      `SELECT email, first_name, last_name, business_name FROM users WHERE id = $1`,
      [userId]
    );
    if (!rows.length || !rows[0].email) return;
    const u = rows[0];
    const name = u.business_name || `${u.first_name} ${u.last_name}`.trim() || 'Advertiser';
    const creditedAt = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

    const body = `
      <div class="tag">Wallet Credited</div>
      <h2>Wallet Balance Updated</h2>
      <p class="sub">Hi ${name}, your SignageCMS wallet has been credited.</p>

      <div class="stats-row cols-2">
        <div class="stat-card">
          <div class="stat-num green">+₹${parseFloat(amount).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</div>
          <div class="stat-label">Amount Credited</div>
        </div>
        <div class="stat-card">
          <div class="stat-num brand">₹${parseFloat(newBalance).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</div>
          <div class="stat-label">New Balance</div>
        </div>
      </div>

      <div class="info-card">
        ${description ? `<div class="info-row"><span class="ir-label">Description</span><span class="ir-value">${description}</span></div>` : ''}
        <div class="info-row"><span class="ir-label">Credited At</span><span class="ir-value">${creditedAt}</span></div>
      </div>

      <p style="font-size:14px;color:#aaa">Use your wallet balance to pay for your next campaign at checkout.</p>
      <a class="btn" href="${process.env.APP_URL || 'https://signagecrm-production.up.railway.app'}">Use Wallet</a>`;

    await sendMail({
      to: u.email,
      subject: `Wallet Credited ₹${parseFloat(amount).toFixed(0)} | SignageCMS`,
      html: wrap(body),
    });
    console.log(`[Email] Wallet credit email sent to ${u.email} — ₹${amount}`);
  } catch (err) {
    console.error('[Email] sendWalletCreditEmail error:', err.message);
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
    const totalScreens = summary.reduce((s, r) => s + parseInt(r.screens), 0);

    const campRows = summary.map(r => `
      <div class="camp-card">
        <div class="camp-plays">
          <div class="camp-plays-num">${parseInt(r.plays).toLocaleString('en-IN')}</div>
          <div class="camp-plays-label">Plays</div>
        </div>
        <div class="camp-info">
          <div style="margin-bottom:4px"><span class="code-badge">${r.campaign_code}</span></div>
          <div class="camp-title">${r.title}</div>
          <div class="camp-meta">${r.business_name || ''} &middot; ${r.screens} screen(s)</div>
        </div>
      </div>`).join('');

    const body = `
      <div class="tag">Daily PoP Report · ${today}</div>
      <h2>Proof of Play</h2>
      <p class="sub">Daily campaign play summary across the SignageCMS network.</p>

      <div class="stats-row cols-3">
        <div class="stat-card">
          <div class="stat-num brand">${totalPlays.toLocaleString('en-IN')}</div>
          <div class="stat-label">Total Plays</div>
        </div>
        <div class="stat-card">
          <div class="stat-num">${summary.length}</div>
          <div class="stat-label">Campaigns</div>
        </div>
        <div class="stat-card">
          <div class="stat-num">${totalScreens}</div>
          <div class="stat-label">Screens</div>
        </div>
      </div>

      <div class="section-label">Campaign Breakdown</div>
      ${campRows}

      <a class="btn" href="${process.env.APP_URL || 'https://signagecrm-production.up.railway.app'}/admin">View Admin Dashboard</a>`;

    await sendMail({
      to: adminEmail,
      subject: `Daily PoP – ${today} · ${totalPlays.toLocaleString('en-IN')} plays | SignageCMS`,
      html: wrap(body),
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
             c.title, c.campaign_code, c.start_date, c.end_date,
             COALESCE(SUM(pl.play_count), 0) AS plays,
             COUNT(DISTINCT pl.screen_id) AS screens
      FROM users u
      JOIN campaigns c ON c.user_id = u.id
      LEFT JOIN play_logs pl ON pl.campaign_id = c.id
        AND (pl.played_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date
      WHERE u.id = $1 AND c.status IN ('live','completed')
        AND c.start_date <= $2::date AND c.end_date >= $2::date
      GROUP BY u.first_name, u.last_name, u.business_name, u.email,
               c.title, c.campaign_code, c.start_date, c.end_date
      ORDER BY plays DESC
    `, [userId, today]);

    if (!rows.length || !rows[0].email) return;
    const { first_name, last_name, business_name, email } = rows[0];
    const name = business_name || `${first_name} ${last_name}`.trim() || 'Advertiser';
    const totalPlays = rows.reduce((s, r) => s + parseInt(r.plays), 0);
    const totalScreens = rows.reduce((s, r) => s + parseInt(r.screens), 0);

    const campRows = rows.map(r => `
      <div class="camp-card">
        <div class="camp-plays">
          <div class="camp-plays-num">${parseInt(r.plays).toLocaleString('en-IN')}</div>
          <div class="camp-plays-label">Plays</div>
        </div>
        <div class="camp-info">
          <div style="margin-bottom:4px"><span class="code-badge">${r.campaign_code}</span></div>
          <div class="camp-title">${r.title}</div>
          <div class="camp-meta">${r.screens} screen(s) &middot; ${fmtDate(r.start_date)} – ${fmtDate(r.end_date)}</div>
        </div>
      </div>`).join('');

    const body = `
      <div class="tag">Proof of Play · ${today}</div>
      <h2>Aaj Ka Ad Report</h2>
      <p class="sub">${name} — daily performance summary</p>

      <div class="stats-row cols-3">
        <div class="stat-card">
          <div class="stat-num brand">${totalPlays.toLocaleString('en-IN')}</div>
          <div class="stat-label">Total Plays</div>
        </div>
        <div class="stat-card">
          <div class="stat-num">${rows.length}</div>
          <div class="stat-label">Campaigns</div>
        </div>
        <div class="stat-card">
          <div class="stat-num">${totalScreens}</div>
          <div class="stat-label">Screens</div>
        </div>
      </div>

      <div class="section-label">Campaign-wise Breakdown</div>
      ${campRows}

      <p style="font-size:13px;color:#bbb;margin-top:16px">Screen-wise analytics ke liye dashboard check karein.</p>
      <a class="btn" href="${process.env.APP_URL || 'https://signagecrm-production.up.railway.app'}">Dashboard Dekhein</a>`;

    await sendMail({
      to: email,
      subject: `Aaj Ka Report – ${totalPlays.toLocaleString('en-IN')} plays today | SignageCMS`,
      html: wrap(body),
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
    const joinedAt = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

    const body = `
      <div class="tag">New Signup</div>
      <h2>New Advertiser Registered</h2>
      <p class="sub">A new advertiser has registered on SignageCMS.</p>

      <div class="info-card">
        <div class="info-row"><span class="ir-label">Name</span><span class="ir-value">${name}</span></div>
        ${business_name ? `<div class="info-row"><span class="ir-label">Business</span><span class="ir-value">${business_name}</span></div>` : ''}
        ${business_type ? `<div class="info-row"><span class="ir-label">Type</span><span class="ir-value">${business_type}</span></div>` : ''}
        <div class="info-row"><span class="ir-label">Email</span><span class="ir-value">${email}</span></div>
        <div class="info-row"><span class="ir-label">Mobile</span><span class="ir-value">+91 ${mobile}</span></div>
        ${city ? `<div class="info-row"><span class="ir-label">City</span><span class="ir-value">${city}</span></div>` : ''}
        <div class="info-row"><span class="ir-label">Joined At</span><span class="ir-value">${joinedAt}</span></div>
      </div>

      <a class="btn" href="${process.env.APP_URL || 'https://signagecrm-production.up.railway.app'}/admin">View in Admin Dashboard</a>`;

    await sendMail({
      to: adminEmail,
      subject: `New Signup: ${name} (${email}) | SignageCMS`,
      html: wrap(body),
    });
    console.log(`[Email] New user alert sent to admin — ${email}`);
  } catch (err) {
    console.error('[Email] sendNewUserAlertEmail error:', err.message);
  }
}

// ── Expiry reminder email (2 days / 1 day before end) ────────────────────
async function sendExpiryReminderEmail(campaignId, daysLeft) {
  try {
    const { rows } = await query(
      `SELECT c.title, c.campaign_code, c.start_date, c.end_date,
              u.email, u.first_name, u.last_name, u.business_name
       FROM campaigns c JOIN users u ON u.id = c.user_id WHERE c.id = $1`,
      [campaignId]
    );
    if (!rows.length) return;
    const c = rows[0];
    const name = c.business_name || `${c.first_name} ${c.last_name}`.trim();
    const isLastDay = daysLeft === 1;

    const body = `
      <div class="tag">${isLastDay ? 'Last Day' : '2 Days Left'}</div>
      <h2>${isLastDay ? 'Campaign Ends Tomorrow!' : 'Campaign Ending in 2 Days'}</h2>
      <p class="sub">Hi ${name}, your campaign is about to end. Renew now to stay on screens.</p>

      <div class="stats-row cols-2">
        <div class="stat-card">
          <div class="stat-num ${isLastDay ? 'red' : 'amber'}" style="font-size:40px">${daysLeft}</div>
          <div class="stat-label">${isLastDay ? 'Day Left' : 'Days Left'}</div>
        </div>
        <div class="stat-card">
          <div class="stat-num" style="font-size:16px;padding-top:4px"><span class="code-badge" style="font-size:13px">${c.campaign_code}</span></div>
          <div class="stat-label">Campaign Code</div>
        </div>
      </div>

      <div class="info-card">
        <div class="info-row"><span class="ir-label">Campaign</span><span class="ir-value">${c.title}</span></div>
        <div class="info-row"><span class="ir-label">End Date</span><span class="ir-value" style="color:${isLastDay ? '#dc2626' : '#d97706'};font-weight:700">${fmtDate(c.end_date)}</span></div>
      </div>

      <p style="font-size:14px;color:#aaa">${isLastDay ? 'Your ad will stop displaying after today. Contact us immediately to extend your campaign.' : 'Your ad will stop displaying in 2 days. Book a renewal now to avoid any gap in display.'}</p>
      <a class="btn" href="${process.env.APP_URL || 'https://signagecrm-production.up.railway.app'}">Renew Campaign</a>`;

    await sendMail({
      to: c.email,
      subject: `${isLastDay ? 'Last Day!' : '2 Days Left'} – ${c.campaign_code} ends ${fmtDate(c.end_date)} | SignageCMS`,
      html: wrap(body),
    });
    console.log(`[Email] Expiry reminder (${daysLeft}d) sent to ${c.email} — ${c.campaign_code}`);
  } catch (err) {
    console.error('[Email] sendExpiryReminderEmail error:', err.message);
  }
}

// ── Campaign completed email ──────────────────────────────────────────────
async function sendCampaignCompletedEmail(campaignId) {
  try {
    const { rows } = await query(
      `SELECT c.title, c.campaign_code, c.start_date, c.end_date,
              c.amount_total,
              COALESCE(SUM(pl.play_count), 0) AS total_plays,
              COUNT(DISTINCT pl.screen_id) AS total_screens
       FROM campaigns c
       LEFT JOIN play_logs pl ON pl.campaign_id = c.id
       WHERE c.id = $1
       GROUP BY c.id, c.title, c.campaign_code, c.start_date, c.end_date, c.amount_total`,
      [campaignId]
    );
    const { rows: uRows } = await query(
      `SELECT u.email, u.first_name, u.last_name, u.business_name
       FROM campaigns c JOIN users u ON u.id = c.user_id WHERE c.id = $1`,
      [campaignId]
    );
    if (!rows.length || !uRows.length) return;
    const c = rows[0];
    const u = uRows[0];
    const name = u.business_name || `${u.first_name} ${u.last_name}`.trim();

    const body = `
      <div class="tag">Campaign Completed</div>
      <h2>Campaign Successfully Completed!</h2>
      <p class="sub">Hi ${name}, your campaign has successfully run its full duration.</p>

      <div class="stats-row cols-3">
        <div class="stat-card">
          <div class="stat-num brand">${parseInt(c.total_plays).toLocaleString('en-IN')}</div>
          <div class="stat-label">Total Plays</div>
        </div>
        <div class="stat-card">
          <div class="stat-num dark">${c.total_screens}</div>
          <div class="stat-label">Screens</div>
        </div>
        <div class="stat-card">
          <div class="stat-num green">&#10003;</div>
          <div class="stat-label">Completed</div>
        </div>
      </div>

      <div class="info-card">
        <div class="info-row"><span class="ir-label">Campaign</span><span class="ir-value">${c.title}</span></div>
        <div class="info-row"><span class="ir-label">Code</span><span class="ir-value"><span class="code-badge">${c.campaign_code}</span></span></div>
        <div class="info-row"><span class="ir-label">Duration</span><span class="ir-value">${fmtDate(c.start_date)} – ${fmtDate(c.end_date)}</span></div>
        <div class="info-row"><span class="ir-label">Total Investment</span><span class="ir-value">₹${parseFloat(c.amount_total).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</span></div>
      </div>

      <p style="font-size:14px;color:#aaa">Thank you for advertising with SignageCMS. View your complete proof of play report from the dashboard.</p>
      <a class="btn" href="${process.env.APP_URL || 'https://signagecrm-production.up.railway.app'}">View Full Report</a>`;

    await sendMail({
      to: u.email,
      subject: `Campaign Completed – ${c.campaign_code} | ${parseInt(c.total_plays).toLocaleString('en-IN')} total plays | SignageCMS`,
      html: wrap(body),
    });
    console.log(`[Email] Completed email sent to ${u.email} — ${c.campaign_code}, ${c.total_plays} plays`);
  } catch (err) {
    console.error('[Email] sendCampaignCompletedEmail error:', err.message);
  }
}

// ── Venue Partner Welcome Email ───────────────────────────────────────────
async function sendVenuePartnerWelcomeEmail({ to, businessName, contactName, email, password, city, approvedAt }) {
  const today = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });
  const startDate = approvedAt ? new Date(approvedAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }) : today;
  const endDate = (() => {
    const d = approvedAt ? new Date(approvedAt) : new Date();
    d.setFullYear(d.getFullYear() + 1);
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });
  })();
  const portalUrl = 'https://www.extrravenue.com/venue';

  const agreementHtml = `
    <hr class="divider">
    <div class="section-label" style="margin-top:8px;">Venue Partner Agreement</div>
    <div class="info-card" style="font-size:13px;color:#3a3a56;line-height:1.75;">
      <strong>Digital Signage Network Participation Agreement</strong><br><br>
      This Agreement is entered into as of <strong>${today}</strong>, between <strong>extrravenue</strong> ("Company") AND <strong>${contactName || businessName}</strong>, operating <strong>${businessName}</strong> at <strong>${city || '—'}</strong> ("Venue Partner").<br><br>
      <strong>1. Screen &amp; Installation</strong><br>
      extrravenue shall connect the digital screen at Venue Partner's premises to its CMS. extrravenue retains ownership of its media player hardware installed at the premises.<br><br>
      <strong>2. Content Slot Allocation</strong><br>
      Venue Partner is entitled to display their own content during Filler Slots — time not occupied by paid advertiser content. Paid third-party advertiser content takes absolute scheduling priority.<br><br>
      <strong>3. Utilities</strong><br>
      Venue Partner bears all costs for electricity and internet connectivity at their premises required to operate the screen and media player.<br><br>
      <strong>4. Content Guidelines</strong><br>
      Venue Partner shall ensure all uploaded content complies with applicable Indian laws. extrravenue reserves the right to remove violating content without notice.<br><br>
      <strong>5. Monetary Terms</strong><br>
      Non-monetary, service-exchange basis. No revenue share, rental fee, or commission payable by either Party.<br><br>
      <strong>6. Term &amp; Termination</strong><br>
      Valid for <strong>ONE (1) YEAR</strong> (${startDate} to ${endDate}), auto-renews unless either Party provides 30 days written notice. Either Party may terminate with 7 days' written notice.<br><br>
      <strong>7. Equipment Liability</strong><br>
      Venue Partner is responsible for protecting extrravenue's installed hardware from damage, theft, or vandalism.<br><br>
      <strong>8. Governing Law</strong><br>
      Governed by laws of India. Disputes resolved amicably within 15 days, failing which through arbitration under the Arbitration and Conciliation Act, 1996.
    </div>`;

  const html = wrap(`
    <div class="tag">Welcome</div>
    <h2>extrravenue Network mein Swagat hai! 🎉</h2>
    <p class="sub">Aapka venue partner account ban gaya hai. Neeche aapki login details aur agreement copy hai.</p>

    <div class="section-label">Login Details</div>
    <div class="info-card">
      <div class="info-row">
        <span class="ir-label">Portal URL</span>
        <span class="ir-value"><a href="${portalUrl}" style="color:#7b68c8;">${portalUrl}</a></span>
      </div>
      <div class="info-row">
        <span class="ir-label">Email</span>
        <span class="ir-value">${email}</span>
      </div>
      <div class="info-row">
        <span class="ir-label">Password</span>
        <span class="ir-value" style="font-family:monospace;letter-spacing:.05em;">${password}</span>
      </div>
    </div>

    <div class="section-label">Aapka Venue</div>
    <div class="info-card">
      <div class="info-row">
        <span class="ir-label">Business</span>
        <span class="ir-value">${businessName}</span>
      </div>
      <div class="info-row">
        <span class="ir-label">City</span>
        <span class="ir-value">${city || '—'}</span>
      </div>
    </div>

    <a href="${portalUrl}" class="btn" style="display:block;text-align:center;margin-bottom:20px;">Portal Pe Login Karo →</a>
    <p style="font-size:13px;color:#aaa8a2;text-align:center;">Pehli baar login karne ke baad password zaroor change karein.</p>
    ${agreementHtml}
  `);

  return sendMail({ to, subject: `extrravenue — Aapka Venue Partner Account Ready Hai`, html });
}

// ── Password Reset Email ───────────────────────────────────────────────────
async function sendPasswordResetEmail({ to, name, resetUrl }) {
  const html = wrap(`
    <div class="tag">Password Reset</div>
    <h2>Password Reset karo</h2>
    <p class="sub">Hume aapki request mili — neeche diye button se apna password reset karo.</p>
    <div class="info-card">
      <div class="info-row"><span class="ir-label">Account</span><span class="ir-value">${to}</span></div>
      <div class="info-row"><span class="ir-label">Link expires</span><span class="ir-value">1 ghante mein</span></div>
    </div>
    <a href="${resetUrl}" class="btn">New Password Set Karo &rarr;</a>
    <hr class="divider">
    <p style="font-size:13px;color:#aaa;">Agar aapne yeh request nahi ki, to is email ko ignore karo. Aapka account safe hai.</p>
  `);
  return sendMail({ to, subject: 'extrravenue — Password Reset Link', html });
}

// ── 45-Day Password Expiry Reminder ───────────────────────────────────────
async function sendPasswordExpiryReminderEmail({ to, name, resetUrl }) {
  const html = wrap(`
    <div class="tag">Security</div>
    <h2>Password Update karo</h2>
    <p class="sub">Hi ${name}, aapka password 45 din purana ho gaya hai. Security ke liye please update karo.</p>
    <a href="${resetUrl}" class="btn">Password Update Karo &rarr;</a>
    <hr class="divider">
    <p style="font-size:13px;color:#aaa;">Agar aap abhi update nahi karna chahte to ignore kar sakte hain, lekin hum recommend karte hain ki 45 din mein ek baar password zaroor update karein.</p>
  `);
  return sendMail({ to, subject: 'extrravenue — Password Update Reminder', html });
}

module.exports = {
  sendInvoiceEmail, sendApprovedEmail, sendRejectedEmail,
  sendPausedEmail, sendResumedEmail, sendOnHoldEmail,
  sendWalletCreditEmail,
  sendExpiryReminderEmail, sendCampaignCompletedEmail,
  sendDailyPoPReport, sendDailyPoPEmailAll, sendNewUserAlertEmail,
  sendVenuePartnerWelcomeEmail,
  sendPasswordResetEmail, sendPasswordExpiryReminderEmail,
};

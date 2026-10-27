const express = require('express');
const router = express.Router();
const { sendMail } = require('../services/email');

const SUPPORT_EMAIL = 'ads@extrravenue.com';

router.post('/', async (req, res) => {
  const { name, email, phone, subject, message } = req.body;

  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Name, email and message are required.' });
  }

  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(email)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }

  const subjectLine = `[Support] ${subject || 'General Inquiry'} — ${name}`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f2efe9;font-family:'Helvetica Neue',Arial,sans-serif;">
<div style="max-width:560px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e0dbd3;">
  <div style="background:#1e1e1e;padding:20px 28px;">
    <p style="margin:0;color:#fff;font-weight:700;font-size:17px;">extrravenue — Support Desk</p>
    <p style="margin:4px 0 0;color:rgba(255,255,255,.55);font-size:13px;">New inquiry from website</p>
  </div>
  <div style="padding:28px;">
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:8px 0;color:#888;width:110px;vertical-align:top;">Name</td><td style="padding:8px 0;font-weight:600;color:#1e1e1e;">${name}</td></tr>
      <tr><td style="padding:8px 0;color:#888;border-top:1px solid #f0ece6;vertical-align:top;">Email</td><td style="padding:8px 0;border-top:1px solid #f0ece6;"><a href="mailto:${email}" style="color:#ff5c00;">${email}</a></td></tr>
      ${phone ? `<tr><td style="padding:8px 0;color:#888;border-top:1px solid #f0ece6;vertical-align:top;">Phone</td><td style="padding:8px 0;border-top:1px solid #f0ece6;color:#1e1e1e;">${phone}</td></tr>` : ''}
      <tr><td style="padding:8px 0;color:#888;border-top:1px solid #f0ece6;vertical-align:top;">Subject</td><td style="padding:8px 0;border-top:1px solid #f0ece6;color:#1e1e1e;">${subject || 'General Inquiry'}</td></tr>
      <tr><td style="padding:8px 0;color:#888;border-top:1px solid #f0ece6;vertical-align:top;">Message</td><td style="padding:8px 0;border-top:1px solid #f0ece6;color:#1e1e1e;white-space:pre-line;">${message}</td></tr>
    </table>
  </div>
  <div style="background:#f9f7f4;padding:14px 28px;font-size:12px;color:#aaa;">Reply directly to this email to respond to ${name}.</div>
</div>
</body></html>`;

  try {
    await sendMail({ to: SUPPORT_EMAIL, subject: subjectLine, html });
    res.json({ ok: true });
  } catch (err) {
    console.error('[Contact] sendMail failed:', err.message);
    // Still return ok to user — they shouldn't see internal errors
    res.json({ ok: true });
  }
});

module.exports = router;

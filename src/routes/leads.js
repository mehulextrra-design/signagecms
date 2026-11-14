const express = require('express');
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const { body, validationResult } = require('express-validator');
const { query } = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { sendVenuePartnerWelcomeEmail } = require('../services/email');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});
const photoStorage = new CloudinaryStorage({
  cloudinary,
  params: { folder: 'lead-photos', allowed_formats: ['jpg','jpeg','png','webp','heic'] },
});
const uploadPhoto = multer({ storage: photoStorage, limits: { fileSize: 20 * 1024 * 1024 } });

const router = express.Router();

const VALID_STATUSES = [
  'new','assigned','contacted','meeting_scheduled','meeting_done',
  'site_visited','site_rejected','agreement_pending','agreement_signed',
  'installation_pending','installation_done','live','dropped'
];

const VALID_CATEGORIES = [
  'gym','restaurant','cafe','salon','clinic','retail','society','office','hotel','education','other'
];

function requireInspectorOrAdmin(req, res, next) {
  if (['admin','superadmin','venue_inspector'].includes(req.user.role)) return next();
  return res.status(403).json({ error: 'Access denied' });
}

// ── PUBLIC: submit interest form from website ─────────────────────────────────
router.post('/public', async (req, res, next) => {
  const { business_name, owner_name, phone, city, venue_category, footfall_estimate, screen_count } = req.body;
  if (!business_name || !phone) {
    return res.status(400).json({ error: 'business_name and phone are required' });
  }
  try {
    // Duplicate check: same phone already has a lead
    const dup = await query(
      `SELECT id FROM leads WHERE phone = $1 AND status NOT IN ('dropped','site_rejected')`,
      [phone.trim()]
    );
    if (dup.rows.length) {
      return res.status(409).json({ error: 'duplicate', message: 'Aapki inquiry already registered hai. Hamari team aapko 24 ghante mein contact karegi.' });
    }

    const result = await query(
      `INSERT INTO leads (business_name, owner_name, phone, city, venue_category, footfall_estimate, screen_count, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'website') RETURNING id, created_at`,
      [
        business_name.trim(),
        owner_name?.trim() || null,
        phone.trim(),
        city?.trim() || null,
        VALID_CATEGORIES.includes(venue_category) ? venue_category : 'other',
        footfall_estimate ? parseInt(footfall_estimate) : null,
        screen_count ? parseInt(screen_count) : 0
      ]
    );
    res.status(201).json({ ok: true, id: result.rows[0].id });
  } catch (err) { next(err); }
});

// ── GET users who can be assigned leads (admin/superadmin/venue_inspector) ───
router.get('/assignable-users', authenticate, requireInspectorOrAdmin, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, first_name, last_name, email, role
       FROM users WHERE role IN ('admin','superadmin','venue_inspector') AND is_active = true
       ORDER BY first_name, last_name`
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// ── LIST leads (admin + inspector) ───────────────────────────────────────────
router.get('/', authenticate, requireInspectorOrAdmin, async (req, res, next) => {
  const { status, city, assigned_to, q } = req.query;
  try {
    let where = ['1=1'];
    const params = [];

    // Inspectors only see their assigned leads
    if (req.user.role === 'venue_inspector') {
      params.push(req.user.id);
      where.push(`l.assigned_to = $${params.length}`);
    } else if (assigned_to) {
      params.push(assigned_to);
      where.push(`l.assigned_to = $${params.length}`);
    }

    if (status) { params.push(status); where.push(`l.status = $${params.length}`); }
    if (city)   { params.push(`%${city}%`); where.push(`l.city ILIKE $${params.length}`); }
    if (q)      {
      params.push(`%${q}%`);
      where.push(`(l.business_name ILIKE $${params.length} OR l.phone ILIKE $${params.length} OR l.owner_name ILIKE $${params.length})`);
    }

    const result = await query(
      `SELECT l.*,
         u.first_name AS inspector_name,
         (SELECT COUNT(*) FROM lead_activities la WHERE la.lead_id = l.id) AS activity_count,
         (SELECT note FROM lead_activities la WHERE la.lead_id = l.id ORDER BY la.created_at DESC LIMIT 1) AS last_note
       FROM leads l
       LEFT JOIN users u ON u.id = l.assigned_to
       WHERE ${where.join(' AND ')}
       ORDER BY l.updated_at DESC
       LIMIT 200`,
      params
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// ── GET single lead with activities ──────────────────────────────────────────
router.get('/:id', authenticate, requireInspectorOrAdmin, async (req, res, next) => {
  try {
    const lead = await query(
      `SELECT l.*, u.first_name AS inspector_name
       FROM leads l LEFT JOIN users u ON u.id = l.assigned_to
       WHERE l.id = $1`, [req.params.id]
    );
    if (!lead.rows.length) return res.status(404).json({ error: 'Not found' });

    // Inspectors can only view their own
    if (req.user.role === 'venue_inspector' && lead.rows[0].assigned_to !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const activities = await query(
      `SELECT la.*, u.first_name AS actor_name
       FROM lead_activities la LEFT JOIN users u ON u.id = la.actor_id
       WHERE la.lead_id = $1 ORDER BY la.created_at DESC`,
      [req.params.id]
    );
    res.json({ ...lead.rows[0], activities: activities.rows });
  } catch (err) { next(err); }
});

// ── CREATE lead manually (admin + inspector) ──────────────────────────────────
router.post('/', authenticate, requireInspectorOrAdmin, async (req, res, next) => {
  const { business_name, owner_name, phone, city, venue_category, footfall_estimate, screen_count, source, notes } = req.body;
  if (!business_name || !phone) {
    return res.status(400).json({ error: 'business_name and phone are required' });
  }
  try {
    const result = await query(
      `INSERT INTO leads (business_name, owner_name, phone, city, venue_category, footfall_estimate, screen_count, source, notes,
         assigned_to)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        business_name.trim(), owner_name?.trim() || null, phone.trim(),
        city?.trim() || null,
        VALID_CATEGORIES.includes(venue_category) ? venue_category : 'other',
        footfall_estimate ? parseInt(footfall_estimate) : null,
        screen_count ? parseInt(screen_count) : 0,
        source || 'walk_in',
        notes?.trim() || null,
        req.user.role === 'venue_inspector' ? req.user.id : (req.body.assigned_to || null)
      ]
    );
    // Log creation activity
    await query(
      `INSERT INTO lead_activities (lead_id, actor_id, activity_type, new_status, note)
       VALUES ($1,$2,'status_change','new',$3)`,
      [result.rows[0].id, req.user.id, `Lead added manually (${source || 'walk_in'})`]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

// ── UPDATE lead: status / assigned_to / notes (admin + inspector) ─────────────
router.patch('/:id', authenticate, requireInspectorOrAdmin, async (req, res, next) => {
  const { status, assigned_to, notes } = req.body;
  try {
    const existing = await query('SELECT * FROM leads WHERE id = $1', [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Not found' });
    const lead = existing.rows[0];

    if (req.user.role === 'venue_inspector' && lead.assigned_to !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` });
    }
    // Inspectors cannot assign leads
    if (assigned_to && req.user.role === 'venue_inspector') {
      return res.status(403).json({ error: 'Inspectors cannot reassign leads' });
    }

    // Set agreement_date when first reaching agreement_pending (locked for the life of the agreement)
    const setAgreementDate = status === 'agreement_pending' && !lead.agreement_date;

    const result = await query(
      `UPDATE leads SET
         status         = COALESCE($1, status),
         assigned_to    = COALESCE($2, assigned_to),
         notes          = COALESCE($3, notes),
         agreement_date = CASE WHEN $5::boolean THEN NOW() ELSE agreement_date END,
         updated_at     = NOW()
       WHERE id = $4 RETURNING *`,
      [status || null, assigned_to || null, notes || null, req.params.id, setAgreementDate]
    );

    // Log activity
    if (status && status !== lead.status) {
      await query(
        `INSERT INTO lead_activities (lead_id, actor_id, activity_type, old_status, new_status)
         VALUES ($1,$2,'status_change',$3,$4)`,
        [req.params.id, req.user.id, lead.status, status]
      );
    }
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// ── PHOTO UPLOAD (inspector + admin) ─────────────────────────────────────────
router.post('/:id/photos', authenticate, requireInspectorOrAdmin, uploadPhoto.single('photo'), async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });
  try {
    const lead = await query('SELECT photos, assigned_to FROM leads WHERE id = $1', [req.params.id]);
    if (!lead.rows.length) return res.status(404).json({ error: 'Not found' });
    if (req.user.role === 'venue_inspector' && lead.rows[0].assigned_to !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const photos = lead.rows[0].photos || [];
    if (photos.length >= 7) return res.status(400).json({ error: 'Maximum 7 photos allowed' });
    const newPhoto = { url: req.file.path, public_id: req.file.filename, uploaded_at: new Date().toISOString() };
    photos.push(newPhoto);
    await query('UPDATE leads SET photos = $1, updated_at = NOW() WHERE id = $2', [JSON.stringify(photos), req.params.id]);
    res.json({ ok: true, photo: newPhoto, photos });
  } catch (err) { next(err); }
});

// ── DELETE PHOTO ──────────────────────────────────────────────────────────────
router.delete('/:id/photos/:idx', authenticate, requireInspectorOrAdmin, async (req, res, next) => {
  try {
    const lead = await query('SELECT photos, assigned_to FROM leads WHERE id = $1', [req.params.id]);
    if (!lead.rows.length) return res.status(404).json({ error: 'Not found' });
    if (req.user.role === 'venue_inspector' && lead.rows[0].assigned_to !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const photos = lead.rows[0].photos || [];
    const idx = parseInt(req.params.idx);
    if (idx < 0 || idx >= photos.length) return res.status(400).json({ error: 'Invalid photo index' });
    const removed = photos.splice(idx, 1)[0];
    if (removed?.public_id) cloudinary.uploader.destroy(removed.public_id).catch(() => {});
    await query('UPDATE leads SET photos = $1, updated_at = NOW() WHERE id = $2', [JSON.stringify(photos), req.params.id]);
    res.json({ ok: true, photos });
  } catch (err) { next(err); }
});

// ── ADD activity / note (admin + inspector) ───────────────────────────────────
router.post('/:id/activity', authenticate, requireInspectorOrAdmin, async (req, res, next) => {
  const { activity_type, note } = req.body;
  if (!note && !activity_type) return res.status(400).json({ error: 'note or activity_type required' });
  try {
    const lead = await query('SELECT assigned_to FROM leads WHERE id = $1', [req.params.id]);
    if (!lead.rows.length) return res.status(404).json({ error: 'Not found' });
    if (req.user.role === 'venue_inspector' && lead.rows[0].assigned_to !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const result = await query(
      `INSERT INTO lead_activities (lead_id, actor_id, activity_type, note)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, req.user.id, activity_type || 'note', note?.trim() || null]
    );
    // bump updated_at on lead
    await query('UPDATE leads SET updated_at = NOW() WHERE id = $1', [req.params.id]);
    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

// POST /leads/:id/create-venue-partner — convert lead to venue partner with login
router.post('/:id/create-venue-partner', authenticate, requireInspectorOrAdmin, [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Valid email aur min 8 char password chahiye' });

  try {
    const leadRes = await query('SELECT * FROM leads WHERE id = $1', [req.params.id]);
    if (!leadRes.rows.length) return res.status(404).json({ error: 'Lead not found' });
    const lead = leadRes.rows[0];

    // Inspector only sees own leads
    if (req.user.role === 'venue_inspector' && lead.assigned_to !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { email, password } = req.body;

    // Check email not already used
    const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length) return res.status(409).json({ error: 'Yeh email already registered hai' });

    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash(password, 12);

    // Create venue_partner record
    const vpRes = await query(
      `INSERT INTO venue_partners (business_name, venue_category, city, address, contact_name, contact_phone, approval_status, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',false) RETURNING id`,
      [lead.business_name, lead.category || 'other', lead.city, lead.address || null, lead.contact_name, lead.phone]
    );
    const vpId = vpRes.rows[0].id;

    // Create user linked to venue_partner
    const userRes = await query(
      `INSERT INTO users (email, password_hash, role, first_name, business_name, city, is_verified, is_active, venue_partner_id)
       VALUES ($1,$2,'venue_partner',$3,$4,$5,TRUE,FALSE,$6) RETURNING id, email`,
      [email, hash, lead.contact_name || lead.business_name, lead.business_name, lead.city, vpId]
    );

    // Link user back to venue_partner; copy agreement_date from lead
    await query(
      'UPDATE venue_partners SET user_id = $1, agreement_date = $3 WHERE id = $2',
      [userRes.rows[0].id, vpId, lead.agreement_date || new Date()]
    );

    // Mark lead as VP created
    await query('UPDATE leads SET vp_created = TRUE WHERE id = $1', [req.params.id]);

    // Log activity on lead
    await query(
      `INSERT INTO lead_activities (lead_id, actor_id, activity_type, note)
       VALUES ($1,$2,'note',$3)`,
      [req.params.id, req.user.id, `Venue partner account created: ${email}`]
    );

    // Send welcome email (fire-and-forget)
    sendVenuePartnerWelcomeEmail({
      to: email,
      businessName: lead.business_name,
      contactName: lead.contact_name || lead.business_name,
      email,
      password,
      city: lead.city,
      approvedAt: new Date().toISOString(),
    }).catch(err => console.error('[VP Welcome Email]', err.message));

    res.status(201).json({ ok: true, email: userRes.rows[0].email, venue_partner_id: vpId });
  } catch (err) { next(err); }
});

// ── AGREEMENT HTML DOWNLOAD (auth via ?t= query param) ───────────────────────
router.get('/:id/agreement', async (req, res, next) => {
  try {
    const jwt = require('jsonwebtoken');
    const rawToken = req.query.t || (req.headers.authorization || '').replace('Bearer ', '');
    let decoded;
    try { decoded = jwt.verify(rawToken, process.env.JWT_SECRET); }
    catch(e) { return res.status(401).send('<h1>Unauthorized</h1>'); }

    if (!['admin','superadmin','venue_inspector'].includes(decoded.role)) {
      return res.status(403).send('<h1>Access denied</h1>');
    }

    const result = await query('SELECT * FROM leads WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).send('<h1>Not found</h1>');
    const l = result.rows[0];

    if (decoded.role === 'venue_inspector' && l.assigned_to !== decoded.userId) {
      return res.status(403).send('<h1>Access denied</h1>');
    }

    const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    const today = l.agreement_date
      ? new Date(l.agreement_date).toLocaleDateString('en-IN',{day:'2-digit',month:'long',year:'numeric'})
      : new Date().toLocaleDateString('en-IN',{day:'2-digit',month:'long',year:'numeric'});
    const isSigned = l.status === 'agreement_signed';

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Venue Partner Agreement</title>
<style>
  body{font-family:'Times New Roman',serif;max-width:750px;margin:0 auto;padding:40px 24px;color:#111;line-height:1.7;font-size:13pt;}
  h1{text-align:center;font-size:16pt;margin-bottom:6px;}
  .sub{text-align:center;font-size:11pt;color:#555;margin-bottom:32px;}
  h2{font-size:13pt;margin-top:24px;margin-bottom:6px;}
  p{margin-bottom:10px;text-align:justify;}
  .sig-grid{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:48px;}
  .sig-box p{border-top:1px solid #333;margin-top:48px;padding-top:6px;font-size:11pt;}
  .signed-badge{font-size:12pt;background:#e6f4ea;color:#1a7f37;padding:2px 10px;border-radius:4px;vertical-align:middle;}
  @media print{.no-print{display:none!important;}}
  @media(max-width:600px){body{padding:20px 16px;font-size:11pt;}.sig-grid{grid-template-columns:1fr;gap:20px;}}
</style></head><body>
<h1>Venue Partner Agreement${isSigned?' <span class="signed-badge">&#10003; Signed</span>':''}</h1>
<div class="sub">Digital Signage Network Participation Agreement</div>
<p>This Agreement is entered into as of <strong>${today}</strong>, between <strong>extrravenue</strong> (hereinafter <strong>"Company"</strong>), AND <strong>${esc(l.owner_name||'[Owner Name]')}</strong>, operating <strong>${esc(l.business_name)}</strong> located at <strong>${esc(l.city||'[City]')}</strong> (hereinafter <strong>"Venue Partner"</strong>).</p>
<h2>1. Screen &amp; Installation</h2>
<p>extrravenue shall connect the digital screen at the Venue Partner's premises to its CMS. If a new screen is required, cost and ownership shall be mutually agreed in writing. extrravenue retains ownership of its media player hardware installed at the premises.</p>
<h2>2. Content Slot Allocation</h2>
<p><strong>Venue Content:</strong> The Venue Partner is entitled to display their own promotional content during all available Filler Slots — screen time not occupied by paid advertiser content. <strong>Priority:</strong> Paid third-party advertiser content takes absolute scheduling priority.</p>
<h2>3. Utilities</h2>
<p>The Venue Partner shall bear all costs for electricity and internet connectivity at their premises required to operate the screen and media player.</p>
<h2>4. Content Guidelines</h2>
<p>The Venue Partner shall ensure all uploaded content complies with applicable Indian laws. extrravenue reserves the right to remove violating content without notice.</p>
<h2>5. Monetary Terms</h2>
<p>This Agreement is on a non-monetary, service-exchange basis. No revenue share, rental fee, or commission shall be payable by either Party.</p>
<h2>6. Term &amp; Termination</h2>
<p>Valid for <strong>ONE (1) YEAR</strong> from signing, auto-renews unless either Party provides 30 days written notice. Either Party may terminate with <strong>7 days' written notice</strong>.</p>
<h2>7. Equipment Liability</h2>
<p>The Venue Partner is responsible for protecting extrravenue's installed hardware from damage, theft, or vandalism and shall bear the cost of repair or replacement resulting from negligence.</p>
<h2>8. Governing Law</h2>
<p>Governed by the laws of India. Disputes shall first be resolved amicably within 15 days, failing which through arbitration under the Arbitration and Conciliation Act, 1996.</p>
<div class="sig-grid">
  <div class="sig-box"><p>For extrravenue<br>Name: ___________________<br>Designation: ____________<br>Date: ${today}</p></div>
  <div class="sig-box"><p>For Venue Partner<br>Name: ${esc(l.owner_name||'___________________')}<br>Business: ${esc(l.business_name)}<br>Date: ${today}</p></div>
</div>
</body></html>`;

    const fname = String(l.business_name||'agreement').replace(/[^a-z0-9]/gi,'_');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="agreement-${fname}.html"`);
    res.send(html);
  } catch(err) { next(err); }
});

module.exports = router;

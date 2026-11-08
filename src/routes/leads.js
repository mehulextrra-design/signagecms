const express = require('express');
const { query } = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

const VALID_STATUSES = [
  'new','assigned','contacted','meeting_scheduled','meeting_done',
  'site_visited','site_rejected','agreement_pending','agreement_signed',
  'installation_pending','installation_done','live','dropped'
];

const VALID_CATEGORIES = [
  'gym','restaurant','salon','clinic','retail','society','office','hotel','education','other'
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

    const result = await query(
      `UPDATE leads SET
         status      = COALESCE($1, status),
         assigned_to = COALESCE($2, assigned_to),
         notes       = COALESCE($3, notes),
         updated_at  = NOW()
       WHERE id = $4 RETURNING *`,
      [status || null, assigned_to || null, notes || null, req.params.id]
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

module.exports = router;

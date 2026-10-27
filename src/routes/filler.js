/**
 * Filler Content API — admin only
 * Platform-level filler shown when no paid/venue content fills the slot
 */
const express = require('express');
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const { query } = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    const isVideo = file.mimetype.startsWith('video/');
    return {
      folder: 'signagecms/filler',
      resource_type: isVideo ? 'video' : 'image',
      public_id: `filler-${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g,'_')}`,
      ...(isVideo ? {} : { transformation: [{ quality: 'auto', fetch_format: 'auto' }] }),
    };
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['video/mp4','video/webm','image/jpeg','image/png','image/webp','image/gif'];
    ok.includes(file.mimetype) ? cb(null, true) : cb(new Error('Unsupported file type'));
  },
});

// GET /api/filler — list all filler content with assigned screen ids
router.get('/', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT f.*,
              COALESCE(
                array_agg(fsa.screen_id::text) FILTER (WHERE fsa.screen_id IS NOT NULL),
                '{}'
              ) AS screen_ids
       FROM filler_content f
       LEFT JOIN filler_screen_assignments fsa ON fsa.filler_id = f.id
       GROUP BY f.id
       ORDER BY f.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// POST /api/filler/upload — upload new filler file
router.post('/upload', authenticate, requireAdmin, upload.single('file'), async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const isVideo  = req.file.mimetype.startsWith('video/');
    const fileUrl  = req.file.path || req.file.secure_url || req.file.url;
    const duration = parseFloat(req.body.duration_sec || (isVideo ? 30 : 10));
    const title    = req.body.title || req.file.originalname;

    const result = await query(
      `INSERT INTO filler_content (title, file_url, type, duration_sec, is_active)
       VALUES ($1,$2,$3,$4,TRUE) RETURNING *`,
      [title, fileUrl, isVideo ? 'video' : 'image', duration]
    );
    const filler = result.rows[0];

    // Save screen assignments (empty array = all screens)
    let screenIds = [];
    try { screenIds = JSON.parse(req.body.screen_ids || '[]'); } catch (_) {}
    if (Array.isArray(screenIds) && screenIds.length) {
      for (const sid of screenIds) {
        await query(
          `INSERT INTO filler_screen_assignments (filler_id, screen_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [filler.id, sid]
        );
      }
    }

    // Notify all online screens to reload their schedule
    await query(
      `INSERT INTO remote_commands (screen_id, command, payload)
       SELECT id, 'reload', '{"reason":"filler_updated"}'
       FROM screens WHERE status = 'online'`
    ).catch(() => {});

    res.status(201).json({ ...filler, screen_ids: screenIds });
  } catch (err) { next(err); }
});

// PATCH /api/filler/:id — update title / duration / active state / screen assignments
router.patch('/:id', authenticate, requireAdmin, async (req, res, next) => {
  const { title, duration_sec, is_active, screen_ids } = req.body;
  try {
    const result = await query(
      `UPDATE filler_content
       SET title        = COALESCE($1, title),
           duration_sec = COALESCE($2, duration_sec),
           is_active    = COALESCE($3, is_active)
       WHERE id = $4 RETURNING *`,
      [title || null, duration_sec || null, is_active ?? null, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });

    // Replace screen assignments if provided
    if (Array.isArray(screen_ids)) {
      await query(`DELETE FROM filler_screen_assignments WHERE filler_id=$1`, [req.params.id]);
      for (const sid of screen_ids) {
        await query(
          `INSERT INTO filler_screen_assignments (filler_id, screen_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [req.params.id, sid]
        );
      }
    }

    res.json({ ...result.rows[0], screen_ids: screen_ids ?? [] });
  } catch (err) { next(err); }
});

// DELETE /api/filler/:id — remove filler item
router.delete('/:id', authenticate, requireAdmin, async (req, res, next) => {
  try {
    await query(`DELETE FROM filler_content WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;

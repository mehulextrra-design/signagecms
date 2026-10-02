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

// GET /api/filler — list all filler content
router.get('/', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT * FROM filler_content ORDER BY created_at DESC`
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

    // Notify all online screens to reload their schedule
    await query(
      `INSERT INTO remote_commands (screen_id, command, payload)
       SELECT id, 'reload', '{"reason":"filler_updated"}'
       FROM screens WHERE status = 'online'`
    ).catch(() => {});

    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

// PATCH /api/filler/:id — update title / duration / active state
router.patch('/:id', authenticate, requireAdmin, async (req, res, next) => {
  const { title, duration_sec, is_active } = req.body;
  try {
    const result = await query(
      `UPDATE filler_content
       SET title       = COALESCE($1, title),
           duration_sec = COALESCE($2, duration_sec),
           is_active   = COALESCE($3, is_active)
       WHERE id = $4 RETURNING *`,
      [title || null, duration_sec || null, is_active ?? null, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
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

const express = require('express');
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const { query } = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

const ALLOWED_MIME = ['video/mp4', 'video/webm', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_SIZE_MB = parseInt(process.env.MAX_FILE_SIZE_MB || 200);

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Cloudinary storage — permanent, survives redeploys
const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    const isVideo = file.mimetype.startsWith('video/');
    return {
      folder: 'signagecms',
      resource_type: isVideo ? 'video' : 'image',
      // Keep original filename in public_id for traceability
      public_id: `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`,
      // For images: auto optimize quality
      ...(isVideo ? {} : { transformation: [{ quality: 'auto', fetch_format: 'auto' }] }),
    };
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_SIZE_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Unsupported file type. Allowed: MP4, WebM, JPG, PNG, WebP, GIF'));
  },
});

// GET /api/content/all — admin: all content
router.get('/all', authenticate, async (req, res, next) => {
  if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin only' });
  try {
    const result = await query(
      `SELECT c.*, u.email, u.first_name, u.business_name FROM content c
       LEFT JOIN users u ON u.id = c.user_id
       WHERE c.status='active' ORDER BY c.created_at DESC LIMIT 200`
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// GET /api/content/storage — user's storage usage
router.get('/storage', authenticate, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT COALESCE(SUM(file_size),0) AS used_bytes, COUNT(*) AS file_count
       FROM content WHERE user_id=$1 AND status='active'`,
      [req.user.id]
    );
    const usedBytes = parseInt(result.rows[0].used_bytes);
    const limitBytes = 500 * 1024 * 1024; // 500MB
    res.json({ used_bytes: usedBytes, limit_bytes: limitBytes, file_count: parseInt(result.rows[0].file_count) });
  } catch (err) { next(err); }
});

// GET /api/content — user's own library
router.get('/', authenticate, async (req, res, next) => {
  try {
    const result = await query(
      'SELECT * FROM content WHERE user_id = $1 AND status = $2 ORDER BY created_at DESC',
      [req.user.id, 'active']
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// POST /api/content/upload
router.post('/upload', authenticate, upload.single('file'), async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const { originalname, mimetype, size } = req.file;
    const type = mimetype.startsWith('video/') ? 'video' : 'image';

    // Cloudinary gives us the permanent URL directly
    const fileUrl = req.file.path;                      // permanent Cloudinary URL
    const storedName = req.file.filename;               // public_id
    const filePath = req.file.filename;

    const result = await query(
      `INSERT INTO content (user_id, original_name, stored_name, file_path, file_url, mime_type, file_size, type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.user.id, originalname, storedName, filePath, fileUrl, mimetype, size, type]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/content/:id
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const inUse = await query(
      `SELECT c.campaign_code FROM campaigns c
       WHERE c.content_id=$1 AND c.user_id=$2 AND c.status NOT IN ('cancelled','completed','rejected')`,
      [req.params.id, req.user.id]
    );
    if (inUse.rows.length) {
      return res.status(409).json({ error: `File is used in active campaign ${inUse.rows[0].campaign_code}` });
    }
    await query('UPDATE content SET status=$1 WHERE id=$2 AND user_id=$3', ['deleted', req.params.id, req.user.id]);
    res.json({ message: 'File deleted' });
  } catch (err) { next(err); }
});

// Multer error handler
router.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: `File too large. Max: ${MAX_SIZE_MB}MB` });
  if (err.message) return res.status(400).json({ error: err.message });
  next(err);
});

module.exports = router;

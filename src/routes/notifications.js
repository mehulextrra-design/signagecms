const express = require('express');
const { query } = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// GET /api/notifications — user's own notifications
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { limit = 30 } = req.query;
    const result = await query(
      'SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2',
      [req.user.id, limit]
    );
    res.json({ notifications: result.rows });
  } catch (err) { next(err); }
});

// PUT /api/notifications/:id/read
router.put('/:id/read', authenticate, async (req, res, next) => {
  try {
    await query('UPDATE notifications SET is_read=TRUE WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    res.json({ message: 'Marked as read' });
  } catch (err) { next(err); }
});

// PUT /api/notifications/read-all
router.put('/read-all', authenticate, async (req, res, next) => {
  try {
    await query('UPDATE notifications SET is_read=TRUE WHERE user_id=$1', [req.user.id]);
    res.json({ message: 'All marked as read' });
  } catch (err) { next(err); }
});

// POST /api/notifications/send — admin: send to specific user or broadcast
router.post('/send', authenticate, requireAdmin, async (req, res, next) => {
  const { user_id, title, body, type = 'info', action_url } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });
  try {
    if (user_id) {
      // Send to specific user
      await query(
        'INSERT INTO notifications (user_id, title, body, type, action_url) VALUES ($1,$2,$3,$4,$5)',
        [user_id, title, body, type, action_url]
      );
      res.json({ message: 'Notification sent', count: 1 });
    } else {
      // Broadcast to all advertisers
      const users = await query("SELECT id FROM users WHERE role='advertiser' AND is_active=TRUE");
      for (const u of users.rows) {
        await query(
          'INSERT INTO notifications (user_id, title, body, type, action_url) VALUES ($1,$2,$3,$4,$5)',
          [u.id, title, body, type, action_url]
        );
      }
      res.json({ message: 'Broadcast sent', count: users.rows.length });
    }
    // Log activity
    await query(
      "INSERT INTO activity_log (user_id, action, entity_type, details) VALUES ($1,'notification_sent','notification',$2)",
      [req.user.id, JSON.stringify({ title, user_id: user_id || 'broadcast', type })]
    );
  } catch (err) { next(err); }
});

// GET /api/notifications/all — admin: list recent notifications sent
router.get('/all', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { limit = 50 } = req.query;
    const result = await query(
      `SELECT n.*, u.email, u.first_name FROM notifications n
       LEFT JOIN users u ON u.id = n.user_id
       ORDER BY n.created_at DESC LIMIT $1`,
      [limit]
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

module.exports = router;

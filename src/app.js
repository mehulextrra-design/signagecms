require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');

const authRoutes = require('./routes/auth');
const screenRoutes = require('./routes/screens');
const campaignRoutes = require('./routes/campaigns');
const contentRoutes = require('./routes/content');
const playerRoutes = require('./routes/player');
const reportRoutes = require('./routes/reports');
const userRoutes = require('./routes/users');
const billingRoutes = require('./routes/billing');
const couponRoutes = require('./routes/coupons');
const notificationRoutes = require('./routes/notifications');

const { startScheduler } = require('./services/scheduler');

const app = express();

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:", "*"],
      connectSrc: ["'self'", "*"],
    }
  }
}));
app.use(cors({ origin: process.env.CMS_ORIGIN || '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// CMS frontend — HTML files never cached, assets cached 1 day
app.use(express.static(path.join(__dirname, '../public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
    }
  }
}));

// Rate limiting
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Too many attempts, try again later' } });

app.use('/api/', apiLimiter);
app.use('/api/auth/', authLimiter);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/screens', screenRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/content', contentRoutes);
app.use('/api/player', playerRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/users', userRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/coupons', couponRoutes);
app.use('/api/notifications', notificationRoutes);

// Admin panel shortcut — no-cache
app.get('/admin', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.sendFile(path.join(__dirname, '../public/admin.html'));
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), version: '1.0.0' });
});

// 404
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// Global error handler
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.stack);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
});

async function runMigrations() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  });
  try {
    const sql = fs.readFileSync(path.join(__dirname, '../migrations/001_initial_schema.sql'), 'utf8');
    await pool.query(sql);
    console.log('[DB] Migrations applied successfully');
  } catch (err) {
    console.error('[DB] Migration error:', err.message);
  } finally {
    await pool.end();
  }
}

const PORT = process.env.PORT || 3000;
runMigrations().then(() => {
  app.listen(PORT, () => {
    console.log(`SignageCMS API running on port ${PORT}`);
    startScheduler();
  });
});

module.exports = app;

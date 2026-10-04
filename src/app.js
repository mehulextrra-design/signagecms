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
const walletRoutes = require('./routes/wallet');
const venuePartnerRoutes = require('./routes/venuePartners');
const fillerRoutes = require('./routes/filler');

const { startScheduler } = require('./services/scheduler');

const app = express();

app.set('trust proxy', 1);

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net", "https://checkout.razorpay.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:", "*"],
      connectSrc: ["'self'", "*"],
      frameSrc: ["'self'", "https://api.razorpay.com", "https://checkout.razorpay.com"],
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
app.use('/api/wallet', walletRoutes);
app.use('/api/venue-partners', venuePartnerRoutes);
app.use('/api/filler', fillerRoutes);

// Venue portal shortcut — no-cache
app.get('/venue', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.sendFile(path.join(__dirname, '../public/venue.html'));
});

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

// Critical column fixes — run before file-based migrations, every startup.
// These are hardcoded here so they ALWAYS execute regardless of migration file state.
async function applyCriticalFixes(pool) {
  // Fix play_logs.duration_sec: must be NUMERIC(10,3) — APK sends decimal seconds like 10.005
  // Use direct JS queries (no DO $$ block) for maximum reliability
  try {
    const colRes = await pool.query(
      `SELECT atttypid FROM pg_attribute
       WHERE attrelid = 'play_logs'::regclass
         AND attname   = 'duration_sec'
         AND NOT attisdropped`
    );
    const typid = colRes.rows.length ? Number(colRes.rows[0].atttypid) : null;
    // OID 23=int4 (INTEGER), 21=int2 (SMALLINT), 20=int8 (BIGINT)
    if (typid !== null && [23, 21, 20].includes(typid)) {
      await pool.query(
        `ALTER TABLE play_logs ALTER COLUMN duration_sec TYPE NUMERIC(10,3) USING duration_sec::NUMERIC(10,3)`
      );
      console.log(`[DB] Fixed: play_logs.duration_sec OID=${typid} -> NUMERIC(10,3)`);
    } else {
      console.log(`[DB] play_logs.duration_sec OK (OID=${typid}), no fix needed`);
    }
  } catch (err) {
    console.warn('[DB] Critical fix warn:', err.message);
  }
  console.log('[DB] Critical column fixes done');
}

async function runMigrations() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  });
  try {
    await applyCriticalFixes(pool);

    const migrationsDir = path.join(__dirname, '../migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    let applied = 0, failed = 0;
    for (const file of files) {
      try {
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        await pool.query(sql);
        console.log(`[DB] Migration OK: ${file}`);
        applied++;
      } catch (err) {
        // Expected for already-applied CREATE TABLE migrations — log and continue
        console.warn(`[DB] Migration skip/warn (${file}): ${err.message}`);
        failed++;
      }
    }
    console.log(`[DB] Migrations done — applied: ${applied}, skipped/warned: ${failed}`);
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

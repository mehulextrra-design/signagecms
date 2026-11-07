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
const facebookRoutes = require('./routes/facebook');
const contactRoutes = require('./routes/contact');
const googleRoutes    = require('./routes/google');
const instagramRoutes = require('./routes/instagram');
const blogRoutes = require('./routes/blog');
const waRoutes  = require('./routes/whatsapp-connect');

const { startScheduler } = require('./services/scheduler');
const { restoreActiveSessions } = require('./services/whatsapp-broadcast');

const app = express();

app.set('trust proxy', 1);

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net", "https://checkout.razorpay.com", "https://maps.googleapis.com", "https://maps.gstatic.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:", "*", "https://maps.gstatic.com", "https://maps.googleapis.com"],
      connectSrc: ["'self'", "*"],
      frameSrc: ["'self'", "https://api.razorpay.com", "https://checkout.razorpay.com"],
    }
  }
}));
app.use(cors({ origin: process.env.CMS_ORIGIN || '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Redirect Railway URL → canonical custom domain (keep /api/* on Railway for player APK)
app.use((req, res, next) => {
  if (req.hostname === 'signagecrm-production.up.railway.app' && !req.path.startsWith('/api/')) {
    return res.redirect(301, 'https://www.extrravenue.com' + req.originalUrl);
  }
  next();
});

// Favicon — browsers auto-request /favicon.ico before reading <link> tags
app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/favicon.svg'), {
    headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' }
  });
});

// Redirect old v1 landing page to current v2
app.get('/extrravenue-signage.html', (req, res) => res.redirect(301, '/extrravenue-signage-v2.html'));

// Public domain root → landing page; Railway URL root → CMS (index.html)
app.get('/', (req, res, next) => {
  const host = req.hostname;
  if (host === 'www.extrravenue.com' || host === 'extrravenue.com') {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    return res.sendFile(path.join(__dirname, '../public/extrravenue-signage-v2.html'));
  }
  next();
});

// /cms → Advertiser portal (works on all domains)
app.get('/cms', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

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
app.use('/api/auth/facebook', facebookRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/auth/google',     googleRoutes);
app.use('/api/auth/instagram', instagramRoutes);
app.use('/api/blog', blogRoutes);
app.use('/api/wa', waRoutes);

// Public config — exposes safe client-side keys (no auth needed)
app.get('/api/config', (req, res) => {
  res.json({
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || ''
  });
});

// Public gallery — reads img/carousel/ folder, no auth needed
app.get('/api/gallery', (req, res) => {
  const fs = require('fs');
  const dir = path.join(__dirname, '../public/img/carousel');
  const ALLOWED = /\.(jpe?g|png|webp|gif|mp4|webm|mov)$/i;
  try {
    const files = fs.readdirSync(dir)
      .filter(f => ALLOWED.test(f) && !f.startsWith('.'))
      .map(f => 'img/carousel/' + f);
    res.json(files);
  } catch (e) {
    res.json([]);
  }
});

// Privacy Policy — required by Meta app review
app.get('/privacy', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Privacy Policy – SignageCMS</title>
  <style>body{font-family:sans-serif;max-width:800px;margin:40px auto;padding:0 20px;line-height:1.6;color:#333}</style></head>
  <body><h1>Privacy Policy</h1><p>Last updated: October 2026</p>
  <p>SignageCMS ("we") collects and uses data to provide digital signage advertising services.</p>
  <h2>Data We Collect</h2><ul>
  <li>Account information (name, email, phone)</li>
  <li>Campaign content (images, videos)</li>
  <li>Facebook/Instagram page access tokens (when you connect your account)</li></ul>
  <h2>How We Use Data</h2><ul>
  <li>To display your campaigns on connected screens</li>
  <li>To post campaign content to your Facebook/Instagram pages (only when you authorize)</li></ul>
  <h2>Data Sharing</h2><p>We do not sell your data. Facebook/Instagram data is only used to post on your behalf.</p>
  <h2>Contact</h2><p>Email: support@signagecms.in</p></body></html>`);
});

// Data Deletion — required by Meta
app.get('/data-deletion', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Data Deletion – SignageCMS</title>
  <style>body{font-family:sans-serif;max-width:800px;margin:40px auto;padding:0 20px;line-height:1.6;color:#333}</style></head>
  <body><h1>Data Deletion Request</h1>
  <p>To delete your data from SignageCMS:</p>
  <ol><li>Log in to your account</li>
  <li>Go to Profile → Social Accounts → Disconnect Facebook</li>
  <li>Or email us at support@signagecms.in with subject "Delete My Data"</li></ol>
  <p>We will remove all your data within 30 days.</p></body></html>`);
});

// Generated blog post pages
app.get('/blog/generated/:slug', async (req, res) => {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  });
  try {
    const result = await pool.query(
      `SELECT * FROM blog_posts WHERE slug = $1 AND is_published = true`, [req.params.slug]
    );
    await pool.end();
    if (!result.rows.length) return res.status(404).sendFile(path.join(__dirname, '../public/404.html'));
    const p = result.rows[0];
    const date = p.published_at ? new Date(p.published_at).toLocaleDateString('en-IN', {day:'numeric',month:'long',year:'numeric'}) : '';
    const shareUrl = `${req.protocol}://${req.get('host')}/blog/generated/${p.slug}`;
    res.setHeader('Cache-Control', 'no-store');
    res.send(`<!DOCTYPE html><html lang="hi"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${p.title} — extrravenue Blog</title>
<meta name="description" content="${p.description}">
<meta property="og:title" content="${p.title}">
<meta property="og:description" content="${p.description}">
${p.hero_image_url ? `<meta property="og:image" content="${p.hero_image_url}">` : ''}
<meta property="og:url" content="${shareUrl}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Magra:wght@400;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--orange:#7b68c8;--oh:#6154b0;--fg:#1a1a2e;--bg:#fff;--text2:#4a4a6a;--text3:#7a7a9a;--surface:#f8f8fc;--border:#e8e8f0;--r:16px}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',sans-serif;color:var(--fg);background:var(--bg);line-height:1.6}
a{color:inherit;text-decoration:none}
.nav{position:sticky;top:0;z-index:99;background:rgba(255,255,255,.95);backdrop-filter:blur(10px);border-bottom:1px solid var(--border)}
.nav-inner{max-width:900px;margin:0 auto;padding:0 24px;height:58px;display:flex;align-items:center;justify-content:space-between}
.nav-logo{display:flex;align-items:center;gap:10px;font-weight:700;font-size:15px}
.nav-back{display:flex;align-items:center;gap:6px;font-size:14px;color:var(--text2)}
.nav-cta{background:linear-gradient(135deg,#c94baa 0%,#7b68c8 55%,#2ca6d4 100%);color:#fff;padding:8px 18px;border-radius:50px;font-size:13px;font-weight:700}
.article-hero{background:var(--surface);padding:0}
.hero-inner{max-width:900px;margin:0 auto;padding:48px 24px 36px}
.hero-meta{display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap}
.cat-tag{background:var(--orange);color:#fff;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;padding:4px 12px;border-radius:50px}
.read-time{font-size:13px;color:var(--text3)}
.meta-dot{width:3px;height:3px;border-radius:50%;background:var(--text3)}
.hero-inner h1{font-family:'Magra',sans-serif;font-size:clamp(24px,4vw,38px);font-weight:700;line-height:1.2;letter-spacing:-.02em;margin-bottom:16px}
.lead{font-size:17px;color:var(--text2);line-height:1.65;max-width:680px}
.hero-img{aspect-ratio:16/6;overflow:hidden}
.hero-img img{width:100%;height:100%;object-fit:cover}
.article-body{max-width:720px;margin:0 auto;padding:48px 24px 64px}
.article-body h2{font-family:'Magra',sans-serif;font-size:22px;font-weight:700;margin:2.5rem 0 1rem;letter-spacing:-.01em}
.article-body p{margin-bottom:1.2rem;color:var(--text2);font-size:15.5px}
.article-body ul,.article-body ol{margin:0 0 1.2rem 1.4rem;color:var(--text2);font-size:15.5px}
.article-body li{margin-bottom:.5rem}
.pull-quote{border-left:3px solid var(--orange);background:rgba(123,104,200,.06);padding:20px 24px;border-radius:0 12px 12px 0;margin:2rem 0}
.pull-quote p{color:var(--fg);font-size:16px;font-style:italic;font-weight:500;margin:0}
.cta-inline{background:linear-gradient(135deg,rgba(201,75,170,.08) 0%,rgba(123,104,200,.08) 55%,rgba(44,166,212,.08) 100%);border:1px solid rgba(123,104,200,.2);border-radius:var(--r);padding:32px;text-align:center;margin:2.5rem 0}
.cta-inline h3{font-family:'Magra',sans-serif;font-size:20px;font-weight:700;margin-bottom:10px}
.cta-inline p{margin-bottom:20px;color:var(--text2)}
.cta-inline a{background:linear-gradient(135deg,#c94baa 0%,#7b68c8 55%,#2ca6d4 100%);color:#fff;padding:12px 28px;border-radius:50px;font-weight:700;display:inline-block}
.share-row{display:flex;align-items:center;gap:12px;margin:2.5rem 0 2rem;flex-wrap:wrap}
.share-label{font-size:.85rem;color:var(--text3);font-weight:600;text-transform:uppercase;letter-spacing:.06em}
.share-btn{display:inline-flex;align-items:center;gap:7px;padding:9px 18px;border-radius:50px;font-size:.875rem;font-weight:600;text-decoration:none;cursor:pointer;border:none;transition:opacity .15s}
.share-btn.wa{background:#25d366;color:#fff}.share-btn.fb{background:#1877f2;color:#fff}
.share-btn.copy{background:#f1f1f4;color:var(--fg)}.share-btn:hover{opacity:.85}
.mini-footer{background:var(--fg);color:rgba(255,255,255,.55);display:flex;flex-wrap:wrap;gap:16px;align-items:center;justify-content:center;padding:20px 24px;font-size:13px}
.mini-footer a{color:rgba(255,255,255,.7)}
@media(max-width:640px){.share-btn span{display:none}}
</style></head>
<body>
<nav class="nav"><div class="nav-inner">
  <a href="/extrravenue-signage-v2.html" class="nav-logo">
    <svg width="37" height="40" viewBox="0 0 37 40" fill="none"><path d="M22.79 23.89L22.5 23.89L24.87 27.91C29.97 27.17 33.99 23.37 34.82 18.57L29.89 18.67C29.01 21.63 26.19 23.82 22.79 23.89Z" fill="#D44A9A"/><path d="M19.34 22.62L19.33 22.61C22.15 22.34 24.69 21.14 26.58 19.33C28.73 17.28 30.05 14.45 30.05 11.33C30.05 11.14 30.05 10.95 30.04 10.77H30.04C29.73 4.77 24.52 0 18.14 0H0L2.34 4.16H17.7C21.87 4.16 25.24 7.37 25.24 11.33C25.24 15.29 21.87 18.51 17.7 18.51L10.37 18.6L12.61 22.66L22.23 39.89H28.96L19.34 22.62Z" fill="#1D91D3"/><path d="M22.74 14.32C23.09 13.32 23.3 12.25 23.34 11.14C23.35 11 23.35 10.87 23.35 10.73C23.35 10.58 23.35 10.43 23.34 10.28V10.17H5.68L8 14.32L22.74 14.32Z" fill="#D44A9A"/><path d="M32.55 10.17C32.55 10.21 32.56 10.24 32.56 10.28V11.14C32.52 12.25 31.95 14.33H36.26V10.17L32.55 10.17Z" fill="#1D91D3"/></svg>
    extrravenue
  </a>
  <a href="/blog.html" class="nav-back"><svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18"/></svg> Blog</a>
  <a href="https://signagecrm-production.up.railway.app" class="nav-cta">Free Account</a>
</div></nav>
<header class="article-hero">
  <div class="hero-inner">
    <div class="hero-meta">
      <span class="cat-tag">${p.category}</span>
      <span class="meta-dot"></span>
      <time class="read-time">${date} · ${p.read_time}</time>
    </div>
    <h1>${p.title}</h1>
    <p class="lead">${p.description}</p>
  </div>
  ${p.hero_image_url ? `<div class="hero-img"><img src="${p.hero_image_url}" alt="${p.title}" loading="eager"></div>` : ''}
</header>
<article class="article-body">
${p.content_html}
  <div class="share-row">
    <span class="share-label">Share:</span>
    <a class="share-btn wa" href="#" onclick="shareWA(event)"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg><span>WhatsApp</span></a>
    <a class="share-btn fb" href="#" onclick="shareFB(event)"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg><span>Facebook</span></a>
    <button class="share-btn copy" onclick="copyLink(this)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg><span class="copy-lbl">Copy Link</span></button>
  </div>
</article>
<footer class="mini-footer">
  <span>© 2026 extrravenue</span>
  <a href="/blog.html">Blog</a>
  <a href="/extrravenue-signage-v2.html">Home</a>
  <a href="https://signagecrm-production.up.railway.app">Advertiser Login</a>
</footer>
<script>
function shareWA(e){e.preventDefault();window.open('https://wa.me/?text='+encodeURIComponent(document.querySelector('h1').innerText+' — '+location.href),'_blank');}
function shareFB(e){e.preventDefault();window.open('https://www.facebook.com/sharer/sharer.php?u='+encodeURIComponent(location.href),'_blank','width=600,height=400');}
function copyLink(btn){var lbl=btn.querySelector('.copy-lbl');navigator.clipboard.writeText(location.href).then(function(){var o=lbl.textContent;lbl.textContent='Copied!';setTimeout(function(){lbl.textContent=o;},2000);}).catch(function(){});}
</script>
</body></html>`);
  } catch (err) {
    console.error('[Blog page]', err.message);
    res.status(500).send('Server error');
  }
});

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

// Serve generated invoice PDFs for WhatsApp delivery (bypasses Cloudinary)
const { getPDF } = require('./services/pdf-store');
app.get('/pdfs/:invoiceNo', (req, res) => {
  const buf = getPDF(req.params.invoiceNo);
  if (!buf) return res.status(404).json({ error: 'PDF not found or expired' });
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename="${req.params.invoiceNo}.pdf"`);
  res.send(buf);
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
  // WA broadcast columns (migration 025)
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS wa_enabled BOOLEAN NOT NULL DEFAULT FALSE`);
    await pool.query(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS wa_broadcast_enabled BOOLEAN NOT NULL DEFAULT FALSE`);
    console.log('[DB] WA columns ensured');
  } catch (err) {
    console.warn('[DB] WA column fix warn:', err.message);
  }
  // WA tables (migration 025) — guaranteed creation
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS wa_sessions (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
      auth_state   JSONB NOT NULL DEFAULT '{}',
      status       VARCHAR(20) NOT NULL DEFAULT 'disconnected',
      phone_number VARCHAR(20),
      connected_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_id)
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS wa_contacts (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name       VARCHAR(100),
      phone      VARCHAR(20) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS wa_contacts_user_idx ON wa_contacts(user_id)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS wa_broadcasts (
      id             SERIAL PRIMARY KEY,
      campaign_id    INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
      user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      total_contacts INTEGER NOT NULL DEFAULT 0,
      sent_count     INTEGER NOT NULL DEFAULT 0,
      failed_count   INTEGER NOT NULL DEFAULT 0,
      status         VARCHAR(20) NOT NULL DEFAULT 'pending',
      started_at     TIMESTAMPTZ,
      completed_at   TIMESTAMPTZ
    )`);
    console.log('[DB] WA tables ensured');
  } catch (err) {
    console.warn('[DB] WA tables fix warn:', err.message);
  }
  // WA disclaimer acceptance audit log (migration 026)
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS wa_disclaimer_acceptances (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ip_address VARCHAR(45),
      user_agent TEXT,
      disclaimer_version VARCHAR(20) NOT NULL DEFAULT 'v1'
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS wa_disclaimer_user_idx ON wa_disclaimer_acceptances(user_id)`);
    console.log('[DB] wa_disclaimer_acceptances ensured');
  } catch (err) {
    console.warn('[DB] WA disclaimer table fix warn:', err.message);
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
    restoreActiveSessions();
  });
});

module.exports = app;

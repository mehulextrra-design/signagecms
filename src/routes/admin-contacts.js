/**
 * Admin Contacts Directory — shared WA broadcast pool
 * Admin imports/manages 1,00,000 contacts (location + industry tagged).
 * Advertisers select segments; algorithm reserves up to 10,000 per broadcast
 * with 7-day cooldown per contact (FOR UPDATE SKIP LOCKED prevents double-send).
 */

const express = require('express');
const https = require('https');
const http = require('http');
const { query, getClient } = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const multer = require('multer');
const csv = require('csv-parse/sync');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const CONTACT_LIMIT = 10000; // max per broadcast
const COOLDOWN_DAYS = 7;

// ── Ensure tables ────────────────────────────────────────────────────────────
let _ensured = false;
async function ensureTables() {
  if (_ensured) return;
  await query(`CREATE TABLE IF NOT EXISTS admin_contacts (
    id               BIGSERIAL PRIMARY KEY,
    name             VARCHAR(100),
    phone            VARCHAR(20) NOT NULL,
    city             VARCHAR(80),
    area             VARCHAR(80),
    industry         VARCHAR(80),
    business_type    VARCHAR(40),
    tags             TEXT[],
    is_active        BOOLEAN NOT NULL DEFAULT TRUE,
    is_dnd           BOOLEAN NOT NULL DEFAULT FALSE,
    last_messaged_at TIMESTAMPTZ,
    reserved_by      INTEGER,
    source           VARCHAR(40) DEFAULT 'csv',
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(phone)
  )`);
  // L2: place_id dedup — skip Place Details API for already-saved businesses
  await query(`ALTER TABLE admin_contacts ADD COLUMN IF NOT EXISTS google_place_id VARCHAR(200)`);
  await query(`ALTER TABLE admin_contacts ADD COLUMN IF NOT EXISTS email VARCHAR(200)`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS ac_place_id_idx ON admin_contacts(google_place_id) WHERE google_place_id IS NOT NULL`);
  await query(`CREATE INDEX IF NOT EXISTS ac_city_idx      ON admin_contacts(city)`);
  await query(`CREATE INDEX IF NOT EXISTS ac_industry_idx  ON admin_contacts(industry)`);
  await query(`CREATE INDEX IF NOT EXISTS ac_cooldown_idx  ON admin_contacts(last_messaged_at)`);
  await query(`CREATE TABLE IF NOT EXISTS admin_contact_segments (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(120) NOT NULL,
    description TEXT,
    city        VARCHAR(80),
    area        VARCHAR(80),
    industry    VARCHAR(80),
    created_by  UUID REFERENCES users(id),
    created_at  TIMESTAMPTZ DEFAULT NOW()
  )`);
  // L3: search job history — track every scrape run for transparency
  await query(`CREATE TABLE IF NOT EXISTS scrape_jobs (
    id               SERIAL PRIMARY KEY,
    lat              DECIMAL(10,7) NOT NULL,
    lng              DECIMAL(10,7) NOT NULL,
    radius           INTEGER NOT NULL,
    keyword          VARCHAR(100),
    status           VARCHAR(20) DEFAULT 'running',
    found            INTEGER DEFAULT 0,
    already_saved    INTEGER DEFAULT 0,
    new_fetched      INTEGER DEFAULT 0,
    skipped_no_phone INTEGER DEFAULT 0,
    saved            INTEGER DEFAULT 0,
    with_email       INTEGER DEFAULT 0,
    error            TEXT,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    completed_at     TIMESTAMPTZ
  )`);
  _ensured = true;
}

// ── Google Places helpers ────────────────────────────────────────────────────
function placesGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('JSON parse error')); } });
    });
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchNearbyPlaces(lat, lng, radius, keyword, apiKey) {
  const places = [];
  let url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${radius}&keyword=${encodeURIComponent(keyword)}&key=${apiKey}`;
  for (let page = 0; page < 3; page++) {
    if (page > 0) await sleep(2200); // Google requires a short delay between pages
    const data = await placesGet(url);
    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      throw new Error(`Places API: ${data.status}${data.error_message ? ' — ' + data.error_message : ''}`);
    }
    if (data.results) places.push(...data.results);
    if (!data.next_page_token) break;
    url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?pagetoken=${encodeURIComponent(data.next_page_token)}&key=${apiKey}`;
  }
  return places;
}

async function fetchPlaceDetails(placeId, apiKey) {
  const fields = 'name,formatted_phone_number,international_phone_number,formatted_address,address_components,website,types';
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=${encodeURIComponent(fields)}&key=${apiKey}`;
  const data = await placesGet(url);
  if (data.status !== 'OK') return null;
  return data.result;
}

function normalizePhone(raw) {
  if (!raw) return null;
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('91') && d.length === 12) d = d.slice(2);
  if (d.startsWith('0') && d.length === 11) d = d.slice(1);
  return d.length === 10 ? d : null;
}

function parseCityArea(components) {
  let city = '', area = '';
  if (!components) return { city, area };
  for (const c of components) {
    if (c.types.includes('locality')) city = c.long_name;
    if (c.types.includes('sublocality_level_1') || c.types.includes('sublocality')) area = c.long_name;
    if (!city && c.types.includes('administrative_area_level_2')) city = c.long_name;
  }
  return { city, area };
}

async function scrapeEmail(websiteUrl) {
  if (!websiteUrl) return null;
  return new Promise(resolve => {
    try {
      const urlObj = new URL(websiteUrl);
      const mod = urlObj.protocol === 'https:' ? https : http;
      let data = '';
      const req = mod.get(websiteUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        res.on('data', chunk => { data += chunk; if (data.length > 60000) req.destroy(); });
        res.on('end', () => {
          const m = data.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
          resolve(m && !m[0].includes('example') && !m[0].includes('wix') ? m[0] : null);
        });
      });
      req.setTimeout(5000, () => { req.destroy(); resolve(null); });
      req.on('error', () => resolve(null));
    } catch { resolve(null); }
  });
}

// Process array in parallel chunks of N
async function chunkAsync(arr, fn, size = 5) {
  const results = [];
  for (let i = 0; i < arr.length; i += size) {
    const batch = await Promise.all(arr.slice(i, i + size).map(fn));
    results.push(...batch);
  }
  return results;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function buildFilter(city, industry, area) {
  const conds = ['is_active=true', 'is_dnd=false'];
  const params = [];
  if (city)     { params.push(city);     conds.push(`city ILIKE $${params.length}`); }
  if (industry) { params.push(industry); conds.push(`industry ILIKE $${params.length}`); }
  if (area)     { params.push(area);     conds.push(`area ILIKE $${params.length}`); }
  return { conds, params };
}

// ── Admin: import CSV ────────────────────────────────────────────────────────
// POST /api/admin-contacts/import
router.post('/import', authenticate, requireAdmin, upload.single('file'), async (req, res, next) => {
  try {
    await ensureTables();
    if (!req.file) return res.status(400).json({ error: 'CSV file required' });
    const records = csv.parse(req.file.buffer.toString('utf8'), {
      columns: true, skip_empty_lines: true, trim: true
    });
    let inserted = 0, skipped = 0;
    for (const r of records) {
      const phone = (r.phone || r.mobile || r.number || '').replace(/\D/g, '').slice(-10);
      if (phone.length !== 10) { skipped++; continue; }
      try {
        await query(
          `INSERT INTO admin_contacts (name, phone, city, area, industry, business_type, tags, source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'csv')
           ON CONFLICT (phone) DO UPDATE SET
             name=EXCLUDED.name, city=COALESCE(EXCLUDED.city,admin_contacts.city),
             area=COALESCE(EXCLUDED.area,admin_contacts.area),
             industry=COALESCE(EXCLUDED.industry,admin_contacts.industry),
             is_active=true`,
          [r.name||r.Name||null, phone, r.city||r.City||null,
           r.area||r.Area||r.locality||null, r.industry||r.Industry||r.category||null,
           r.business_type||r.type||null,
           r.tags ? r.tags.split(',').map(t=>t.trim()) : null]
        );
        inserted++;
      } catch { skipped++; }
    }
    res.json({ inserted, skipped, total: records.length });
  } catch (err) { next(err); }
});

// GET /api/admin-contacts — paginated list with filters (admin only)
router.get('/', authenticate, requireAdmin, async (req, res, next) => {
  try {
    await ensureTables();
    const { city, industry, area, search, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;
    const { conds, params } = buildFilter(city, industry, area);
    if (search) { params.push(`%${search}%`); conds.push(`(name ILIKE $${params.length} OR phone LIKE $${params.length})`); }
    const where = `WHERE ${conds.join(' AND ')}`;
    const [rows, cnt] = await Promise.all([
      query(`SELECT id,name,phone,city,area,industry,business_type,tags,is_dnd,last_messaged_at,source,created_at
             FROM admin_contacts ${where} ORDER BY created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,
        [...params, limit, offset]),
      query(`SELECT COUNT(*) FROM admin_contacts ${where}`, params)
    ]);
    res.json({ contacts: rows.rows, total: parseInt(cnt.rows[0].count) });
  } catch (err) { next(err); }
});

// GET /api/admin-contacts/meta — distinct cities + industries for filter dropdowns
router.get('/meta', authenticate, async (req, res, next) => {
  try {
    await ensureTables();
    const [cities, industries] = await Promise.all([
      query(`SELECT DISTINCT city FROM admin_contacts WHERE city IS NOT NULL AND is_active=true ORDER BY city`),
      query(`SELECT DISTINCT industry FROM admin_contacts WHERE industry IS NOT NULL AND is_active=true ORDER BY industry`)
    ]);
    res.json({ cities: cities.rows.map(r=>r.city), industries: industries.rows.map(r=>r.industry) });
  } catch (err) { next(err); }
});

// GET /api/admin-contacts/available — available count for given filters (user-facing)
router.get('/available', authenticate, async (req, res, next) => {
  try {
    await ensureTables();
    const { city, industry, area } = req.query;
    const { conds, params } = buildFilter(city, industry, area);
    conds.push('reserved_by IS NULL');
    conds.push(`(last_messaged_at IS NULL OR last_messaged_at < NOW() - INTERVAL '${COOLDOWN_DAYS} days')`);
    const r = await query(
      `SELECT COUNT(*) FROM admin_contacts WHERE ${conds.join(' AND ')}`, params
    );
    const available = Math.min(parseInt(r.rows[0].count), CONTACT_LIMIT);
    res.json({ available, limit: CONTACT_LIMIT, cooldown_days: COOLDOWN_DAYS });
  } catch (err) { next(err); }
});

// ── Segments ─────────────────────────────────────────────────────────────────
// GET /api/admin-contacts/segments
router.get('/segments', authenticate, async (req, res, next) => {
  try {
    await ensureTables();
    const rows = await query(
      `SELECT s.*, COUNT(ac.id) FILTER (
         WHERE ac.is_active=true AND ac.is_dnd=false AND ac.reserved_by IS NULL
           AND (ac.last_messaged_at IS NULL OR ac.last_messaged_at < NOW() - INTERVAL '${COOLDOWN_DAYS} days')
       ) AS available_now
       FROM admin_contact_segments s
       LEFT JOIN admin_contacts ac ON
         (s.city IS NULL OR ac.city ILIKE s.city)
         AND (s.industry IS NULL OR ac.industry ILIKE s.industry)
         AND (s.area IS NULL OR ac.area ILIKE s.area)
       GROUP BY s.id ORDER BY s.name`
    );
    res.json(rows.rows);
  } catch (err) { next(err); }
});

// POST /api/admin-contacts/segments (admin only)
router.post('/segments', authenticate, requireAdmin, async (req, res, next) => {
  try {
    await ensureTables();
    const { name, description, city, industry, area } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const r = await query(
      `INSERT INTO admin_contact_segments (name, description, city, industry, area, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [name, description||null, city||null, industry||null, area||null, req.user.id]
    );
    res.json(r.rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/admin-contacts/segments/:id (admin only)
router.delete('/segments/:id', authenticate, requireAdmin, async (req, res, next) => {
  try {
    await query(`DELETE FROM admin_contact_segments WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// PATCH /api/admin-contacts/:id/dnd — toggle DND for a contact (admin only)
router.patch('/:id/dnd', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const r = await query(
      `UPDATE admin_contacts SET is_dnd=NOT is_dnd WHERE id=$1 RETURNING id,phone,is_dnd`, [req.params.id]
    );
    res.json(r.rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/admin-contacts/:id (admin only)
router.delete('/:id', authenticate, requireAdmin, async (req, res, next) => {
  try {
    await query(`DELETE FROM admin_contacts WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Google Places scraper (L2 place_id dedup + L3 job history) ───────────────
// POST /api/admin-contacts/scrape-places — fires async, returns job_id immediately
router.post('/scrape-places', authenticate, requireAdmin, async (req, res, next) => {
  try {
    await ensureTables();
    const { lat, lng, radius, keyword } = req.body;
    if (!lat || !lng || !radius || !keyword) {
      return res.status(400).json({ error: 'lat, lng, radius, keyword required' });
    }
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'GOOGLE_MAPS_API_KEY not set in env' });

    const jobRes = await query(
      `INSERT INTO scrape_jobs (lat, lng, radius, keyword, status) VALUES ($1,$2,$3,$4,'running') RETURNING id`,
      [parseFloat(lat), parseFloat(lng), parseInt(radius), keyword.trim()]
    );
    const jobId = jobRes.rows[0].id;

    // Return immediately — process in background
    res.json({ job_id: jobId, status: 'running' });

    // Background processing (not awaited)
    setImmediate(async () => {
      try {
        const nearbyPlaces = await fetchNearbyPlaces(parseFloat(lat), parseFloat(lng), parseInt(radius), keyword.trim(), apiKey);
        const found = nearbyPlaces.length;

        if (!found) {
          await query(`UPDATE scrape_jobs SET status='completed',found=0,completed_at=NOW() WHERE id=$1`, [jobId]);
          return;
        }

        const allPlaceIds = nearbyPlaces.map(p => p.place_id).filter(Boolean);
        const existingRes = await query(
          `SELECT google_place_id FROM admin_contacts WHERE google_place_id = ANY($1)`, [allPlaceIds]
        );
        const existingSet = new Set(existingRes.rows.map(r => r.google_place_id));
        const newPlaces = nearbyPlaces.filter(p => p.place_id && !existingSet.has(p.place_id));
        const alreadySaved = found - newPlaces.length;

        let saved = 0, skippedNoPhone = 0, withEmail = 0;

        await chunkAsync(newPlaces, async (place) => {
          try {
            const details = await fetchPlaceDetails(place.place_id, apiKey);
            if (!details) return;
            const phone = normalizePhone(details.formatted_phone_number || details.international_phone_number);
            if (!phone) { skippedNoPhone++; return; }
            const { city, area } = parseCityArea(details.address_components);
            const bizType = (details.types || []).find(t => !['point_of_interest','establishment','food'].includes(t)) || null;
            const email = await scrapeEmail(details.website);
            if (email) withEmail++;
            const r = await query(
              `INSERT INTO admin_contacts (name,phone,city,area,industry,business_type,google_place_id,email,source)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'google_places')
               ON CONFLICT (phone) DO UPDATE SET
                 google_place_id = COALESCE(EXCLUDED.google_place_id, admin_contacts.google_place_id),
                 email            = COALESCE(EXCLUDED.email, admin_contacts.email),
                 is_active        = true`,
              [details.name || place.name, phone, city||null, area||null,
               keyword.trim(), bizType, place.place_id, email||null]
            );
            if (r.rowCount) saved++;
          } catch { /* skip individual failures silently */ }
        }, 5);

        await query(
          `UPDATE scrape_jobs SET status='completed',found=$1,already_saved=$2,new_fetched=$3,
           skipped_no_phone=$4,saved=$5,with_email=$6,completed_at=NOW() WHERE id=$7`,
          [found, alreadySaved, newPlaces.length, skippedNoPhone, saved, withEmail, jobId]
        );
      } catch (err) {
        await query(`UPDATE scrape_jobs SET status='failed',error=$1,completed_at=NOW() WHERE id=$2`, [err.message, jobId]).catch(() => {});
      }
    });
  } catch (err) { next(err); }
});

// GET /api/admin-contacts/scrape-jobs/:id — poll single job status
router.get('/scrape-jobs/:id', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const r = await query(`SELECT * FROM scrape_jobs WHERE id=$1`, [parseInt(req.params.id)]);
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    res.json(r.rows[0]);
  } catch (err) { next(err); }
});

// GET /api/admin-contacts/scrape-jobs — search history (L3)
router.get('/scrape-jobs', authenticate, requireAdmin, async (req, res, next) => {
  try {
    await ensureTables();
    const r = await query(`SELECT * FROM scrape_jobs ORDER BY created_at DESC LIMIT 100`);
    res.json(r.rows);
  } catch (err) { next(err); }
});

// ── Reserve / Release (called by broadcast service) ──────────────────────────
/**
 * Reserve up to CONTACT_LIMIT contacts for a broadcast.
 * Uses FOR UPDATE SKIP LOCKED to prevent concurrent broadcasts grabbing same contacts.
 * Returns array of {phone, name}.
 */
async function reserveContactsForBroadcast(broadcastId, { city, industry, area } = {}) {
  await ensureTables();
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { conds, params } = buildFilter(city, industry, area);
    conds.push('reserved_by IS NULL');
    conds.push(`(last_messaged_at IS NULL OR last_messaged_at < NOW() - INTERVAL '${COOLDOWN_DAYS} days')`);
    params.push(CONTACT_LIMIT);

    const selected = await client.query(
      `SELECT id, phone, name FROM admin_contacts
       WHERE ${conds.join(' AND ')}
       ORDER BY last_messaged_at ASC NULLS FIRST
       LIMIT $${params.length}
       FOR UPDATE SKIP LOCKED`,
      params
    );
    if (selected.rows.length) {
      const ids = selected.rows.map(r => r.id);
      await client.query(
        `UPDATE admin_contacts SET reserved_by=$1 WHERE id = ANY($2)`,
        [broadcastId, ids]
      );
    }
    await client.query('COMMIT');
    return selected.rows;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Mark reserved contacts as sent and release reservation.
 * Call after broadcast completes (success or failure).
 */
async function releaseContacts(broadcastId, markSent = true) {
  await ensureTables();
  if (markSent) {
    await query(
      `UPDATE admin_contacts SET last_messaged_at=NOW(), reserved_by=NULL WHERE reserved_by=$1`,
      [broadcastId]
    );
  } else {
    await query(
      `UPDATE admin_contacts SET reserved_by=NULL WHERE reserved_by=$1`,
      [broadcastId]
    );
  }
}

module.exports = router;
module.exports.reserveContactsForBroadcast = reserveContactsForBroadcast;
module.exports.releaseContacts = releaseContacts;

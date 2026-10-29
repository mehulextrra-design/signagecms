const express = require('express');
const https   = require('https');
const { query } = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT      = process.env.GOOGLE_REDIRECT_URI || 'https://signagecrm-production.up.railway.app/api/auth/google/callback';

// ── helpers ────────────────────────────────────────────────────────────────────

function googleGet(url, accessToken) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    https.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: { Authorization: `Bearer ${accessToken}`, 'Accept-Encoding': 'identity' }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(new Error(data.slice(0,200))); }});
    }).on('error', reject);
  });
}

function googlePost(url, accessToken, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Accept-Encoding': 'identity'
      }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(new Error(data.slice(0,200))); }});
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function exchangeCode(code) {
  const body = new URLSearchParams({
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT,
    grant_type: 'authorization_code'
  }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), 'Accept-Encoding': 'identity' }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(new Error(data.slice(0,200))); }});
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'refresh_token'
  }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), 'Accept-Encoding': 'identity' }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(new Error(data.slice(0,200))); }});
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── OAuth routes ───────────────────────────────────────────────────────────────

// GET /api/auth/google/connect — returns OAuth URL
router.get('/connect', authenticate, (req, res) => {
  if (!CLIENT_ID) return res.status(500).json({ error: 'Google OAuth not configured' });
  const state = Buffer.from(JSON.stringify({ userId: req.user.id })).toString('base64');
  const scope  = 'https://www.googleapis.com/auth/business.manage';
  const url = `https://accounts.google.com/o/oauth2/v2/auth` +
    `?client_id=${CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(scope)}` +
    `&access_type=offline` +
    `&prompt=consent` +
    `&state=${encodeURIComponent(state)}`;
  res.json({ url });
});

// GET /api/auth/google/callback — OAuth callback
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect('/?gbp_error=' + encodeURIComponent(error));

  try {
    const { userId } = JSON.parse(Buffer.from(decodeURIComponent(state), 'base64').toString());

    // Exchange code for tokens
    const tokens = await exchangeCode(code);
    if (tokens.error) throw new Error(tokens.error_description || tokens.error);

    const accessToken  = tokens.access_token;
    const refreshToken = tokens.refresh_token;

    // Get Google Business accounts
    const accounts = await googleGet('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', accessToken);
    if (!accounts.accounts || !accounts.accounts.length) {
      return res.redirect('/?gbp_error=no_business_account');
    }

    // Use first account
    const account = accounts.accounts[0];
    const accountName = account.name; // e.g. "accounts/123456789"

    // Get first location for this account
    let locationId = null, businessName = account.accountName || 'Google Business';
    try {
      const locations = await googleGet(
        `https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations?readMask=name,title`,
        accessToken
      );
      if (locations.locations && locations.locations.length) {
        const loc = locations.locations[0];
        locationId   = loc.name; // e.g. "locations/987654321"
        businessName = loc.title || businessName;
      }
    } catch (_) {}

    await query(
      `UPDATE users SET
        google_account_id=$1, google_location_id=$2, google_business_name=$3,
        google_access_token=$4, google_refresh_token=$5, google_connected_at=NOW()
       WHERE id=$6`,
      [accountName, locationId, businessName, accessToken, refreshToken, userId]
    );

    res.redirect('/?gbp_connected=1');
  } catch (err) {
    console.error('[Google OAuth]', err.message);
    res.redirect('/?gbp_error=' + encodeURIComponent(err.message));
  }
});

// POST /api/auth/google/disconnect
router.post('/disconnect', authenticate, async (req, res) => {
  await query(
    `UPDATE users SET google_account_id=NULL, google_location_id=NULL, google_business_name=NULL,
      google_access_token=NULL, google_refresh_token=NULL, google_connected_at=NULL WHERE id=$1`,
    [req.user.id]
  );
  res.json({ success: true });
});

// GET /api/auth/google/status
router.get('/status', authenticate, async (req, res) => {
  const result = await query(
    'SELECT google_account_id, google_location_id, google_business_name, google_connected_at FROM users WHERE id=$1',
    [req.user.id]
  );
  const u = result.rows[0] || {};
  res.json({
    connected:     !!u.google_account_id,
    account_id:    u.google_account_id   || null,
    location_id:   u.google_location_id  || null,
    business_name: u.google_business_name || null,
    connected_at:  u.google_connected_at  || null,
  });
});

// ── Posting ────────────────────────────────────────────────────────────────────

async function postCampaignToGoogle(campaignId) {
  const result = await query(
    `SELECT c.id, c.title, c.campaign_code, c.start_date, c.end_date,
            u.google_account_id, u.google_location_id,
            u.google_access_token, u.google_refresh_token,
            ct.file_url, ct.type AS content_type
     FROM campaigns c
     JOIN users u ON u.id = c.user_id
     LEFT JOIN content ct ON ct.id = c.content_id
     WHERE c.id = $1`,
    [campaignId]
  );
  const row = result.rows[0];
  if (!row || !row.google_location_id || !row.google_refresh_token) return;
  if (!row.file_url || row.content_type !== 'image') {
    console.log(`[GBP] Campaign ${row.campaign_code} — only images supported for GBP posts, skipping`);
    return;
  }

  try {
    // Refresh the access token (they expire in 1 hour)
    const refreshed = await refreshAccessToken(row.google_refresh_token);
    if (refreshed.error) throw new Error(refreshed.error_description || refreshed.error);
    const accessToken = refreshed.access_token;

    // Save refreshed token to DB
    await query('UPDATE users SET google_access_token=$1 WHERE google_account_id=$2', [accessToken, row.google_account_id]);

    // Derive account name from location (e.g. "accounts/123/locations/456" → "accounts/123")
    const accountName = row.google_account_id;
    const locationName = row.google_location_id; // full resource name like "accounts/123/locations/456"
    // If locationId is bare (e.g. "locations/456"), combine with account
    const fullLocation = locationName.startsWith('accounts/') ? locationName : `${accountName}/${locationName}`;

    const postBody = {
      topicType: 'STANDARD',
      summary: `${row.title || 'Campaign update'} — extrravenue digital screen campaign now live!`,
      media: [{ mediaFormat: 'PHOTO', sourceUrl: row.file_url }],
      callToAction: {
        actionType: 'LEARN_MORE',
        url: 'https://signagecrm-production.up.railway.app'
      }
    };

    const response = await googlePost(
      `https://mybusiness.googleapis.com/v4/${fullLocation}/localPosts`,
      accessToken,
      postBody
    );

    if (response.error) throw new Error(response.error.message || JSON.stringify(response.error));
    console.log(`[GBP] Posted to Google Business Profile for campaign ${row.campaign_code}: ${response.name}`);
  } catch (err) {
    console.error(`[GBP] Post failed for campaign ${row.campaign_code}:`, err.message);
  }
}

module.exports = router;
module.exports.postCampaignToGoogle = postCampaignToGoogle;

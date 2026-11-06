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
  if (error) return res.send(`<html><body><script>if(window.opener)window.opener.postMessage("gbp_error:${encodeURIComponent(error)}","*");window.close();</script><p>Error. You can close this window.</p></body></html>`);

  try {
    const { userId } = JSON.parse(Buffer.from(decodeURIComponent(state), 'base64').toString());

    // Exchange code for tokens
    const tokens = await exchangeCode(code);
    if (tokens.error) throw new Error(tokens.error_description || tokens.error);

    const accessToken  = tokens.access_token;
    const refreshToken = tokens.refresh_token;

    // Try to get Google Business accounts (may fail if API quota not yet approved)
    let accountName = 'pending', locationId = null, businessName = 'Google Business (pending)';
    try {
      const accounts = await googleGet('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', accessToken);
      console.log('[Google OAuth] accounts response:', JSON.stringify(accounts).slice(0, 500));
      if (!accounts.error && accounts.accounts && accounts.accounts.length) {
        const account = accounts.accounts[0];
        accountName  = account.name;
        businessName = account.accountName || 'Google Business';

        // Get first location for this account
        try {
          const locations = await googleGet(
            `https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations?readMask=name,title`,
            accessToken
          );
          if (locations.locations && locations.locations.length) {
            const loc = locations.locations[0];
            locationId   = loc.name;
            businessName = loc.title || businessName;
          }
        } catch (_) {}
      } else if (accounts.error) {
        console.warn('[Google OAuth] accounts API error (quota?):', accounts.error.message || accounts.error.status);
      }
    } catch (apiErr) {
      console.warn('[Google OAuth] accounts fetch failed (quota?):', apiErr.message);
    }

    // Always save tokens — even if account fetch failed, tokens are valid
    await query(
      `UPDATE users SET
        google_account_id=$1, google_location_id=$2, google_business_name=$3,
        google_access_token=$4, google_refresh_token=$5, google_connected_at=NOW()
       WHERE id=$6`,
      [accountName, locationId, businessName, accessToken, refreshToken, userId]
    );

    res.send('<html><body><script>if(window.opener)window.opener.postMessage("gbp_connected","*");window.close();</script><p>Connected! You can close this window.</p></body></html>');
  } catch (err) {
    console.error('[Google OAuth]', err.message);
    res.send(`<html><body><script>if(window.opener)window.opener.postMessage("gbp_error:${encodeURIComponent(err.message)}","*");window.close();</script><p>Error. You can close this window.</p></body></html>`);
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

// POST /api/auth/google/retry-fetch — retry fetching account/location using saved tokens
router.post('/retry-fetch', authenticate, async (req, res) => {
  try {
    const result = await query(
      'SELECT google_access_token, google_refresh_token, google_account_id FROM users WHERE id=$1',
      [req.user.id]
    );
    const u = result.rows[0];
    if (!u || !u.google_refresh_token) return res.status(400).json({ error: 'Not connected' });

    // Refresh access token
    const refreshed = await refreshAccessToken(u.google_refresh_token);
    if (refreshed.error) return res.status(400).json({ error: refreshed.error_description || 'Token refresh failed' });
    const accessToken = refreshed.access_token;

    // Fetch accounts
    const accounts = await googleGet('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', accessToken);
    if (accounts.error) return res.status(400).json({ error: accounts.error.message || 'API quota not yet available' });
    if (!accounts.accounts || !accounts.accounts.length) return res.status(400).json({ error: 'No business account found' });

    const account = accounts.accounts[0];
    const accountName = account.name;
    let locationId = null, businessName = account.accountName || 'Google Business';

    try {
      const locations = await googleGet(
        `https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations?readMask=name,title`,
        accessToken
      );
      if (locations.locations && locations.locations.length) {
        locationId   = locations.locations[0].name;
        businessName = locations.locations[0].title || businessName;
      }
    } catch (_) {}

    await query(
      `UPDATE users SET google_account_id=$1, google_location_id=$2, google_business_name=$3,
       google_access_token=$4 WHERE id=$5`,
      [accountName, locationId, businessName, accessToken, req.user.id]
    );

    res.json({ success: true, business_name: businessName, location_id: locationId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
        url: 'https://www.extrravenue.com'
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

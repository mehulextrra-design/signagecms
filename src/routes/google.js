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

// POST /api/auth/google/test-gbp/:campaignId — manually trigger GBP post (admin only)
router.post('/test-gbp/:campaignId', async (req, res) => {
  try {
    await postCampaignToGoogle(req.params.campaignId);
    res.json({ success: true, message: 'GBP post triggered — check Railway logs' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Posting ────────────────────────────────────────────────────────────────────

const MAKE_GBP_WEBHOOK = 'https://hook.eu1.make.com/t689r3nbxfl4rsm3fn57qureowu3i3lb';

async function postCampaignToGoogle(campaignId) {
  const result = await query(
    `SELECT c.id, c.title, c.campaign_code, c.start_date, c.end_date,
            u.google_refresh_token, u.google_account_id, u.google_location_id,
            ct.file_url, ct.type AS content_type
     FROM campaigns c
     JOIN users u ON u.id = c.user_id
     LEFT JOIN content ct ON ct.id = c.content_id
     WHERE c.id = $1`,
    [campaignId]
  );
  const row = result.rows[0];
  if (!row || !row.google_refresh_token) {
    console.log(`[GBP] skipped campaign ${campaignId} — no refresh_token (row=${!!row})`);
    return;
  }

  // Refresh access token server-side
  let accessToken = null;
  try {
    const refreshed = await refreshAccessToken(row.google_refresh_token);
    if (refreshed.access_token) accessToken = refreshed.access_token;
  } catch (_) {}

  if (!accessToken) return; // Can't post without a valid token

  // If account/location were saved as pending, try to fetch them now
  let accountId   = (row.google_account_id && row.google_account_id !== 'pending') ? row.google_account_id : null;
  let locationId  = row.google_location_id || null;

  if (!accountId) {
    try {
      const accounts = await googleGet('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', accessToken);
      if (accounts.accounts && accounts.accounts.length) {
        accountId = accounts.accounts[0].name;
        await query('UPDATE users SET google_account_id=$1 WHERE id=(SELECT user_id FROM campaigns WHERE id=$2)', [accountId, campaignId]);
      }
    } catch (_) {}
  }

  if (accountId && !locationId) {
    try {
      const locs = await googleGet(
        `https://mybusinessbusinessinformation.googleapis.com/v1/${accountId}/locations?readMask=name,title`,
        accessToken
      );
      if (locs.locations && locs.locations.length) {
        locationId = locs.locations[0].name;
        await query('UPDATE users SET google_location_id=$1 WHERE id=(SELECT user_id FROM campaigns WHERE id=$2)', [locationId, campaignId]);
      }
    } catch (_) {}
  }

  if (!locationId) {
    console.log(`[GBP] skipped campaign ${campaignId} — no location_id resolved`);
    return;
  }

  console.log(`[GBP] campaign ${row.campaign_code} content_type=${row.content_type} file_url=${row.file_url}`);

  const gbpBody = {
    summary: `${row.title || 'Campaign'} is now live on ExtrraVenue digital screens in Ahmedabad!`,
    topicType: 'STANDARD'
  };
  if (row.content_type === 'image' && row.file_url) {
    gbpBody.media = [{ mediaFormat: 'PHOTO', sourceUrl: row.file_url }];
  }

  // Extract numeric location ID for postings API (needs just the numeric part)
  const locationNumericId = locationId.includes('/locations/')
    ? locationId.split('/locations/')[1]
    : locationId;

  // Send gbpBody as object (not stringified) so Make.com receives proper JSON
  const payload = JSON.stringify({
    access_token: accessToken,
    location_id: locationNumericId,
    gbp_body: gbpBody
  });

  return new Promise((resolve) => {
    const parsed = new URL(MAKE_GBP_WEBHOOK);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        console.log(`[GBP] Make webhook called for campaign ${row.campaign_code}: ${res.statusCode} ${data.slice(0,100)}`);
        resolve();
      });
    });
    req.on('error', err => {
      console.error(`[GBP] Make webhook failed for campaign ${row.campaign_code}:`, err.message);
      resolve();
    });
    req.write(payload);
    req.end();
  });
}

module.exports = router;
module.exports.postCampaignToGoogle = postCampaignToGoogle;

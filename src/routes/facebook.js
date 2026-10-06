const express = require('express');
const https = require('https');
const { query } = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

const APP_ID     = process.env.FB_APP_ID;
const APP_SECRET = process.env.FB_APP_SECRET;
const REDIRECT   = process.env.FB_REDIRECT_URI || 'https://signagecrm-production.up.railway.app/api/auth/facebook/callback';

function fbGet(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'graph.facebook.com',
      path: `/v21.0${path}`,
      headers: { 'Accept-Encoding': 'identity' }
    };
    https.get(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`FB parse error: ${data.slice(0,200)}`)); }
      });
    }).on('error', reject);
  });
}

// GET /api/auth/facebook/connect — returns OAuth URL for frontend
router.get('/connect', authenticate, (req, res) => {
  const state = Buffer.from(JSON.stringify({ userId: req.user.id })).toString('base64');
  const scope = 'pages_show_list,pages_manage_posts,instagram_basic,instagram_content_publish';
  const url = `https://www.facebook.com/v21.0/dialog/oauth?client_id=${APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=${scope}&state=${encodeURIComponent(state)}&response_type=code`;
  res.json({ url });
});

// GET /api/auth/facebook/callback — OAuth callback from Facebook
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect('/?fb_error=' + encodeURIComponent(error));

  try {
    const { userId } = JSON.parse(Buffer.from(decodeURIComponent(state), 'base64').toString());

    // Exchange code for short-lived token
    const tokenData = await fbGet(
      `/oauth/access_token?client_id=${APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT)}&client_secret=${APP_SECRET}&code=${code}`
    );
    if (tokenData.error) throw new Error(tokenData.error.message);
    const shortToken = tokenData.access_token;

    // Exchange for long-lived token (60 days)
    const longData = await fbGet(
      `/oauth/access_token?grant_type=fb_exchange_token&client_id=${APP_ID}&client_secret=${APP_SECRET}&fb_exchange_token=${shortToken}`
    );
    const userToken = longData.access_token;

    // Get user's pages
    const pagesData = await fbGet(`/me/accounts?access_token=${userToken}&fields=id,name,access_token`);
    if (!pagesData.data || !pagesData.data.length) {
      return res.redirect('/?fb_error=no_pages');
    }

    // Use first page (user can select later)
    const page = pagesData.data[0];
    const pageToken = page.access_token; // page tokens don't expire

    // Try to get linked Instagram Business account
    let igUserId = null, igUsername = null;
    try {
      const igData = await fbGet(`/${page.id}?fields=instagram_business_account&access_token=${pageToken}`);
      if (igData.instagram_business_account) {
        igUserId = igData.instagram_business_account.id;
        const igInfo = await fbGet(`/${igUserId}?fields=username&access_token=${pageToken}`);
        igUsername = igInfo.username || null;
      }
    } catch (_) {}

    await query(
      `UPDATE users SET
        fb_page_id=$1, fb_page_name=$2, fb_page_access_token=$3,
        ig_user_id=$4, ig_username=$5, fb_connected_at=NOW()
       WHERE id=$6`,
      [page.id, page.name, pageToken, igUserId, igUsername, userId]
    );

    res.redirect('/?fb_connected=1');
  } catch (err) {
    console.error('[FB OAuth]', err.message);
    res.redirect('/?fb_error=' + encodeURIComponent(err.message));
  }
});

// POST /api/auth/facebook/disconnect
router.post('/disconnect', authenticate, async (req, res) => {
  await query(
    `UPDATE users SET fb_page_id=NULL, fb_page_name=NULL, fb_page_access_token=NULL,
      ig_user_id=NULL, ig_username=NULL, fb_connected_at=NULL WHERE id=$1`,
    [req.user.id]
  );
  res.json({ success: true });
});

// GET /api/auth/facebook/status — check connection status
router.get('/status', authenticate, async (req, res) => {
  const result = await query(
    'SELECT fb_page_id, fb_page_name, ig_user_id, ig_username, fb_connected_at FROM users WHERE id=$1',
    [req.user.id]
  );
  const u = result.rows[0] || {};
  res.json({
    connected: !!u.fb_page_id,
    page_id:   u.fb_page_id   || null,
    page_name: u.fb_page_name || null,
    ig_user_id:  u.ig_user_id  || null,
    ig_username: u.ig_username || null,
    connected_at: u.fb_connected_at || null,
  });
});

// ── Social posting ────────────────────────────────────────────────────────────

function fbApiPost(path, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'graph.facebook.com',
      path: `/v21.0${path}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(data.slice(0, 200))); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function postCampaignToSocial(campaignId) {
  const result = await query(
    `SELECT c.id, c.title, c.campaign_code, c.start_date, c.end_date,
            u.fb_page_id, u.fb_page_name, u.fb_page_access_token, u.ig_user_id,
            ct.file_url, ct.type AS content_type
     FROM campaigns c
     JOIN users u ON u.id = c.user_id
     LEFT JOIN content ct ON ct.id = c.content_id
     WHERE c.id = $1`,
    [campaignId]
  );
  const row = result.rows[0];
  if (!row || !row.fb_page_id || !row.fb_page_access_token) return;

  try {
    let fbRes;
    if (row.file_url && row.content_type === 'image') {
      fbRes = await fbApiPost(`/${row.fb_page_id}/photos`, {
        url: row.file_url,
        access_token: row.fb_page_access_token
      });
    } else if (row.file_url && row.content_type === 'video') {
      // Video post — just log, video upload needs multipart not JSON
      console.log(`[Social] Video campaign ${row.campaign_code} — video upload not supported yet`);
      return;
    } else {
      console.log(`[Social] No media for campaign ${row.campaign_code} — skipping FB post`);
      return;
    }
    if (fbRes.error) throw new Error(fbRes.error.message);
    console.log(`[Social] Posted to FB page for campaign ${row.campaign_code}: post_id=${fbRes.id}`);
  } catch (err) {
    console.error(`[Social] FB post failed for campaign ${row.campaign_code}:`, err.message);
  }

  // Instagram with image
  if (row.ig_user_id && row.file_url && row.content_type === 'image') {
    try {
      const container = await fbApiPost(`/${row.ig_user_id}/media`, {
        image_url: row.file_url,
        access_token: row.fb_page_access_token
      });
      if (container.error) throw new Error(container.error.message);
      const publish = await fbApiPost(`/${row.ig_user_id}/media_publish`, {
        creation_id: container.id,
        access_token: row.fb_page_access_token
      });
      if (publish.error) throw new Error(publish.error.message);
      console.log(`[Social] Posted to Instagram for campaign ${row.campaign_code}: media_id=${publish.id}`);
    } catch (err) {
      console.error(`[Social] IG post failed for campaign ${row.campaign_code}:`, err.message);
    }
  }
}

module.exports = router;
module.exports.postCampaignToSocial = postCampaignToSocial;

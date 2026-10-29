const express = require('express');
const https   = require('https');
const { query } = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

const APP_ID     = process.env.FB_APP_ID;
const APP_SECRET = process.env.FB_APP_SECRET;
const REDIRECT   = process.env.IG_REDIRECT_URI || 'https://signagecrm-production.up.railway.app/api/auth/instagram/callback';

function fbGet(path) {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: 'graph.facebook.com',
      path: `/v21.0${path}`,
      headers: { 'Accept-Encoding': 'identity' }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(new Error(data.slice(0,200))); }});
    }).on('error', reject);
  });
}

// GET /api/auth/instagram/connect — returns Facebook OAuth URL scoped for Instagram
router.get('/connect', authenticate, (req, res) => {
  if (!APP_ID) return res.status(500).json({ error: 'Instagram OAuth not configured (FB_APP_ID missing)' });
  const state = Buffer.from(JSON.stringify({ userId: req.user.id })).toString('base64');
  const scope = 'instagram_basic,instagram_content_publish,pages_show_list';
  const url = `https://www.facebook.com/v21.0/dialog/oauth?client_id=${APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=${scope}&state=${encodeURIComponent(state)}&response_type=code`;
  res.json({ url });
});

// GET /api/auth/instagram/callback
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect('/?ig_error=' + encodeURIComponent(error));

  try {
    const { userId } = JSON.parse(Buffer.from(decodeURIComponent(state), 'base64').toString());

    // Exchange code for short-lived token
    const tokenData = await fbGet(`/oauth/access_token?client_id=${APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT)}&client_secret=${APP_SECRET}&code=${code}`);
    if (tokenData.error) throw new Error(tokenData.error.message);

    // Exchange for long-lived user token (60 days)
    const longData = await fbGet(`/oauth/access_token?grant_type=fb_exchange_token&client_id=${APP_ID}&client_secret=${APP_SECRET}&fb_exchange_token=${tokenData.access_token}`);
    const userToken = longData.access_token;

    let igUserId = null, igUsername = null;

    // Path 1: look through managed pages for an IG Business account
    try {
      const pagesData = await fbGet(`/me/accounts?access_token=${userToken}&fields=id,access_token`);
      if (pagesData.data && pagesData.data.length) {
        for (const page of pagesData.data) {
          const igData = await fbGet(`/${page.id}?fields=instagram_business_account&access_token=${page.access_token}`);
          if (igData.instagram_business_account) {
            igUserId = igData.instagram_business_account.id;
            const info = await fbGet(`/${igUserId}?fields=username&access_token=${page.access_token}`);
            igUsername = info.username || null;
            break;
          }
        }
      }
    } catch (_) {}

    // Path 2: IG linked directly to personal Facebook (no managed page required)
    if (!igUserId) {
      try {
        const direct = await fbGet(`/me?fields=instagram_business_account&access_token=${userToken}`);
        if (direct.instagram_business_account) {
          igUserId = direct.instagram_business_account.id;
          const info = await fbGet(`/${igUserId}?fields=username&access_token=${userToken}`);
          igUsername = info.username || null;
        }
      } catch (_) {}
    }

    if (!igUserId) return res.redirect('/?ig_error=no_instagram_business_account');

    await query(
      `UPDATE users SET ig_direct_user_id=$1, ig_direct_username=$2, ig_access_token=$3, ig_connected_at=NOW() WHERE id=$4`,
      [igUserId, igUsername, userToken, userId]
    );

    res.redirect('/?ig_connected=1');
  } catch (err) {
    console.error('[IG OAuth]', err.message);
    res.redirect('/?ig_error=' + encodeURIComponent(err.message));
  }
});

// POST /api/auth/instagram/disconnect
router.post('/disconnect', authenticate, async (req, res) => {
  await query(
    `UPDATE users SET ig_direct_user_id=NULL, ig_direct_username=NULL, ig_access_token=NULL, ig_connected_at=NULL WHERE id=$1`,
    [req.user.id]
  );
  res.json({ success: true });
});

// GET /api/auth/instagram/status
router.get('/status', authenticate, async (req, res) => {
  const result = await query(
    'SELECT ig_direct_user_id, ig_direct_username, ig_connected_at, ig_user_id, ig_username, fb_page_id FROM users WHERE id=$1',
    [req.user.id]
  );
  const u = result.rows[0] || {};
  const viaFb     = !!u.fb_page_id && !!u.ig_user_id;
  const direct    = !!u.ig_direct_user_id;
  const username  = u.ig_direct_username || u.ig_username || null;
  res.json({
    connected:    viaFb || direct,
    via_facebook: viaFb,
    direct,
    ig_username:  username,
    connected_at: u.ig_connected_at || null,
  });
});

module.exports = router;

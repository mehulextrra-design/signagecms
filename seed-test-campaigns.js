/**
 * Test Campaign Seeder
 * Creates 4 test users + campaigns on the same screen for testing
 * Run: node seed-test-campaigns.js
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const API = 'https://signagecrm-production.up.railway.app/api';
const ADMIN_EMAIL = 'admin@signagecms.in';
const ADMIN_PASS = 'Admin@123';

const TEST_USERS = [
  { email: 'ravi.sharma@test.in',  password: 'Test@1234', first_name: 'Ravi',   last_name: 'Sharma',  business_name: 'Sharma Electronics',  mobile: '9810000001', campaign_title: 'Sharma Electronics — Diwali Sale' },
  { email: 'priya.patel@test.in',  password: 'Test@1234', first_name: 'Priya',  last_name: 'Patel',   business_name: 'Patel Jewellers',      mobile: '9810000002', campaign_title: 'Patel Jewellers — Gold Offer' },
  { email: 'amit.kumar@test.in',   password: 'Test@1234', first_name: 'Amit',   last_name: 'Kumar',   business_name: 'Kumar Fashion',        mobile: '9810000003', campaign_title: 'Kumar Fashion — Winter Collection' },
  { email: 'sunita.joshi@test.in', password: 'Test@1234', first_name: 'Sunita', last_name: 'Joshi',   business_name: 'Joshi Restaurant',     mobile: '9810000004', campaign_title: 'Joshi Restaurant — Special Thali' },
];

// Free stock images from picsum.photos (different for each user)
const STOCK_IMAGES = [
  { url: 'https://picsum.photos/id/1080/1920/1080', name: 'stock_diwali_sale.jpg' },
  { url: 'https://picsum.photos/id/1060/1920/1080', name: 'stock_gold_offer.jpg' },
  { url: 'https://picsum.photos/id/1074/1920/1080', name: 'stock_winter_fashion.jpg' },
  { url: 'https://picsum.photos/id/292/1920/1080',  name: 'stock_restaurant.jpg' },
];

function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const mod = urlObj.protocol === 'https:' ? https : http;
    const reqOpts = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...options.headers },
    };
    const req = mod.request(reqOpts, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlinkSync(dest);
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => { fs.unlink(dest, () => {}); reject(err); });
  });
}

function uploadFile(filePath, fileName, token) {
  return new Promise((resolve, reject) => {
    const fileData = fs.readFileSync(filePath);
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    const CRLF = '\r\n';
    const header = `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${fileName}"${CRLF}Content-Type: image/jpeg${CRLF}${CRLF}`;
    const footer = `${CRLF}--${boundary}--${CRLF}`;
    const body = Buffer.concat([Buffer.from(header), fileData, Buffer.from(footer)]);
    const urlObj = new URL(`${API}/content/upload`);
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }
function ok(msg)  { console.log(`  ✓ ${msg}`); }
function err(msg) { console.log(`  ✗ ${msg}`); }

async function run() {
  console.log('\n=== SignageCMS Test Campaign Seeder ===\n');

  // 1. Admin login
  log('Admin login...');
  const loginRes = await fetchJson(`${API}/auth/login`, {
    method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASS }
  });
  if (!loginRes.body.token) { err('Admin login failed: ' + JSON.stringify(loginRes.body)); process.exit(1); }
  const adminToken = loginRes.body.token;
  ok('Admin logged in');

  // 2. Get screen ER_001
  log('Fetching screens...');
  const screensRes = await fetchJson(`${API}/screens`, { headers: { Authorization: `Bearer ${adminToken}` } });
  const screens = Array.isArray(screensRes.body) ? screensRes.body : (screensRes.body.screens || screensRes.body.data || []);
  if (!screens.length) { err('No screens found'); process.exit(1); }
  const screen = screens[0]; // use first screen (ER_001)
  ok(`Using screen: ${screen.screen_code} (${screen.name || screen.location || screen.id}), ID: ${screen.id}`);

  // 3. Download stock images to temp folder
  const tmpDir = path.join(__dirname, '.tmp-seed');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

  log('Downloading stock images...');
  for (let i = 0; i < STOCK_IMAGES.length; i++) {
    const dest = path.join(tmpDir, STOCK_IMAGES[i].name);
    if (fs.existsSync(dest)) { ok(`Already have ${STOCK_IMAGES[i].name}`); continue; }
    process.stdout.write(`  Downloading image ${i+1}/4...`);
    await downloadFile(STOCK_IMAGES[i].url, dest);
    console.log(' done');
  }

  // 4. Process each test user
  const results = [];
  for (let i = 0; i < TEST_USERS.length; i++) {
    const u = TEST_USERS[i];
    console.log(`\n--- User ${i+1}/4: ${u.first_name} ${u.last_name} (${u.business_name}) ---`);

    // Register user
    log('Registering...');
    const regRes = await fetchJson(`${API}/auth/register`, {
      method: 'POST',
      body: { email: u.email, password: u.password, first_name: u.first_name, last_name: u.last_name, business_name: u.business_name, mobile: u.mobile }
    });
    let userToken;
    if (regRes.body.token) {
      userToken = regRes.body.token;
      ok('Registered successfully');
    } else if (regRes.status === 409 || (regRes.body.error||'').includes('already')) {
      log('Already exists, logging in...');
      const li = await fetchJson(`${API}/auth/login`, { method: 'POST', body: { email: u.email, password: u.password } });
      if (!li.body.token) { err('Login failed: ' + JSON.stringify(li.body)); continue; }
      userToken = li.body.token;
      ok('Logged in');
    } else {
      err('Registration failed: ' + JSON.stringify(regRes.body)); continue;
    }

    // Upload image
    log('Uploading stock image...');
    const imgPath = path.join(tmpDir, STOCK_IMAGES[i].name);
    const upRes = await uploadFile(imgPath, STOCK_IMAGES[i].name, userToken);
    if (upRes.status !== 201 && upRes.status !== 200) { err('Upload failed: ' + JSON.stringify(upRes.body)); continue; }
    const contentId = upRes.body.id || upRes.body.content?.id;
    ok(`Uploaded: ${STOCK_IMAGES[i].name} → content ID: ${contentId}`);

    // Create campaign
    const today = new Date();
    const start = today.toISOString().slice(0, 10);
    const end = new Date(today.getTime() + 7 * 86400000).toISOString().slice(0, 10);
    log('Creating campaign...');
    const cmpRes = await fetchJson(`${API}/campaigns`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userToken}` },
      body: { screen_ids: [screen.id], content_id: contentId, title: u.campaign_title, start_date: start, end_date: end }
    });
    if (!cmpRes.body.id && !cmpRes.body.campaign?.id) { err('Campaign create failed: ' + JSON.stringify(cmpRes.body)); continue; }
    const campaign = cmpRes.body.campaign || cmpRes.body;
    ok(`Campaign: ${campaign.campaign_code} — ₹${campaign.amount_total}`);

    // Confirm payment (dummy)
    log('Confirming payment...');
    const payRes = await fetchJson(`${API}/campaigns/${campaign.id}/confirm-payment`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userToken}` },
      body: { payment_id: `TEST-PAY-${Date.now()}-${i}`, payment_method: 'test' }
    });
    if (payRes.body.campaign || payRes.body.invoice_number) {
      ok(`Payment confirmed → status: pending_approval`);
      results.push({ user: u.email, campaign: campaign.campaign_code, amount: campaign.amount_total });
    } else {
      err('Payment confirm failed: ' + JSON.stringify(payRes.body));
    }
  }

  // Summary
  console.log('\n=== DONE ===');
  console.log(`\nCreated ${results.length}/4 campaigns — all pending_approval:\n`);
  results.forEach(r => console.log(`  ${r.campaign}  ${r.user}  ₹${r.amount}`));
  console.log('\nAdmin ko Pending Approvals mein jaake manually approve karna hai.\n');

  // Cleanup temp files
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

run().catch(console.error);

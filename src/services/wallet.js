const { query: dbQuery } = require('../db');

// Use transaction client if provided, otherwise use pool query
const q = (client) => client
  ? (sql, params) => client.query(sql, params)
  : dbQuery;

async function getOrCreateWallet(userId, client) {
  const result = await q(client)(
    `INSERT INTO user_wallets (user_id, balance) VALUES ($1, 0)
     ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [userId]
  );
  return result.rows[0];
}

async function getWallet(userId, client) {
  const result = await q(client)(
    `SELECT * FROM user_wallets WHERE user_id = $1`,
    [userId]
  );
  if (!result.rows.length) return { balance: 0 };
  return result.rows[0];
}

async function creditWallet(userId, amount, type, campaignId, description, client) {
  if (amount <= 0) return;
  await q(client)(
    `INSERT INTO wallet_transactions (user_id, type, amount, campaign_id, description)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, type, amount, campaignId || null, description]
  );
  const result = await q(client)(
    `INSERT INTO user_wallets (user_id, balance) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET balance = user_wallets.balance + $2, updated_at = NOW()
     RETURNING balance`,
    [userId, amount]
  );
  return parseFloat(result.rows[0].balance);
}

async function debitWallet(userId, amount, type, campaignId, description, client) {
  const wallet = await getWallet(userId, client);
  const balance = parseFloat(wallet.balance || 0);
  if (balance < amount - 0.01) {
    throw { status: 400, message: `Insufficient wallet balance. Available: ₹${balance.toFixed(2)}, Required: ₹${amount.toFixed(2)}` };
  }
  await q(client)(
    `INSERT INTO wallet_transactions (user_id, type, amount, campaign_id, description)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, type, -amount, campaignId || null, description]
  );
  const result = await q(client)(
    `UPDATE user_wallets SET balance = balance - $2, updated_at = NOW()
     WHERE user_id = $1 RETURNING balance`,
    [userId, amount]
  );
  return parseFloat(result.rows[0].balance);
}

// Calculate days run in a campaign segment (start inclusive, today inclusive).
// Returns 0 if sinceDate is in the future (campaign hasn't started yet).
// Returns minimum 1 if sinceDate is today or in the past.
function calcDaysRun(sinceDate) {
  const since = new Date(sinceDate);
  since.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - since) / 86400000) + 1;
  return diff <= 0 ? 0 : Math.max(1, diff);
}

// Calculate amount spent from last resume/start to today
function calcSpentSince(campaign) {
  const sinceDate = campaign.last_resumed_at || campaign.start_date;
  const daysRun = calcDaysRun(sinceDate);
  const dailyRate = parseFloat(campaign.daily_rate || 0);
  const alreadySpent = parseFloat(campaign.amount_spent || 0);
  const amountTotal = parseFloat(campaign.amount_total || 0);
  const newCharge = Math.min(daysRun * dailyRate, amountTotal - alreadySpent);
  return { daysRun, newCharge, totalSpent: alreadySpent + newCharge };
}

module.exports = { getOrCreateWallet, getWallet, creditWallet, debitWallet, calcSpentSince };

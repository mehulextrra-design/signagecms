const express = require('express');
const { query, getClient } = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { getOrCreateWallet, creditWallet } = require('../services/wallet');

const router = express.Router();

// GET /api/wallet — balance + recent transactions
router.get('/', authenticate, async (req, res, next) => {
  try {
    const wallet = await getOrCreateWallet(req.user.id);
    const txns = await query(
      `SELECT wt.*, c.campaign_code, c.title AS campaign_title
       FROM wallet_transactions wt
       LEFT JOIN campaigns c ON c.id = wt.campaign_id
       WHERE wt.user_id = $1
       ORDER BY wt.created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json({ balance: parseFloat(wallet.balance), transactions: txns.rows });
  } catch (err) { next(err); }
});

// POST /api/wallet/refund-request — user requests bank refund of wallet balance
router.post('/refund-request', authenticate, async (req, res, next) => {
  try {
    const { amount, upi_id, bank_details } = req.body;
    const wallet = await getOrCreateWallet(req.user.id);
    const balance = parseFloat(wallet.balance);
    const reqAmount = parseFloat(amount);
    if (!reqAmount || reqAmount <= 0) return res.status(400).json({ error: 'Invalid amount' });
    if (reqAmount > balance) return res.status(400).json({ error: `Insufficient balance. Available: ₹${balance.toFixed(2)}` });

    // Log as pending refund transaction (admin will process manually)
    await query(
      `INSERT INTO wallet_transactions (user_id, type, amount, description)
       VALUES ($1, 'refund_requested', $2, $3)`,
      [req.user.id, -reqAmount, `Bank refund requested. UPI: ${upi_id || ''} ${bank_details || ''}`.trim()]
    );
    await query(
      `UPDATE user_wallets SET balance = balance - $2, updated_at = NOW() WHERE user_id = $1`,
      [req.user.id, reqAmount]
    );
    res.json({ message: 'Refund request submitted. Admin will process within 5-7 business days.' });
  } catch (err) { next(err); }
});

// POST /api/wallet/admin-credit — admin manually credits a user's wallet
router.post('/admin-credit', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { user_id, amount, description } = req.body;
    if (!user_id || !amount || amount <= 0) return res.status(400).json({ error: 'user_id and amount required' });
    const newBalance = await creditWallet(user_id, parseFloat(amount), 'admin_credit', null, description || 'Admin credit');
    res.json({ message: 'Wallet credited', new_balance: newBalance });
  } catch (err) { next(err); }
});

// GET /api/wallet/admin/all — admin sees all wallet balances
router.get('/admin/all', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT w.*, u.first_name, u.last_name, u.email, u.business_name
       FROM user_wallets w JOIN users u ON u.id = w.user_id
       ORDER BY w.balance DESC`
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// GET /api/wallet/admin/refund-requests — pending refund requests
router.get('/admin/refund-requests', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT wt.*, u.first_name, u.last_name, u.email, u.mobile
       FROM wallet_transactions wt
       JOIN users u ON u.id = wt.user_id
       WHERE wt.type = 'refund_requested'
       ORDER BY wt.created_at DESC LIMIT 100`
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

module.exports = router;

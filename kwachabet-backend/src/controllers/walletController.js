const bcrypt = require('bcryptjs');
const { query, withTransaction } = require('../config/database');
const { generateId } = require('../utils/helpers');
const smsService = require('../services/sms/smsService');
const logger = require('../utils/logger');
const { OTP_STORE } = require('./authController');

const MIN_DEPOSIT    = parseFloat(process.env.MIN_DEPOSIT)    || 500;
const MIN_WITHDRAWAL = parseFloat(process.env.MIN_WITHDRAWAL) || 500;
const AUTO_LIMIT     = parseFloat(process.env.AUTO_WITHDRAWAL_LIMIT) || 1000000;

// ── Get balance ───────────────────────────────────────────────────────────────
exports.getBalance = async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT balance, bonus_balance, locked_amount, currency FROM wallets WHERE user_id = $1',
      [req.user.id]
    );
    const w = rows[0];
    if (!w) return res.status(404).json({ error: 'Wallet not found.' });

    res.json({
      balance:       parseFloat(w.balance),
      bonus_balance: parseFloat(w.bonus_balance),
      locked_amount: parseFloat(w.locked_amount),
      available:     parseFloat(w.balance) - parseFloat(w.locked_amount),
      currency:      w.currency,
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not retrieve balance.' });
  }
};

// ── Initiate deposit ──────────────────────────────────────────────────────────
exports.initiateDeposit = async (req, res) => {
  try {
    const { amount, method, phone } = req.body;
    if (parseFloat(amount) < MIN_DEPOSIT) {
      return res.status(400).json({ error: `Minimum deposit is MWK ${MIN_DEPOSIT.toLocaleString()}.` });
    }

    const { rows: userRows } = await query('SELECT phone FROM users WHERE id = $1', [req.user.id]);
    const userPhone = phone || userRows[0]?.phone;

    const depositId = generateId();
    await query(
      'INSERT INTO deposits (id, user_id, amount, payment_method, phone_used, status) VALUES ($1,$2,$3,$4,$5,$6)',
      [depositId, req.user.id, amount, method, userPhone, 'pending']
    );

    // In production: call PayChangu API here
    // For now return a demo response
    const checkoutUrl = `${process.env.FRONTEND_URL}/wallet?tab=deposit&ref=${depositId}&demo=true`;

    await query('UPDATE deposits SET checkout_url = $1 WHERE id = $2', [checkoutUrl, depositId]);

    res.status(201).json({
      deposit_id:   depositId,
      checkout_url: checkoutUrl,
      amount,
      method,
      status: 'pending',
      message: method === 'bank'
        ? 'Redirecting to secure payment page...'
        : `A payment prompt will be sent to ${userPhone}`,
    });
  } catch (err) {
    logger.error('initiateDeposit:', err.message);
    res.status(500).json({ error: 'Deposit initiation failed.' });
  }
};

// ── Credit wallet (called by webhook) ────────────────────────────────────────
exports.creditWallet = async (depositId, amount, providerRef) => {
  return withTransaction(async (client) => {
    const { rows: depRows } = await client.query(
      'SELECT * FROM deposits WHERE id = $1 FOR UPDATE', [depositId]
    );
    const deposit = depRows[0];
    if (!deposit || deposit.status !== 'pending') throw new Error('Already processed');

    const { rows: walletRows } = await client.query(
      'SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [deposit.user_id]
    );
    const wallet = walletRows[0];
    const balanceBefore = parseFloat(wallet.balance);
    const newBalance    = balanceBefore + parseFloat(amount);

    await client.query('UPDATE wallets SET balance = $1, updated_at = NOW() WHERE user_id = $2',
      [newBalance, deposit.user_id]);

    const txnId = generateId();
    await client.query(
      'INSERT INTO transactions (id,user_id,wallet_id,type,amount,balance_before,balance_after,reference,payment_method,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [txnId, deposit.user_id, wallet.id, 'deposit', amount, balanceBefore, newBalance, providerRef, deposit.payment_method, 'completed']
    );

    await client.query('UPDATE deposits SET status=$1, transaction_id=$2, provider_ref=$3, updated_at=NOW() WHERE id=$4',
      ['completed', txnId, providerRef, depositId]);

    // Apply welcome bonus on first deposit
    await applyWelcomeBonus(client, deposit.user_id, amount);

    const { rows: userRows } = await client.query('SELECT phone FROM users WHERE id = $1', [deposit.user_id]);
    await smsService.sendDepositConfirmation(userRows[0].phone, amount, newBalance);

    return { newBalance };
  });
};

async function applyWelcomeBonus(client, userId, depositAmount) {
  try {
    const existing = await client.query("SELECT id FROM user_bonuses WHERE user_id=$1 AND type='welcome'", [userId]);
    if (existing.rows.length > 0) return;

    const campaign = await client.query("SELECT * FROM bonus_campaigns WHERE type='welcome' AND is_active=true LIMIT 1");
    if (!campaign.rows.length) return;

    const camp = campaign.rows[0];
    if (parseFloat(depositAmount) < parseFloat(camp.min_deposit)) return;

    const bonusAmount = Math.min(
      parseFloat(depositAmount) * (parseFloat(camp.percent) / 100),
      parseFloat(camp.max_bonus)
    );
    const requiredWager = bonusAmount * parseFloat(camp.wagering_req);
    const expiresAt     = new Date(Date.now() + camp.expiry_days * 24 * 60 * 60 * 1000);

    await client.query(
      'INSERT INTO user_bonuses (user_id,campaign_id,type,bonus_amount,required_wager,expires_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [userId, camp.id, 'welcome', bonusAmount, requiredWager, expiresAt]
    );
    await client.query('UPDATE wallets SET bonus_balance = bonus_balance + $1 WHERE user_id = $2',
      [bonusAmount, userId]);

    logger.info(`Welcome bonus applied: user=${userId} amount=${bonusAmount}`);
  } catch (err) {
    logger.error('applyWelcomeBonus error:', err.message);
  }
}

// ── Request withdrawal ────────────────────────────────────────────────────────
exports.requestWithdrawal = async (req, res) => {
  try {
    const { amount, method, destination, otp } = req.body;
    const userId = req.user.id;

    const { rows: userRows } = await query('SELECT phone FROM users WHERE id = $1', [userId]);
    const phone = userRows[0]?.phone;

    // Verify OTP
    const stored = OTP_STORE.get(`wd:${phone}`);
    if (!stored || Date.now() > stored.expires) {
      return res.status(400).json({ error: 'OTP expired. Request a new one.' });
    }
    const validOtp = await bcrypt.compare(otp.toString(), stored.otpHash);
    if (!validOtp) {
      stored.attempts++;
      return res.status(400).json({ error: 'Incorrect OTP.' });
    }
    OTP_STORE.delete(`wd:${phone}`);

    if (parseFloat(amount) < MIN_WITHDRAWAL) {
      return res.status(400).json({ error: `Minimum withdrawal is MWK ${MIN_WITHDRAWAL.toLocaleString()}.` });
    }

    const { rows: walletRows } = await query('SELECT * FROM wallets WHERE user_id = $1', [userId]);
    const wallet    = walletRows[0];
    const available = parseFloat(wallet.balance) - parseFloat(wallet.locked_amount);

    if (parseFloat(amount) > available) {
      return res.status(400).json({ error: 'Insufficient balance.' });
    }

    const isAuto = parseFloat(amount) < AUTO_LIMIT;
    const wdId   = generateId();

    await query(
      'INSERT INTO withdrawals (id,user_id,amount,payment_method,destination,status,is_auto) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [wdId, userId, amount, method, destination, isAuto ? 'processing' : 'flagged', isAuto]
    );

    // Lock funds
    await query('UPDATE wallets SET locked_amount = locked_amount + $1 WHERE user_id = $2', [amount, userId]);

    if (!isAuto) {
      logger.warn(`Manual withdrawal required: ${wdId} amount=${amount}`);
    }

    res.status(201).json({
      withdrawal_id: wdId,
      amount,
      status: isAuto ? 'processing' : 'flagged',
      message: isAuto
        ? 'Withdrawal processing. Funds arrive within minutes.'
        : 'Withdrawal flagged for manual review. Processed within 24 hours.',
    });
  } catch (err) {
    logger.error('requestWithdrawal:', err.message);
    res.status(500).json({ error: 'Withdrawal failed.' });
  }
};

// ── Transaction history ───────────────────────────────────────────────────────
exports.getTransactions = async (req, res) => {
  try {
    const { page = 1, limit = 20, type } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let sql    = 'SELECT * FROM transactions WHERE user_id = $1';
    const args = [req.user.id];
    if (type) { sql += ' AND type = $2'; args.push(type); }
    sql += ` ORDER BY created_at DESC LIMIT ${Math.min(parseInt(limit), 50)} OFFSET ${offset}`;

    const { rows } = await query(sql, args);
    const count    = await query('SELECT COUNT(*) FROM transactions WHERE user_id = $1', [req.user.id]);

    res.json({
      transactions: rows,
      pagination: {
        total: parseInt(count.rows[0].count),
        page:  parseInt(page),
        pages: Math.ceil(count.rows[0].count / limit),
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not retrieve transactions.' });
  }
};

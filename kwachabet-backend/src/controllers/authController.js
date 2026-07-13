/**
 * Auth Controller - PostgreSQL version
 * Registration: phone + full_name + date_of_birth + 4-digit PIN
 * Login: phone + 4-digit PIN
 * OTP: only for withdrawals
 */

const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { query, withTransaction } = require('../config/database');
const { generateId, generateReferralCode, calcAge } = require('../utils/helpers');
const smsService = require('../services/sms/smsService');
const logger  = require('../utils/logger');

const MALAWI_REGEX = /^\+265[89]\d{8}$/;
const OTP_STORE    = new Map(); // Used only for withdrawals

function signToken(userId, role = 'user') {
  return jwt.sign({ sub: userId, role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

function generateOTP(length) {
  let otp = '';
  for (let i = 0; i < length; i++) otp += Math.floor(Math.random() * 10);
  return otp;
}

// ── Register: phone + full_name + date_of_birth + 4-digit PIN ────────────────
exports.initiateRegister = async (req, res) => {
  try {
    const { phone, full_name, date_of_birth, pin, email, referral_code } = req.body;

    // Validate phone
    if (!phone || !MALAWI_REGEX.test(phone)) {
      return res.status(400).json({ error: 'Only Malawian phone numbers (+265) are accepted.' });
    }

    // Validate full name
    if (!full_name || full_name.trim().length < 2) {
      return res.status(400).json({ error: 'Full name is required.' });
    }

    // Validate age
    if (!date_of_birth || calcAge(date_of_birth) < 18) {
      return res.status(403).json({ error: 'You must be 18 or older to register.' });
    }

    // Validate PIN — must be exactly 4 digits
    if (!pin || !/^\d{4}$/.test(pin.toString())) {
      return res.status(400).json({ error: 'PIN must be exactly 4 digits.' });
    }

    // Check if phone already registered
    const existing = await query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Phone number already registered.' });
    }

    // Create user + wallet in a transaction
    const result = await withTransaction(async (client) => {
      const pinHash  = await bcrypt.hash(pin.toString(), 10);
      const userId   = generateId();
      const refCode  = generateReferralCode();

      // Find referrer
      let referrerId = null;
      if (referral_code) {
        const ref = await client.query('SELECT id FROM users WHERE referral_code = $1', [referral_code]);
        if (ref.rows.length > 0) referrerId = ref.rows[0].id;
      }

      // Create user — store PIN as password_hash and pin_hash
      await client.query(`
        INSERT INTO users
          (id, phone, full_name, date_of_birth, email, password_hash, pin_hash, referral_code, referred_by, is_verified)
        VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,true)
      `, [userId, phone, full_name.trim(), date_of_birth, email || null, pinHash, refCode, referrerId]);

      // Create wallet
      await client.query('INSERT INTO wallets (user_id) VALUES ($1)', [userId]);

      // Create referral record
      if (referrerId) {
        await client.query(
          'INSERT INTO referrals (referrer_id, referred_id) VALUES ($1,$2)',
          [referrerId, userId]
        );
      }

      return { userId, refCode, full_name: full_name.trim() };
    });

    // Send welcome SMS (non-blocking — don't fail registration if SMS fails)
    try {
      await smsService.sendWelcome(phone, result.full_name.split(' ')[0]);
    } catch (smsErr) {
      logger.warn('Welcome SMS failed (non-critical): ' + smsErr.message);
    }

    const token = signToken(result.userId);
    logger.info('New user registered: ' + result.userId + ' (' + phone + ')');

    res.status(201).json({
      message: 'Account created! Welcome to Kwacha Bet.',
      token,
      user: {
        id:            result.userId,
        phone,
        full_name:     result.full_name,
        referral_code: result.refCode,
        is_admin:      false,
      },
    });
  } catch (err) {
    logger.error('register error: ' + err.message);
    res.status(500).json({ error: 'Registration failed. Try again.' });
  }
};

// ── verifyRegister — no longer used but kept for backwards compat ─────────────
exports.verifyRegister = async (req, res) => {
  res.status(410).json({ error: 'OTP registration is no longer required. Register directly.' });
};

// ── Login: phone + 4-digit PIN ────────────────────────────────────────────────
exports.login = async (req, res) => {
  try {
    const { phone, password, pin } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.ip;

    if (!phone) return res.status(400).json({ error: 'Phone number is required.' });

    const { rows } = await query('SELECT * FROM users WHERE phone = $1', [phone]);
    const user = rows[0];

    if (!user) return res.status(401).json({ error: 'Invalid phone number or PIN.' });
    if (user.is_suspended) return res.status(403).json({ error: 'Account suspended. Contact support@kwachabet.mw' });

    // Support both PIN login and password login
    const credential = pin ? pin.toString() : password;
    if (!credential) return res.status(400).json({ error: 'PIN is required.' });

    // Try PIN first, then password_hash as fallback
    let valid = false;
    if (user.pin_hash) {
      valid = await bcrypt.compare(credential, user.pin_hash);
    }
    if (!valid && user.password_hash) {
      valid = await bcrypt.compare(credential, user.password_hash);
    }

    if (!valid) return res.status(401).json({ error: 'Invalid phone number or PIN.' });

    await query(
      'UPDATE users SET last_login_at=NOW(), last_login_ip=$1 WHERE id=$2',
      [ip, user.id]
    );

    const token = signToken(user.id, user.is_admin ? 'admin' : 'user');
    logger.info('User login: ' + user.id + ' (' + phone + ')');

    res.json({
      token,
      user: {
        id:        user.id,
        phone:     user.phone,
        full_name: user.full_name,
        is_admin:  user.is_admin,
      },
    });
  } catch (err) {
    logger.error('login error: ' + err.message);
    res.status(500).json({ error: 'Login failed. Try again.' });
  }
};

// ── Set PIN ───────────────────────────────────────────────────────────────────
exports.setPin = async (req, res) => {
  try {
    const { pin } = req.body;
    if (!/^\d{4}$/.test(pin.toString())) {
      return res.status(400).json({ error: 'PIN must be exactly 4 digits.' });
    }
    const pinHash = await bcrypt.hash(pin.toString(), 10);
    await query(
      'UPDATE users SET pin_hash=$1, password_hash=$1 WHERE id=$2',
      [pinHash, req.user.id]
    );
    res.json({ message: 'PIN set successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to set PIN.' });
  }
};

// ── Verify PIN ────────────────────────────────────────────────────────────────
exports.verifyPin = async (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin || !/^\d{4}$/.test(pin.toString())) {
      return res.status(400).json({ error: 'PIN must be exactly 4 digits.' });
    }

    const { rows } = await query('SELECT pin_hash, password_hash FROM users WHERE id=$1', [req.user.id]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const hash = user.pin_hash || user.password_hash;
    if (!hash) return res.status(400).json({ error: 'No PIN set. Please set a PIN first.' });

    const valid = await bcrypt.compare(pin.toString(), hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect PIN.' });

    const pinToken = jwt.sign(
      { sub: req.user.id, scope: 'pin_verified' },
      process.env.JWT_SECRET,
      { expiresIn: '5m' }
    );
    res.json({ pin_token: pinToken, expires_in: 300 });
  } catch (err) {
    res.status(500).json({ error: 'PIN verification failed.' });
  }
};

// ── Request OTP for withdrawal ONLY ──────────────────────────────────────────
exports.requestWithdrawalOTP = async (req, res) => {
  try {
    const { rows } = await query('SELECT phone FROM users WHERE id=$1', [req.user.id]);
    const phone = rows[0]?.phone;
    if (!phone) return res.status(404).json({ error: 'User not found.' });

    const otp     = generateOTP(6);
    const otpHash = await bcrypt.hash(otp, 10);
    OTP_STORE.set('wd:' + phone, {
      otpHash,
      expires:  Date.now() + 5 * 60 * 1000,
      attempts: 0,
    });

    await smsService.sendOTP(phone, otp, 'withdrawal');
    logger.info('Withdrawal OTP sent to: ' + phone);
    res.json({ message: 'OTP sent for withdrawal verification. Valid for 5 minutes.' });
  } catch (err) {
    logger.error('requestWithdrawalOTP error: ' + err.message);
    res.status(500).json({ error: 'Could not send OTP. Try again.' });
  }
};

// ── Verify withdrawal OTP ─────────────────────────────────────────────────────
exports.verifyWithdrawalOTP = async (req, res) => {
  try {
    const { otp } = req.body;
    const { rows } = await query('SELECT phone FROM users WHERE id=$1', [req.user.id]);
    const phone = rows[0]?.phone;
    if (!phone) return res.status(404).json({ error: 'User not found.' });

    const stored = OTP_STORE.get('wd:' + phone);
    if (!stored) return res.status(400).json({ error: 'OTP expired. Request a new one.' });
    if (Date.now() > stored.expires) {
      OTP_STORE.delete('wd:' + phone);
      return res.status(400).json({ error: 'OTP expired. Request a new one.' });
    }
    if (stored.attempts >= 3) {
      return res.status(429).json({ error: 'Too many attempts. Request a new OTP.' });
    }

    const valid = await bcrypt.compare(otp.toString(), stored.otpHash);
    if (!valid) {
      stored.attempts++;
      return res.status(400).json({ error: 'Incorrect OTP.' });
    }

    OTP_STORE.delete('wd:' + phone);

    const otpToken = jwt.sign(
      { sub: req.user.id, scope: 'withdrawal_verified' },
      process.env.JWT_SECRET,
      { expiresIn: '10m' }
    );
    res.json({ otp_token: otpToken, expires_in: 600 });
  } catch (err) {
    res.status(500).json({ error: 'OTP verification failed.' });
  }
};

// Export OTP_STORE for wallet controller
exports.OTP_STORE = OTP_STORE;

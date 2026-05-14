/**
 * Auth Controller - PostgreSQL version
 * No SQLite. Uses pg pool directly.
 */

const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { query, withTransaction } = require('../config/database');
const { generateOTP, generateId, generateReferralCode, calcAge } = require('../utils/helpers');
const smsService = require('../services/sms/smsService');
const logger  = require('../utils/logger');

const MALAWI_REGEX = /^\+265[89]\d{8}$/;
const OTP_STORE = new Map(); // In-memory OTP store (use Redis in production)

function signToken(userId, role = 'user') {
  return jwt.sign({ sub: userId, role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

// ── Register Step 1: send OTP ─────────────────────────────────────────────────
exports.initiateRegister = async (req, res) => {
  try {
    const { phone, full_name, date_of_birth, password, email } = req.body;

    if (!MALAWI_REGEX.test(phone)) {
      return res.status(400).json({ error: 'Only Malawian phone numbers (+265) are accepted.' });
    }
    if (calcAge(date_of_birth) < 18) {
      return res.status(403).json({ error: 'You must be 18 or older to register.' });
    }

    const existing = await query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Phone number already registered.' });
    }

    const otp      = generateOTP(6);
    const otpHash  = await bcrypt.hash(otp, 10);
    const expires  = Date.now() + 5 * 60 * 1000;

    OTP_STORE.set(`reg:${phone}`, {
      otpHash, expires, attempts: 0,
      userData: { phone, full_name, date_of_birth, password, email },
    });

    // Send OTP via SMS (Africa's Talking)
    await smsService.sendOTP(phone, otp, 'registration');

    logger.info(`Registration OTP sent to ${phone}`);
    res.json({ message: 'OTP sent to your phone. Valid for 5 minutes.', expires_in: 300 });
  } catch (err) {
    logger.error('initiateRegister error:', err.message);
    res.status(500).json({ error: 'Registration failed. Try again.' });
  }
};

// ── Register Step 2: verify OTP ───────────────────────────────────────────────
exports.verifyRegister = async (req, res) => {
  try {
    const { phone, otp, referral_code } = req.body;
    const stored = OTP_STORE.get(`reg:${phone}`);

    if (!stored)                       return res.status(400).json({ error: 'OTP expired. Request a new one.' });
    if (Date.now() > stored.expires)   { OTP_STORE.delete(`reg:${phone}`); return res.status(400).json({ error: 'OTP expired.' }); }
    if (stored.attempts >= 3)          return res.status(429).json({ error: 'Too many attempts. Request a new OTP.' });

    const valid = await bcrypt.compare(otp.toString(), stored.otpHash);
    if (!valid) {
      stored.attempts++;
      return res.status(400).json({ error: 'Incorrect OTP.' });
    }

    const { userData } = stored;
    OTP_STORE.delete(`reg:${phone}`);

    // Create user + wallet in a transaction
    const result = await withTransaction(async (client) => {
      const passwordHash  = await bcrypt.hash(userData.password, parseInt(process.env.BCRYPT_ROUNDS) || 12);
      const userId        = generateId();
      const refCode       = generateReferralCode();

      // Find referrer
      let referrerId = null;
      if (referral_code) {
        const ref = await client.query('SELECT id FROM users WHERE referral_code = $1', [referral_code]);
        if (ref.rows.length > 0) referrerId = ref.rows[0].id;
      }

      // Create user
      await client.query(`
        INSERT INTO users (id, phone, full_name, date_of_birth, email, password_hash, referral_code, referred_by, is_verified)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)
      `, [userId, userData.phone, userData.full_name.trim(), userData.date_of_birth, userData.email || null, passwordHash, refCode, referrerId]);

      // Create wallet
      await client.query('INSERT INTO wallets (user_id) VALUES ($1)', [userId]);

      // Create referral record
      if (referrerId) {
        await client.query(
          'INSERT INTO referrals (referrer_id, referred_id) VALUES ($1,$2)',
          [referrerId, userId]
        );
      }

      return { userId, refCode, full_name: userData.full_name };
    });

    // Send welcome SMS
    await smsService.sendWelcome(phone, result.full_name.split(' ')[0]);

    const token = signToken(result.userId);
    logger.info(`New user registered: ${result.userId} (${phone})`);

    res.status(201).json({
      message: 'Account created! Welcome to Kwacha Bet.',
      token,
      user: { id: result.userId, phone, full_name: result.full_name, referral_code: result.refCode },
    });
  } catch (err) {
    logger.error('verifyRegister error:', err.message);
    res.status(500).json({ error: 'Verification failed. Try again.' });
  }
};

// ── Login ─────────────────────────────────────────────────────────────────────
exports.login = async (req, res) => {
  try {
    const { phone, password } = req.body;
    const ip = req.ip || req.headers['x-forwarded-for'];

    const { rows } = await query('SELECT * FROM users WHERE phone = $1', [phone]);
    const user = rows[0];

    if (!user) return res.status(401).json({ error: 'Invalid phone number or password.' });
    if (user.is_suspended) return res.status(403).json({ error: 'Account suspended. Contact support@kwachabet.mw' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid phone number or password.' });

    await query("UPDATE users SET last_login_at = NOW(), last_login_ip = $1 WHERE id = $2", [ip, user.id]);

    const token = signToken(user.id, user.is_admin ? 'admin' : 'user');
    res.json({
      token,
      user: { id: user.id, phone: user.phone, full_name: user.full_name, is_admin: user.is_admin },
    });
  } catch (err) {
    logger.error('login error:', err.message);
    res.status(500).json({ error: 'Login failed.' });
  }
};

// ── Set PIN ───────────────────────────────────────────────────────────────────
exports.setPin = async (req, res) => {
  try {
    const { pin } = req.body;
    if (!/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'PIN must be exactly 4 digits.' });
    const pinHash = await bcrypt.hash(pin, 10);
    await query('UPDATE users SET pin_hash = $1 WHERE id = $2', [pinHash, req.user.id]);
    res.json({ message: 'PIN set successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to set PIN.' });
  }
};

// ── Verify PIN ────────────────────────────────────────────────────────────────
exports.verifyPin = async (req, res) => {
  try {
    const { pin } = req.body;
    const { rows } = await query('SELECT pin_hash FROM users WHERE id = $1', [req.user.id]);
    const user = rows[0];

    if (!user?.pin_hash) return res.status(400).json({ error: 'No PIN set. Please set a PIN first.' });

    const valid = await bcrypt.compare(pin.toString(), user.pin_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect PIN.' });

    const pinToken = jwt.sign({ sub: req.user.id, scope: 'pin_verified' }, process.env.JWT_SECRET, { expiresIn: '5m' });
    res.json({ pin_token: pinToken, expires_in: 300 });
  } catch (err) {
    res.status(500).json({ error: 'PIN verification failed.' });
  }
};

// ── Request OTP for withdrawal ────────────────────────────────────────────────
exports.requestWithdrawalOTP = async (req, res) => {
  try {
    const { rows } = await query('SELECT phone FROM users WHERE id = $1', [req.user.id]);
    const phone = rows[0]?.phone;
    if (!phone) return res.status(404).json({ error: 'User not found.' });

    const otp     = generateOTP(6);
    const otpHash = await bcrypt.hash(otp, 10);
    OTP_STORE.set(`wd:${phone}`, { otpHash, expires: Date.now() + 5 * 60 * 1000, attempts: 0 });

    await smsService.sendOTP(phone, otp, 'withdrawal');
    res.json({ message: 'OTP sent for withdrawal verification.' });
  } catch (err) {
    res.status(500).json({ error: 'Could not send OTP.' });
  }
};

// Export OTP_STORE for wallet controller
exports.OTP_STORE = OTP_STORE;

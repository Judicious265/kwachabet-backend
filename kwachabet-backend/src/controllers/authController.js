/**
 * Auth Controller - PostgreSQL version
 * Registration: phone + full_name + date_of_birth + 4-digit PIN (no OTP)
 * Login: phone + 4-digit PIN
 * OTP: withdrawal only
 */

const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const { query, withTransaction } = require('../config/database');
const { generateId, generateReferralCode } = require('../utils/helpers');
const smsService = require('../services/sms/smsService');
const logger     = require('../utils/logger');

const MALAWI_REGEX = /^\+265[89]\d{8}$/;
const OTP_STORE    = new Map();

function signToken(userId, role) {
  role = role || 'user';
  return jwt.sign({ sub: userId, role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

function generateOTP(length) {
  var otp = '';
  for (var i = 0; i < length; i++) otp += Math.floor(Math.random() * 10);
  return otp;
}

function calcAge(dob) {
  var birth = new Date(dob);
  var today = new Date();
  var age   = today.getFullYear() - birth.getFullYear();
  var m     = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}

// ── Register: phone + full_name + date_of_birth + 4-digit PIN ─────────────────
exports.initiateRegister = async function(req, res) {
  try {
    var phone         = req.body.phone;
    var full_name     = req.body.full_name;
    var date_of_birth = req.body.date_of_birth;
    var pin           = req.body.pin;
    var email         = req.body.email;
    var referral_code = req.body.referral_code;

    if (!phone || !MALAWI_REGEX.test(phone)) {
      return res.status(400).json({ error: 'Only Malawian phone numbers (+265) are accepted.' });
    }
    if (!full_name || full_name.trim().length < 2) {
      return res.status(400).json({ error: 'Full name is required.' });
    }
    if (!date_of_birth) {
      return res.status(400).json({ error: 'Date of birth is required.' });
    }
    if (calcAge(date_of_birth) < 18) {
      return res.status(403).json({ error: 'You must be 18 or older to register.' });
    }
    if (!pin || !/^\d{4}$/.test(pin.toString())) {
      return res.status(400).json({ error: 'PIN must be exactly 4 digits.' });
    }

    var existing = await query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Phone number already registered.' });
    }

    var result = await withTransaction(async function(client) {
      var pinHash = await bcrypt.hash(pin.toString(), 10);
      var userId  = generateId();
      var refCode = generateReferralCode();

      var referrerId = null;
      if (referral_code) {
        var ref = await client.query('SELECT id FROM users WHERE referral_code = $1', [referral_code]);
        if (ref.rows.length > 0) referrerId = ref.rows[0].id;
      }

      await client.query(
        'INSERT INTO users (id,phone,full_name,date_of_birth,email,password_hash,pin_hash,referral_code,referred_by,is_verified) VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,true)',
        [userId, phone, full_name.trim(), date_of_birth, email || null, pinHash, refCode, referrerId]
      );

      await client.query('INSERT INTO wallets (user_id) VALUES ($1)', [userId]);

      if (referrerId) {
        await client.query(
          'INSERT INTO referrals (referrer_id, referred_id) VALUES ($1,$2)',
          [referrerId, userId]
        );
      }

      return { userId: userId, refCode: refCode, full_name: full_name.trim() };
    });

    // Send welcome SMS — non-blocking, failure does not stop registration
    try {
      await smsService.sendWelcome(phone, result.full_name.split(' ')[0]);
    } catch (smsErr) {
      logger.warn('Welcome SMS failed (non-critical): ' + smsErr.message);
    }

    var token = signToken(result.userId);
    logger.info('New user registered: ' + result.userId + ' (' + phone + ')');

    res.status(201).json({
      message: 'Account created! Welcome to Kwacha Bet.',
      token: token,
      user: {
        id:            result.userId,
        phone:         phone,
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

// ── verifyRegister — no longer used ──────────────────────────────────────────
exports.verifyRegister = function(req, res) {
  res.status(410).json({ error: 'OTP registration no longer required. Register directly.' });
};

// ── Login: phone + 4-digit PIN ────────────────────────────────────────────────
exports.login = async function(req, res) {
  try {
    var phone = req.body.phone;
    var pin   = req.body.pin;
    var password = req.body.password;
    var ip    = req.headers['x-forwarded-for'] || req.ip;

    if (!phone) return res.status(400).json({ error: 'Phone number is required.' });

    var credential = pin ? pin.toString() : password;
    if (!credential) return res.status(400).json({ error: 'PIN is required.' });

    var rows = (await query('SELECT * FROM users WHERE phone = $1', [phone])).rows;
    var user = rows[0];

    if (!user)             return res.status(401).json({ error: 'Invalid phone number or PIN.' });
    if (user.is_suspended) return res.status(403).json({ error: 'Account suspended. Contact support@kwachabet.mw' });

    var valid = false;
    if (user.pin_hash) {
      valid = await bcrypt.compare(credential, user.pin_hash);
    }
    if (!valid && user.password_hash) {
      valid = await bcrypt.compare(credential, user.password_hash);
    }
    if (!valid) return res.status(401).json({ error: 'Invalid phone number or PIN.' });

    await query('UPDATE users SET last_login_at=NOW(), last_login_ip=$1 WHERE id=$2', [ip, user.id]);

    var token = signToken(user.id, user.is_admin ? 'admin' : 'user');
    logger.info('User login: ' + user.id + ' (' + phone + ')');

    res.json({
      token: token,
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
exports.setPin = async function(req, res) {
  try {
    var pin = req.body.pin;
    if (!pin || !/^\d{4}$/.test(pin.toString())) {
      return res.status(400).json({ error: 'PIN must be exactly 4 digits.' });
    }
    var pinHash = await bcrypt.hash(pin.toString(), 10);
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
exports.verifyPin = async function(req, res) {
  try {
    var pin = req.body.pin;
    if (!pin || !/^\d{4}$/.test(pin.toString())) {
      return res.status(400).json({ error: 'PIN must be exactly 4 digits.' });
    }
    var rows = (await query('SELECT pin_hash, password_hash FROM users WHERE id=$1', [req.user.id])).rows;
    var user = rows[0];
    if (!user) return res.status(404).json({ error: 'User not found.' });

    var hash  = user.pin_hash || user.password_hash;
    if (!hash) return res.status(400).json({ error: 'No PIN set. Please set a PIN first.' });

    var valid = await bcrypt.compare(pin.toString(), hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect PIN.' });

    var pinToken = jwt.sign(
      { sub: req.user.id, scope: 'pin_verified' },
      process.env.JWT_SECRET,
      { expiresIn: '5m' }
    );
    res.json({ pin_token: pinToken, expires_in: 300 });
  } catch (err) {
    res.status(500).json({ error: 'PIN verification failed.' });
  }
};

// ── Request withdrawal OTP ────────────────────────────────────────────────────
exports.requestWithdrawalOTP = async function(req, res) {
  try {
    var rows  = (await query('SELECT phone FROM users WHERE id=$1', [req.user.id])).rows;
    var phone = rows[0] && rows[0].phone;
    if (!phone) return res.status(404).json({ error: 'User not found.' });

    var otp     = generateOTP(6);
    var otpHash = await bcrypt.hash(otp, 10);
    OTP_STORE.set('wd:' + phone, {
      otpHash:  otpHash,
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
exports.verifyWithdrawalOTP = async function(req, res) {
  try {
    var otp   = req.body.otp;
    var rows  = (await query('SELECT phone FROM users WHERE id=$1', [req.user.id])).rows;
    var phone = rows[0] && rows[0].phone;
    if (!phone) return res.status(404).json({ error: 'User not found.' });

    var stored = OTP_STORE.get('wd:' + phone);
    if (!stored)                      return res.status(400).json({ error: 'OTP expired. Request a new one.' });
    if (Date.now() > stored.expires)  { OTP_STORE.delete('wd:' + phone); return res.status(400).json({ error: 'OTP expired. Request a new one.' }); }
    if (stored.attempts >= 3)         return res.status(429).json({ error: 'Too many attempts. Request a new OTP.' });

    var valid = await bcrypt.compare(otp.toString(), stored.otpHash);
    if (!valid) {
      stored.attempts++;
      return res.status(400).json({ error: 'Incorrect OTP.' });
    }

    OTP_STORE.delete('wd:' + phone);
    var otpToken = jwt.sign(
      { sub: req.user.id, scope: 'withdrawal_verified' },
      process.env.JWT_SECRET,
      { expiresIn: '10m' }
    );
    res.json({ otp_token: otpToken, expires_in: 600 });
  } catch (err) {
    res.status(500).json({ error: 'OTP verification failed.' });
  }
};

exports.OTP_STORE = OTP_STORE;

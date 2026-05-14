const axios  = require('axios');
const qs     = require('querystring');
const logger = require('../../utils/logger');

const BASE     = process.env.AT_BASE_URL || 'https://api.africastalking.com';
const API_KEY  = process.env.AT_API_KEY;
const USERNAME = process.env.AT_USERNAME || 'kwachabet';
const SENDER   = process.env.AT_SENDER_ID || 'KwachaBet';

const fmt = (n) => `MWK ${parseFloat(n||0).toLocaleString('en-MW',{minimumFractionDigits:2})}`;

const TEMPLATES = {
  otp_registration: (otp) => `Welcome to Kwacha Bet! Your verification code is: ${otp}. Valid for 5 minutes. Do not share this code.`,
  otp_withdrawal:   (otp) => `KwachaBet: Your withdrawal OTP is ${otp}. Valid 5 mins. Never share this code.`,
  welcome:          (name)=> `Hi ${name}! Welcome to Kwacha Bet - Malawi's #1 betting platform. Deposit now to start winning! kwachabet.mw`,
  deposit:          (a,b) => `KwachaBet: Deposit of ${fmt(a)} received. Balance: ${fmt(b)}. Good luck!`,
  withdrawal_done:  (a)   => `KwachaBet: Withdrawal of ${fmt(a)} successful. Check your mobile money wallet.`,
  withdrawal_proc:  (a)   => `KwachaBet: Withdrawal of ${fmt(a)} is processing. Funds arrive within 10 minutes.`,
  win:              (a,b) => `Congratulations! You won ${fmt(a)} on KwachaBet! Balance: ${fmt(b)}. Keep winning!`,
  bonus:            (a,t) => `KwachaBet: You received a ${t} bonus of ${fmt(a)}! Log in to use it.`,
  referral:         (a)   => `KwachaBet: You earned ${fmt(a)} referral bonus! Your friend joined and deposited.`,
};

exports.sendSMS = async (phone, message) => {
  if (!API_KEY || !phone) {
    logger.warn(`SMS skipped (no API key or phone): ${message?.substring(0,50)}`);
    return;
  }
  try {
    const payload = qs.stringify({ username: USERNAME, to: phone, message, from: SENDER });
    const res = await axios.post(`${BASE}/version1/messaging`, payload, {
      headers: { apiKey: API_KEY, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      timeout: 15000,
    });
    const result = res.data.SMSMessageData?.Recipients?.[0];
    if (result?.status === 'Success') {
      logger.info(`SMS sent to ${phone}`);
    } else {
      logger.warn(`SMS failed to ${phone}: ${result?.status}`);
    }
  } catch (err) {
    logger.error(`SMS error to ${phone}:`, err.message);
  }
};

exports.sendOTP = async (phone, otp, purpose = 'registration') => {
  const key = `otp_${purpose}`;
  const msg = TEMPLATES[key] ? TEMPLATES[key](otp) : TEMPLATES.otp_registration(otp);
  await exports.sendSMS(phone, msg);
};

exports.sendWelcome               = async (phone, firstName) => exports.sendSMS(phone, TEMPLATES.welcome(firstName));
exports.sendDepositConfirmation   = async (phone, amount, balance) => exports.sendSMS(phone, TEMPLATES.deposit(amount, balance));
exports.sendWithdrawalUpdate      = async (phone, amount, status) => {
  const msg = status === 'completed' ? TEMPLATES.withdrawal_done(amount) : TEMPLATES.withdrawal_proc(amount);
  await exports.sendSMS(phone, msg);
};
exports.sendWinNotification       = async (phone, amount, balance) => exports.sendSMS(phone, TEMPLATES.win(amount, balance));
exports.sendBonusNotification     = async (phone, amount, type)    => exports.sendSMS(phone, TEMPLATES.bonus(amount, type));
exports.sendReferralReward        = async (phone, amount)          => exports.sendSMS(phone, TEMPLATES.referral(amount));

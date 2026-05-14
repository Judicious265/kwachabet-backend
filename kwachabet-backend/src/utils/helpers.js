const crypto = require('crypto');

const generateOTP = (length = 6) => {
  let otp = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) otp += bytes[i] % 10;
  return otp;
};

const generateId = () => crypto.randomUUID();

const generateReferralCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) code += chars[bytes[i] % chars.length];
  return code;
};

const generateTicketCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'KB-';
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) code += chars[bytes[i] % chars.length];
  return code;
};

const formatMWK = (n) =>
  `MWK ${parseFloat(n || 0).toLocaleString('en-MW', { minimumFractionDigits: 2 })}`;

const calcAge = (dob) => {
  const diff = Date.now() - new Date(dob).getTime();
  return Math.floor(diff / (365.25 * 24 * 60 * 60 * 1000));
};

module.exports = { generateOTP, generateId, generateReferralCode, generateTicketCode, formatMWK, calcAge };

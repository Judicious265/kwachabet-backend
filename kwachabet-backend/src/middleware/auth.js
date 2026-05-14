const jwt    = require('jsonwebtoken');
const { query } = require('../config/database');

exports.authenticate = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    const token   = header.slice(7);
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const { rows } = await query(
      'SELECT id, phone, full_name, is_active, is_suspended, is_admin, risk_score FROM users WHERE id = $1',
      [decoded.sub]
    );
    const user = rows[0];

    if (!user)           return res.status(401).json({ error: 'User not found.' });
    if (!user.is_active) return res.status(403).json({ error: 'Account deactivated.' });
    if (user.is_suspended) return res.status(403).json({ error: 'Account suspended. Contact support@kwachabet.mw' });

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return res.status(401).json({ error: 'Session expired. Please log in again.' });
    if (err.name === 'JsonWebTokenError')  return res.status(401).json({ error: 'Invalid token.' });
    next(err);
  }
};

exports.requireAdmin = (req, res, next) => {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Admin access required.' });
  next();
};

exports.requirePin = (req, res, next) => {
  const pinToken = req.headers['x-pin-token'];
  if (!pinToken) return res.status(403).json({ error: 'PIN verification required.' });
  try {
    const decoded = jwt.verify(pinToken, process.env.JWT_SECRET);
    if (decoded.scope !== 'pin_verified' || decoded.sub !== req.user.id) throw new Error();
    next();
  } catch {
    return res.status(403).json({ error: 'PIN token invalid or expired.' });
  }
};

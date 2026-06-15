/**
 * RBAC Middleware
 * Authenticates admin JWT and checks role permissions
 */

const jwt    = require('jsonwebtoken');
const { query } = require('../config/database');
const logger = require('../utils/logger');

// ── Authenticate Admin ────────────────────────────────────────────────────────
exports.authenticateAdmin = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Admin authentication required.' });
    }

    const token   = header.slice(7);
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.type !== 'admin') {
      return res.status(403).json({ error: 'Admin token required.' });
    }

    const { rows } = await query(`
      SELECT a.*, r.name as role_name, r.label as role_label
      FROM admins a
      JOIN admin_roles r ON a.role_id = r.id
      WHERE a.id = $1
    `, [decoded.sub]);

    const admin = rows[0];
    if (!admin)            return res.status(401).json({ error: 'Admin not found.' });
    if (!admin.is_active)  return res.status(403).json({ error: 'Account inactive.' });
    if (admin.is_suspended)return res.status(403).json({ error: 'Account suspended. Contact Super Admin.' });

    // Load permissions
    const { rows: perms } = await query(
      'SELECT * FROM admin_permissions WHERE role_id=$1',
      [admin.role_id]
    );
    const permissions = {};
    perms.forEach(p => { permissions[p.resource] = p; });

    req.admin       = admin;
    req.permissions = permissions;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token.' });
    }
    logger.error('authenticateAdmin error:', err.message);
    next(err);
  }
};

// ── Require Super Admin ───────────────────────────────────────────────────────
exports.requireSuperAdmin = (req, res, next) => {
  if (req.admin?.role_name !== 'super_admin') {
    return res.status(403).json({ error: 'Super Admin access required.' });
  }
  next();
};

// ── Require specific permission ───────────────────────────────────────────────
exports.requirePermission = (resource, action = 'can_view') => {
  return (req, res, next) => {
    const perm = req.permissions?.[resource];
    if (!perm || !perm[action]) {
      return res.status(403).json({
        error: `You do not have permission to ${action.replace('can_', '')} ${resource}.`,
        required: { resource, action },
        role: req.admin?.role_name,
      });
    }
    next();
  };
};

// ── Log admin action (middleware) ─────────────────────────────────────────────
exports.logAction = (action, resourceType, getDescription) => {
  return async (req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = async (data) => {
      // Only log on success
      if (res.statusCode < 400 && req.admin) {
        try {
          const description = getDescription
            ? getDescription(req, data)
            : `${action} on ${resourceType}`;
          await query(
            `INSERT INTO admin_activity_logs (admin_id,action,resource_type,resource_id,description,ip_address,user_agent)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [
              req.admin.id, action, resourceType,
              req.params?.id || null,
              description,
              req.headers['x-forwarded-for'] || req.ip,
              req.headers['user-agent'],
            ]
          );
        } catch (logErr) {
          logger.error('Failed to log admin action:', logErr.message);
        }
      }
      return originalJson(data);
    };
    next();
  };
};

// ── Check multiple roles ──────────────────────────────────────────────────────
exports.requireAnyRole = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.admin?.role_name)) {
      return res.status(403).json({
        error: `Access denied. Required roles: ${roles.join(', ')}`,
        your_role: req.admin?.role_name,
      });
    }
    next();
  };
};

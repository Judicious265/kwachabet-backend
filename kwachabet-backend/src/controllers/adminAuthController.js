/**
 * Admin Auth Controller
 * Handles login, logout, token refresh with RBAC
 */

const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const { query, withTransaction } = require('../config/database');
const logger = require('../utils/logger');

const MAX_ATTEMPTS  = 5;
const LOCKOUT_MINS  = 30;

function signAdminToken(admin) {
  return jwt.sign(
    {
      sub:   admin.id,
      role:  admin.role_name,
      phone: admin.phone,
      type:  'admin',
    },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  );
}

// ── Login ─────────────────────────────────────────────────────────────────────
exports.login = async (req, res) => {
  const ip        = req.headers['x-forwarded-for'] || req.ip;
  const userAgent = req.headers['user-agent'];

  try {
    const { phone, password } = req.body;
    if (!phone || !password) {
      return res.status(400).json({ error: 'Phone and password are required.' });
    }

    // Find admin with role info
    const { rows } = await query(`
      SELECT a.*, r.name as role_name, r.label as role_label, r.color as role_color
      FROM admins a
      JOIN admin_roles r ON a.role_id = r.id
      WHERE a.phone = $1
    `, [phone]);

    const admin = rows[0];

    if (!admin) {
      logger.warn(`Failed admin login attempt: ${phone} from ${ip}`);
      return res.status(401).json({ error: 'Invalid phone or password.' });
    }

    // Check if account is locked
    if (admin.locked_until && new Date(admin.locked_until) > new Date()) {
      const mins = Math.ceil((new Date(admin.locked_until) - Date.now()) / 60000);
      return res.status(423).json({ error: `Account locked. Try again in ${mins} minutes.` });
    }

    // Check suspended
    if (admin.is_suspended) {
      return res.status(403).json({ error: 'Your admin account has been suspended. Contact Super Admin.' });
    }

    // Check active
    if (!admin.is_active) {
      return res.status(403).json({ error: 'Account is inactive. Contact Super Admin.' });
    }

    // Verify password
    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) {
      const newAttempts = (admin.failed_attempts || 0) + 1;
      if (newAttempts >= MAX_ATTEMPTS) {
        const lockedUntil = new Date(Date.now() + LOCKOUT_MINS * 60 * 1000);
        await query(
          'UPDATE admins SET failed_attempts=$1, locked_until=$2 WHERE id=$3',
          [newAttempts, lockedUntil, admin.id]
        );
        logger.warn(`Admin account locked after ${MAX_ATTEMPTS} attempts: ${phone}`);
        return res.status(423).json({ error: `Too many failed attempts. Account locked for ${LOCKOUT_MINS} minutes.` });
      }
      await query('UPDATE admins SET failed_attempts=$1 WHERE id=$2', [newAttempts, admin.id]);
      return res.status(401).json({ error: `Invalid password. ${MAX_ATTEMPTS - newAttempts} attempts remaining.` });
    }

    // Success — reset failed attempts, update last login
    await query(
      'UPDATE admins SET failed_attempts=0, locked_until=NULL, last_login_at=NOW(), last_login_ip=$1 WHERE id=$2',
      [ip, admin.id]
    );

    // Get permissions for this role
    const { rows: perms } = await query(
      'SELECT resource, can_view, can_create, can_edit, can_delete, can_approve FROM admin_permissions WHERE role_id=$1',
      [admin.role_id]
    );

    const permissions: Record<string, any> = {};
    perms.forEach(p => { permissions[p.resource] = p; });

    // Log activity
    await query(
      `INSERT INTO admin_activity_logs (admin_id,action,description,ip_address,user_agent)
       VALUES ($1,'login','Admin logged in',$2,$3)`,
      [admin.id, ip, userAgent]
    );

    const token = signAdminToken(admin);

    logger.info(`Admin login: ${admin.full_name} (${admin.role_name}) from ${ip}`);

    res.json({
      token,
      admin: {
        id:         admin.id,
        full_name:  admin.full_name,
        phone:      admin.phone,
        role:       admin.role_name,
        role_label: admin.role_label,
        role_color: admin.role_color,
        permissions,
      },
    });
  } catch (err) {
    logger.error('Admin login error:', err.message);
    res.status(500).json({ error: 'Login failed. Try again.' });
  }
};

// ── Get current admin profile ─────────────────────────────────────────────────
exports.getProfile = async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT a.id, a.full_name, a.phone, a.email, a.last_login_at, a.last_login_ip,
             r.name as role, r.label as role_label, r.color as role_color
      FROM admins a
      JOIN admin_roles r ON a.role_id = r.id
      WHERE a.id = $1
    `, [req.admin.id]);

    if (!rows[0]) return res.status(404).json({ error: 'Admin not found.' });

    const { rows: perms } = await query(
      'SELECT resource, can_view, can_create, can_edit, can_delete, can_approve FROM admin_permissions WHERE role_id=(SELECT role_id FROM admins WHERE id=$1)',
      [req.admin.id]
    );
    const permissions: Record<string, any> = {};
    perms.forEach(p => { permissions[p.resource] = p; });

    res.json({ admin: { ...rows[0], permissions } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get profile.' });
  }
};

// ── Create admin (Super Admin only) ──────────────────────────────────────────
exports.createAdmin = async (req, res) => {
  try {
    const { full_name, phone, password, role_name, email } = req.body;

    if (!full_name || !phone || !password || !role_name) {
      return res.status(400).json({ error: 'full_name, phone, password and role_name are required.' });
    }

    // Get role
    const { rows: roleRows } = await query('SELECT id FROM admin_roles WHERE name=$1', [role_name]);
    if (!roleRows[0]) return res.status(400).json({ error: `Role '${role_name}' not found.` });

    const existing = await query('SELECT id FROM admins WHERE phone=$1', [phone]);
    if (existing.rows.length > 0) return res.status(409).json({ error: 'Phone already registered as admin.' });

    const passwordHash = await bcrypt.hash(password, 12);
    const { rows } = await query(`
      INSERT INTO admins (full_name, phone, email, password_hash, role_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING id, full_name, phone, role_id
    `, [full_name, phone, email || null, passwordHash, roleRows[0].id, req.admin.id]);

    // Log
    await query(
      `INSERT INTO admin_activity_logs (admin_id,action,resource_type,resource_id,description,ip_address)
       VALUES ($1,'create_admin','admin',$2,$3,$4)`,
      [req.admin.id, rows[0].id, `Created admin: ${full_name} (${role_name})`, req.ip]
    );

    logger.info(`Admin created: ${full_name} by ${req.admin.full_name}`);
    res.status(201).json({ message: `Admin account created for ${full_name}.`, admin: rows[0] });
  } catch (err) {
    logger.error('createAdmin error:', err.message);
    res.status(500).json({ error: err.message });
  }
};

// ── List all admins ───────────────────────────────────────────────────────────
exports.listAdmins = async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT a.id, a.full_name, a.phone, a.email, a.is_active, a.is_suspended,
             a.last_login_at, a.last_login_ip, a.created_at,
             r.name as role, r.label as role_label, r.color as role_color,
             cb.full_name as created_by_name
      FROM admins a
      JOIN admin_roles r ON a.role_id = r.id
      LEFT JOIN admins cb ON a.created_by = cb.id
      ORDER BY a.created_at DESC
    `);
    res.json({ admins: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Update admin ──────────────────────────────────────────────────────────────
exports.updateAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const { full_name, email, role_name, new_password } = req.body;

    const updates: string[] = [];
    const args: any[]       = [];

    if (full_name) { args.push(full_name); updates.push(`full_name=$${args.length}`); }
    if (email)     { args.push(email);     updates.push(`email=$${args.length}`); }
    if (role_name) {
      const { rows: rr } = await query('SELECT id FROM admin_roles WHERE name=$1', [role_name]);
      if (!rr[0]) return res.status(400).json({ error: 'Invalid role.' });
      args.push(rr[0].id); updates.push(`role_id=$${args.length}`);
    }
    if (new_password) {
      const hash = await bcrypt.hash(new_password, 12);
      args.push(hash); updates.push(`password_hash=$${args.length}`);
    }
    if (!updates.length) return res.status(400).json({ error: 'No fields to update.' });

    updates.push('updated_at=NOW()');
    args.push(id);
    await query(`UPDATE admins SET ${updates.join(',')} WHERE id=$${args.length}`, args);

    await query(
      `INSERT INTO admin_activity_logs (admin_id,action,resource_type,resource_id,description,ip_address)
       VALUES ($1,'update_admin','admin',$2,$3,$4)`,
      [req.admin.id, id, `Updated admin ${id}`, req.ip]
    );

    res.json({ message: 'Admin updated.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Suspend / activate ────────────────────────────────────────────────────────
exports.suspendAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    if (id === req.admin.id) return res.status(400).json({ error: 'Cannot suspend yourself.' });

    await query('UPDATE admins SET is_suspended=true, suspension_reason=$1, updated_at=NOW() WHERE id=$2', [reason, id]);
    await query(
      `INSERT INTO admin_activity_logs (admin_id,action,resource_type,resource_id,description,ip_address)
       VALUES ($1,'suspend_admin','admin',$2,$3,$4)`,
      [req.admin.id, id, `Suspended admin. Reason: ${reason}`, req.ip]
    );
    res.json({ message: 'Admin suspended.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.activateAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    await query('UPDATE admins SET is_suspended=false, suspension_reason=null, failed_attempts=0, locked_until=null, updated_at=NOW() WHERE id=$1', [id]);
    await query(
      `INSERT INTO admin_activity_logs (admin_id,action,resource_type,resource_id,description,ip_address)
       VALUES ($1,'activate_admin','admin',$2,'Admin account activated',$3)`,
      [req.admin.id, id, req.ip]
    );
    res.json({ message: 'Admin activated.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Delete admin ──────────────────────────────────────────────────────────────
exports.deleteAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    if (id === req.admin.id) return res.status(400).json({ error: 'Cannot delete yourself.' });

    const { rows } = await query('SELECT full_name FROM admins WHERE id=$1', [id]);
    if (!rows[0]) return res.status(404).json({ error: 'Admin not found.' });

    await query('DELETE FROM admins WHERE id=$1', [id]);
    await query(
      `INSERT INTO admin_activity_logs (admin_id,action,resource_type,description,ip_address)
       VALUES ($1,'delete_admin','admin',$2,$3)`,
      [req.admin.id, `Deleted admin: ${rows[0].full_name}`, req.ip]
    );
    res.json({ message: `Admin ${rows[0].full_name} deleted.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Activity logs ─────────────────────────────────────────────────────────────
exports.getActivityLogs = async (req, res) => {
  try {
    const { admin_id, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let sql = `
      SELECT l.*, a.full_name as admin_name, a.phone as admin_phone,
             r.label as admin_role
      FROM admin_activity_logs l
      JOIN admins a ON l.admin_id = a.id
      JOIN admin_roles r ON a.role_id = r.id
      WHERE 1=1
    `;
    const args: any[] = [];
    if (admin_id) { args.push(admin_id); sql += ` AND l.admin_id=$${args.length}`; }
    sql += ` ORDER BY l.created_at DESC LIMIT ${Math.min(parseInt(limit), 100)} OFFSET ${offset}`;

    const { rows } = await query(sql, args);
    const count    = await query('SELECT COUNT(*) FROM admin_activity_logs' + (admin_id ? ` WHERE admin_id='${admin_id}'` : ''));

    res.json({ logs: rows, total: parseInt(count.rows[0].count) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Get roles ─────────────────────────────────────────────────────────────────
exports.getRoles = async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT r.*, COUNT(a.id) as admin_count
      FROM admin_roles r
      LEFT JOIN admins a ON a.role_id = r.id AND a.is_active = true
      GROUP BY r.id ORDER BY r.created_at
    `);
    res.json({ roles: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

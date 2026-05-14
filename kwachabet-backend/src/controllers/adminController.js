const { query, withTransaction } = require('../config/database');
const { generateId } = require('../utils/helpers');
const smsService = require('../services/sms/smsService');
const logger = require('../utils/logger');

// ── Dashboard stats ───────────────────────────────────────────────────────────
exports.getDashboard = async (req, res) => {
  try {
    const today = new Date(); today.setHours(0,0,0,0);

    const [users, newToday, activeTickets, depositsToday, withdrawalsToday,
           pendingWd, fraudFlags, totalBalance] = await Promise.all([
      query('SELECT COUNT(*) FROM users'),
      query('SELECT COUNT(*) FROM users WHERE created_at >= $1', [today]),
      query("SELECT COUNT(*) FROM tickets WHERE status='pending'"),
      query("SELECT COALESCE(SUM(amount),0) as s FROM transactions WHERE type='deposit' AND created_at >= $1 AND status='completed'", [today]),
      query("SELECT COALESCE(SUM(ABS(amount)),0) as s FROM transactions WHERE type='withdrawal' AND created_at >= $1 AND status='completed'", [today]),
      query("SELECT COUNT(*) FROM withdrawals WHERE status IN ('pending','flagged')"),
      query("SELECT COUNT(*) FROM fraud_flags WHERE resolved = false"),
      query('SELECT COALESCE(SUM(balance),0) as s FROM wallets'),
    ]);

    res.json({
      users:   { total: parseInt(users.rows[0].count), new_today: parseInt(newToday.rows[0].count) },
      bets:    { active_tickets: parseInt(activeTickets.rows[0].count) },
      finance: {
        deposits_today:      parseFloat(depositsToday.rows[0].s),
        withdrawals_today:   parseFloat(withdrawalsToday.rows[0].s),
        pending_withdrawals: parseInt(pendingWd.rows[0].count),
        total_wallet_balance:parseFloat(totalBalance.rows[0].s),
      },
      fraud: { open_flags: parseInt(fraudFlags.rows[0].count) },
    });
  } catch (err) {
    logger.error('getDashboard:', err.message);
    res.status(500).json({ error: 'Could not load stats.' });
  }
};

// ── List users ────────────────────────────────────────────────────────────────
exports.listUsers = async (req, res) => {
  try {
    const { search, risk_min, page = 1, limit = 30 } = req.query;
    let sql    = `SELECT u.id,u.phone,u.full_name,u.risk_score,u.is_suspended,u.is_verified,u.created_at,
                         w.balance, w.bonus_balance
                  FROM users u LEFT JOIN wallets w ON w.user_id = u.id WHERE 1=1`;
    const args = [];

    if (search) {
      args.push(`%${search}%`);
      sql += ` AND (u.phone ILIKE $${args.length} OR u.full_name ILIKE $${args.length})`;
    }
    if (risk_min) {
      args.push(parseInt(risk_min));
      sql += ` AND u.risk_score >= $${args.length}`;
    }
    sql += ' ORDER BY u.created_at DESC LIMIT $' + (args.length + 1) + ' OFFSET $' + (args.length + 2);
    args.push(Math.min(parseInt(limit), 100), (parseInt(page) - 1) * parseInt(limit));

    const { rows } = await query(sql, args);
    const count    = await query('SELECT COUNT(*) FROM users');
    res.json({ users: rows, total: parseInt(count.rows[0].count), page: parseInt(page) });
  } catch (err) {
    res.status(500).json({ error: 'Could not load users.' });
  }
};

// ── Suspend / unsuspend ───────────────────────────────────────────────────────
exports.suspendUser = async (req, res) => {
  try {
    const { reason } = req.body;
    await query('UPDATE users SET is_suspended=true, suspension_reason=$1 WHERE id=$2', [reason, req.params.id]);
    const { rows } = await query('SELECT phone FROM users WHERE id=$1', [req.params.id]);
    await smsService.sendSMS(rows[0]?.phone, 'KwachaBet: Your account has been suspended. Contact support@kwachabet.mw');
    res.json({ message: 'User suspended.' });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
};

exports.unsuspendUser = async (req, res) => {
  try {
    await query('UPDATE users SET is_suspended=false, suspension_reason=null WHERE id=$1', [req.params.id]);
    res.json({ message: 'User unsuspended.' });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
};

// ── List tickets ──────────────────────────────────────────────────────────────
exports.listTickets = async (req, res) => {
  try {
    const { status, page = 1, limit = 30 } = req.query;
    let sql    = `SELECT t.*, u.phone as user_phone, u.full_name as user_name
                  FROM tickets t JOIN users u ON t.user_id = u.id WHERE 1=1`;
    const args = [];
    if (status) { args.push(status); sql += ` AND t.status = $${args.length}`; }
    sql += ` ORDER BY t.created_at DESC LIMIT ${Math.min(parseInt(limit), 100)} OFFSET ${(parseInt(page)-1)*parseInt(limit)}`;

    const { rows } = await query(sql, args);
    const count    = await query('SELECT COUNT(*) FROM tickets' + (status ? ` WHERE status='${status}'` : ''));
    res.json({ tickets: rows, total: parseInt(count.rows[0].count) });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
};

// ── Pending withdrawals ───────────────────────────────────────────────────────
exports.pendingWithdrawals = async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT w.*, u.phone as user_phone, u.full_name as user_name, u.risk_score
      FROM withdrawals w JOIN users u ON w.user_id = u.id
      WHERE w.status IN ('pending','flagged','manual_review')
      ORDER BY w.created_at ASC
    `);
    res.json({ withdrawals: rows });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
};

// ── Approve withdrawal ────────────────────────────────────────────────────────
exports.approveWithdrawal = async (req, res) => {
  try {
    await withTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM withdrawals WHERE id=$1 FOR UPDATE', [req.params.id]);
      const wd = rows[0];
      if (!wd) throw new Error('Not found');

      await client.query(
        'UPDATE withdrawals SET status=$1, approved_by=$2, approved_at=NOW() WHERE id=$3',
        ['completed', req.user.id, wd.id]
      );

      // Debit wallet and release lock
      await client.query(
        'UPDATE wallets SET balance = GREATEST(0, balance - $1), locked_amount = GREATEST(0, locked_amount - $1), updated_at=NOW() WHERE user_id=$2',
        [wd.amount, wd.user_id]
      );

      const { rows: uRows } = await client.query('SELECT phone FROM users WHERE id=$1', [wd.user_id]);
      await smsService.sendWithdrawalUpdate(uRows[0].phone, wd.amount, 'completed');
    });
    res.json({ message: 'Withdrawal approved.' });
  } catch (err) {
    logger.error('approveWithdrawal:', err.message);
    res.status(500).json({ error: 'Failed.' });
  }
};

// ── Reject withdrawal ─────────────────────────────────────────────────────────
exports.rejectWithdrawal = async (req, res) => {
  try {
    const { reason } = req.body;
    const { rows } = await query('SELECT * FROM withdrawals WHERE id=$1', [req.params.id]);
    const wd = rows[0];
    if (!wd) return res.status(404).json({ error: 'Not found.' });

    await query('UPDATE withdrawals SET status=$1, admin_notes=$2 WHERE id=$3', ['cancelled', reason, wd.id]);
    await query('UPDATE wallets SET locked_amount = GREATEST(0, locked_amount - $1) WHERE user_id=$2', [wd.amount, wd.user_id]);
    res.json({ message: 'Withdrawal rejected and funds released.' });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
};

// ── Fraud dashboard ───────────────────────────────────────────────────────────
exports.fraudDashboard = async (req, res) => {
  try {
    const { rows: flags } = await query(`
      SELECT f.*, u.phone, u.full_name, u.risk_score
      FROM fraud_flags f JOIN users u ON f.user_id = u.id
      WHERE f.resolved = false ORDER BY f.created_at DESC LIMIT 50
    `);
    const { rows: highRisk } = await query(
      'SELECT id, phone, full_name, risk_score FROM users WHERE risk_score >= 60 ORDER BY risk_score DESC LIMIT 20'
    );
    const { rows: pending } = await query("SELECT COUNT(*) FROM withdrawals WHERE status='flagged'");

    res.json({ flags: { rows: flags }, suspiciousUsers: highRisk, pendingWithdrawals: parseInt(pending.rows[0].count) });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
};

// ── Resolve fraud flag ────────────────────────────────────────────────────────
exports.resolveFraudFlag = async (req, res) => {
  try {
    const { notes } = req.body;
    await query('UPDATE fraud_flags SET resolved=true, resolved_by=$1, resolved_at=NOW(), admin_notes=$2 WHERE id=$3',
      [req.user.id, notes, req.params.id]);
    res.json({ message: 'Flag resolved.' });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
};

// ── Campaigns ─────────────────────────────────────────────────────────────────
exports.listCampaigns = async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM bonus_campaigns ORDER BY created_at DESC');
    res.json({ campaigns: rows });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
};

exports.assignFreeBet = async (req, res) => {
  try {
    const { user_id, amount, expiry_days = 7 } = req.body;
    const expiresAt = new Date(Date.now() + expiry_days * 24 * 60 * 60 * 1000);

    await withTransaction(async (client) => {
      await client.query(
        'INSERT INTO user_bonuses (user_id,type,bonus_amount,required_wager,expires_at) VALUES ($1,$2,$3,$4,$5)',
        [user_id, 'free_bet', amount, amount, expiresAt]
      );
      await client.query('UPDATE wallets SET bonus_balance = bonus_balance + $1 WHERE user_id=$2', [amount, user_id]);
    });

    res.status(201).json({ message: 'Free bet assigned.' });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
};

// ── Transactions ──────────────────────────────────────────────────────────────
exports.listTransactions = async (req, res) => {
  try {
    const { type, page = 1, limit = 30 } = req.query;
    let sql    = `SELECT t.*, u.phone as user_phone, u.full_name as user_name
                  FROM transactions t JOIN users u ON t.user_id = u.id WHERE 1=1`;
    const args = [];
    if (type) { args.push(type); sql += ` AND t.type = $${args.length}`; }
    sql += ` ORDER BY t.created_at DESC LIMIT ${Math.min(parseInt(limit), 100)} OFFSET ${(parseInt(page)-1)*parseInt(limit)}`;

    const { rows } = await query(sql, args);
    const count    = await query('SELECT COUNT(*) FROM transactions' + (type ? ` WHERE type='${type}'` : ''));
    res.json({ transactions: rows, total: parseInt(count.rows[0].count) });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
};

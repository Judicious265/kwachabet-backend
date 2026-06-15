/**
 * RBAC Admin Routes
 * Add to your backend src/routes/index.js
 * These replace the existing adminRouter
 */

const express           = require('express');
const adminAuthCtrl     = require('../controllers/adminAuthController');
const adminCtrl         = require('../controllers/adminController');
const { authenticateAdmin, requireSuperAdmin, requirePermission, requireAnyRole, logAction } = require('../middleware/rbac');

// ── Admin Auth Router (no auth needed) ───────────────────────────────────────
const adminAuthRouter = express.Router();
adminAuthRouter.post('/login',   adminAuthCtrl.login);

// ── Admin Management Router (Super Admin only) ────────────────────────────────
const adminMgmtRouter = express.Router();
adminMgmtRouter.use(authenticateAdmin);
adminMgmtRouter.get('/me',                               adminAuthCtrl.getProfile);
adminMgmtRouter.get('/roles',                            adminAuthCtrl.getRoles);
adminMgmtRouter.get('/activity-logs',                    adminAuthCtrl.getActivityLogs);
adminMgmtRouter.get('/',          requireSuperAdmin,     adminAuthCtrl.listAdmins);
adminMgmtRouter.post('/',         requireSuperAdmin,     adminAuthCtrl.createAdmin);
adminMgmtRouter.patch('/:id',     requireSuperAdmin,     adminAuthCtrl.updateAdmin);
adminMgmtRouter.patch('/:id/suspend',   requireSuperAdmin, logAction('suspend_admin','admin',(req)=>`Suspended admin ${req.params.id}`), adminAuthCtrl.suspendAdmin);
adminMgmtRouter.patch('/:id/activate',  requireSuperAdmin, logAction('activate_admin','admin',(req)=>`Activated admin ${req.params.id}`), adminAuthCtrl.activateAdmin);
adminMgmtRouter.delete('/:id',    requireSuperAdmin,     adminAuthCtrl.deleteAdmin);

// ── Main Admin API Router (all roles, permission-based) ───────────────────────
const adminApiRouter = express.Router();
adminApiRouter.use(authenticateAdmin);

// Dashboard — all roles
adminApiRouter.get('/dashboard/stats',
  requirePermission('dashboard','can_view'),
  adminCtrl.getDashboard
);

// Customers — support, super_admin
adminApiRouter.get('/users',
  requirePermission('customers','can_view'),
  adminCtrl.listUsers
);
adminApiRouter.get('/users/:id',
  requirePermission('customers','can_view'),
  async (req, res) => {
    const { query } = require('../config/database');
    try {
      const { rows } = await query(`
        SELECT u.id,u.phone,u.full_name,u.email,u.is_suspended,u.risk_score,u.created_at,u.last_login_at,
               w.balance,w.bonus_balance
        FROM users u LEFT JOIN wallets w ON w.user_id=u.id
        WHERE u.id=$1
      `, [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'User not found.' });
      res.json({ user: rows[0] });
    } catch (err) { res.status(500).json({ error: err.message }); }
  }
);
adminApiRouter.patch('/users/:id/suspend',
  requirePermission('customers','can_edit'),
  logAction('suspend_user','user',(req)=>`Suspended user ${req.params.id}`),
  adminCtrl.suspendUser
);
adminApiRouter.patch('/users/:id/unsuspend',
  requirePermission('customers','can_edit'),
  logAction('unsuspend_user','user',(req)=>`Unsuspended user ${req.params.id}`),
  adminCtrl.unsuspendUser
);

// Bets — support, fraud_analyst, super_admin
adminApiRouter.get('/tickets',
  requirePermission('bets','can_view'),
  adminCtrl.listTickets
);
adminApiRouter.get('/transactions',
  requirePermission('payments','can_view'),
  adminCtrl.listTransactions
);

// Payments — support, finance_admin, super_admin
adminApiRouter.get('/withdrawals/pending',
  requirePermission('payments','can_view'),
  adminCtrl.pendingWithdrawals
);
adminApiRouter.patch('/withdrawals/:id/approve',
  requirePermission('payments','can_approve'),
  logAction('approve_withdrawal','withdrawal',(req)=>`Approved withdrawal ${req.params.id}`),
  adminCtrl.approveWithdrawal
);
adminApiRouter.patch('/withdrawals/:id/reject',
  requirePermission('payments','can_approve'),
  logAction('reject_withdrawal','withdrawal',(req,body)=>`Rejected withdrawal ${req.params.id}: ${req.body?.reason}`),
  adminCtrl.rejectWithdrawal
);

// Fraud — fraud_analyst, super_admin
adminApiRouter.get('/fraud/dashboard',
  requirePermission('fraud','can_view'),
  adminCtrl.fraudDashboard
);
adminApiRouter.patch('/fraud/flags/:id/resolve',
  requirePermission('fraud','can_edit'),
  logAction('resolve_fraud','fraud_flag',(req)=>`Resolved fraud flag ${req.params.id}`),
  adminCtrl.resolveFraudFlag
);
adminApiRouter.post('/fraud/flags/:id/notes',
  requirePermission('fraud','can_create'),
  async (req, res) => {
    const { query } = require('../config/database');
    try {
      await query(
        'INSERT INTO investigation_notes (flag_id,admin_id,note,action_taken) VALUES ($1,$2,$3,$4)',
        [req.params.id, req.admin.id, req.body.note, req.body.action_taken || null]
      );
      res.status(201).json({ message: 'Note added.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
  }
);
adminApiRouter.post('/fraud/flags/:userId/create',
  requirePermission('fraud','can_create'),
  async (req, res) => {
    const { query } = require('../config/database');
    const { generateId } = require('../utils/helpers');
    try {
      const { rule_code, severity = 'medium', description } = req.body;
      await query(
        'INSERT INTO fraud_flags (id,user_id,rule_code,severity,description) VALUES ($1,$2,$3,$4,$5)',
        [generateId(), req.params.userId, rule_code, severity, description]
      );
      res.status(201).json({ message: 'Fraud flag created.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
  }
);

// Sports — odds_manager, super_admin
adminApiRouter.get('/events',
  requirePermission('sports','can_view'),
  async (req, res) => {
    const { query } = require('../config/database');
    try {
      const { sport, status, page = 1, limit = 50 } = req.query;
      const offset = (parseInt(page)-1)*parseInt(limit);
      let sql = `SELECT e.*,json_agg(json_build_object('id',m.id,'market_type',m.market_type,'outcome',m.outcome,'odds',m.odds,'is_active',m.is_active)) FILTER (WHERE m.id IS NOT NULL) as markets FROM events e LEFT JOIN markets m ON m.event_id=e.id WHERE 1=1`;
      const args = [];
      if (status && status !== 'all') { args.push(status); sql += ` AND e.status=$${args.length}`; }
      if (sport  && sport  !== 'all') { args.push(sport);  sql += ` AND e.sport_id=$${args.length}`; }
      sql += ` GROUP BY e.id ORDER BY e.commence_time ASC LIMIT ${Math.min(parseInt(limit),100)} OFFSET ${offset}`;
      const { rows } = await query(sql, args);
      let cSql = 'SELECT COUNT(*) FROM events WHERE 1=1';
      const cArgs = [];
      if (status && status !== 'all') { cArgs.push(status); cSql += ` AND status=$${cArgs.length}`; }
      if (sport  && sport  !== 'all') { cArgs.push(sport);  cSql += ` AND sport_id=$${cArgs.length}`; }
      const cnt = await query(cSql, cArgs);
      res.json({ events: rows, total: parseInt(cnt.rows[0].count) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  }
);
adminApiRouter.post('/events',
  requirePermission('sports','can_create'),
  logAction('create_event','event',(req)=>`Created match: ${req.body.home_team} vs ${req.body.away_team}`),
  async (req, res) => {
    const { pool, query } = require('../config/database');
    const { generateId } = require('../utils/helpers');
    try {
      const { home_team,away_team,league,sport_id='football',commence_time,odds_home,odds_draw,odds_away } = req.body;
      if (!home_team||!away_team||!commence_time) return res.status(400).json({ error: 'home_team, away_team, commence_time required.' });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const eventId = generateId();
        await client.query(`INSERT INTO events (id,external_id,sport_id,home_team,away_team,league,commence_time,status) VALUES ($1,$2,$3,$4,$5,$6,$7,'upcoming')`,
          [eventId,'manual_'+eventId,sport_id,home_team,away_team,league||'Local',new Date(commence_time)]);
        if (odds_home && parseFloat(odds_home)>1) await client.query(`INSERT INTO markets (id,event_id,market_type,outcome,odds,bookmaker,is_active,updated_at) VALUES ($1,$2,'h2h',$3,$4,'manual',true,NOW()) ON CONFLICT (event_id,market_type,outcome) DO UPDATE SET odds=EXCLUDED.odds,updated_at=NOW()`,[generateId(),eventId,home_team,parseFloat(odds_home)]);
        if (odds_draw && parseFloat(odds_draw)>1) await client.query(`INSERT INTO markets (id,event_id,market_type,outcome,odds,bookmaker,is_active,updated_at) VALUES ($1,$2,'h2h','Draw',$3,'manual',true,NOW()) ON CONFLICT (event_id,market_type,outcome) DO UPDATE SET odds=EXCLUDED.odds,updated_at=NOW()`,[generateId(),eventId,parseFloat(odds_draw)]);
        if (odds_away && parseFloat(odds_away)>1) await client.query(`INSERT INTO markets (id,event_id,market_type,outcome,odds,bookmaker,is_active,updated_at) VALUES ($1,$2,'h2h',$3,$4,'manual',true,NOW()) ON CONFLICT (event_id,market_type,outcome) DO UPDATE SET odds=EXCLUDED.odds,updated_at=NOW()`,[generateId(),eventId,away_team,parseFloat(odds_away)]);
        await client.query('COMMIT');
        if (global.broadcastOdds) {
          const upd = await query(`SELECT e.*,json_agg(json_build_object('id',m.id,'market_type',m.market_type,'outcome',m.outcome,'odds',m.odds)) FILTER (WHERE m.id IS NOT NULL) as markets FROM events e LEFT JOIN markets m ON m.event_id=e.id AND m.is_active=true WHERE e.status IN ('upcoming','live') GROUP BY e.id ORDER BY e.commence_time ASC LIMIT 100`);
          global.broadcastOdds({ type:'odds_update', events:upd.rows, timestamp:Date.now() });
        }
        res.status(201).json({ message:'Match created. Live on frontend now.', event_id:eventId });
      } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    } catch (err) { res.status(500).json({ error: err.message }); }
  }
);
adminApiRouter.patch('/events/:id/odds',
  requirePermission('sports','can_edit'),
  logAction('update_odds','event',(req)=>`Updated odds for event ${req.params.id}`),
  async (req, res) => {
    const { query } = require('../config/database');
    const { generateId } = require('../utils/helpers');
    try {
      const { id } = req.params;
      const { odds_home, odds_draw, odds_away } = req.body;
      const { rows: evRows } = await query('SELECT * FROM events WHERE id=$1',[id]);
      const ev = evRows[0];
      if (!ev) return res.status(404).json({ error:'Event not found.' });
      if (odds_home) await query(`INSERT INTO markets (id,event_id,market_type,outcome,odds,bookmaker,is_active,updated_at) VALUES ($1,$2,'h2h',$3,$4,'manual',true,NOW()) ON CONFLICT (event_id,market_type,outcome) DO UPDATE SET odds=EXCLUDED.odds,updated_at=NOW()`,[generateId(),id,ev.home_team,parseFloat(odds_home)]);
      if (odds_draw) await query(`INSERT INTO markets (id,event_id,market_type,outcome,odds,bookmaker,is_active,updated_at) VALUES ($1,$2,'h2h','Draw',$3,'manual',true,NOW()) ON CONFLICT (event_id,market_type,outcome) DO UPDATE SET odds=EXCLUDED.odds,updated_at=NOW()`,[generateId(),id,parseFloat(odds_draw)]);
      if (odds_away) await query(`INSERT INTO markets (id,event_id,market_type,outcome,odds,bookmaker,is_active,updated_at) VALUES ($1,$2,'h2h',$3,$4,'manual',true,NOW()) ON CONFLICT (event_id,market_type,outcome) DO UPDATE SET odds=EXCLUDED.odds,updated_at=NOW()`,[generateId(),id,ev.away_team,parseFloat(odds_away)]);
      if (global.broadcastOdds) {
        const upd = await query(`SELECT e.*,json_agg(json_build_object('id',m.id,'market_type',m.market_type,'outcome',m.outcome,'odds',m.odds)) FILTER (WHERE m.id IS NOT NULL) as markets FROM events e LEFT JOIN markets m ON m.event_id=e.id AND m.is_active=true WHERE e.status IN ('upcoming','live') GROUP BY e.id ORDER BY e.commence_time ASC LIMIT 100`);
        global.broadcastOdds({ type:'odds_update', events:upd.rows, timestamp:Date.now() });
      }
      res.json({ message:'Odds updated. Live on frontend instantly.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
  }
);
adminApiRouter.patch('/events/:id/suspend',
  requirePermission('sports','can_edit'),
  logAction('suspend_market','event',(req)=>`Suspended market for event ${req.params.id}`),
  async (req, res) => {
    const { query } = require('../config/database');
    try {
      const { suspend=true } = req.body;
      await query('UPDATE markets SET is_active=$1,updated_at=NOW() WHERE event_id=$2',[!suspend,req.params.id]);
      if (global.broadcastOdds) {
        const upd = await query(`SELECT e.*,json_agg(json_build_object('id',m.id,'market_type',m.market_type,'outcome',m.outcome,'odds',m.odds)) FILTER (WHERE m.id IS NOT NULL) as markets FROM events e LEFT JOIN markets m ON m.event_id=e.id AND m.is_active=true WHERE e.status IN ('upcoming','live') GROUP BY e.id ORDER BY e.commence_time ASC LIMIT 100`);
        global.broadcastOdds({ type:'odds_update', events:upd.rows, timestamp:Date.now() });
      }
      res.json({ message: suspend?'Market suspended.':'Market reopened.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
  }
);
adminApiRouter.patch('/events/:id/result',
  requirePermission('sports','can_edit'),
  logAction('set_result','event',(req)=>`Set result for event ${req.params.id}: ${req.body.result}`),
  async (req, res) => {
    const { query } = require('../config/database');
    try {
      const { id } = req.params;
      const { home_score,away_score,result } = req.body;
      if (!['home','draw','away'].includes(result)) return res.status(400).json({ error:'result must be home, draw, or away.' });
      await query(`UPDATE events SET home_score=$1,away_score=$2,result=$3,status='finished',updated_at=NOW() WHERE id=$4`,[home_score,away_score,result,id]);
      const { rows: evRows } = await query('SELECT * FROM events WHERE id=$1',[id]);
      const ev = evRows[0];
      const winner = result==='home'?ev.home_team:result==='away'?ev.away_team:'Draw';
      await query(`UPDATE ticket_selections SET status=CASE WHEN selection=$1 THEN 'won' ELSE 'lost' END,settled_at=NOW() WHERE event_id=$2 AND status='pending'`,[winner,id]);
      res.json({ message:'Result saved. Bets will settle in next cycle.', winner });
    } catch (err) { res.status(500).json({ error: err.message }); }
  }
);
adminApiRouter.delete('/events/:id',
  requirePermission('sports','can_delete'),
  logAction('delete_event','event',(req)=>`Deleted event ${req.params.id}`),
  async (req, res) => {
    const { query } = require('../config/database');
    try {
      const bets = await query("SELECT COUNT(*) FROM ticket_selections WHERE event_id=$1 AND status='pending'",[req.params.id]);
      if (parseInt(bets.rows[0].count)>0) return res.status(400).json({ error:'Cannot delete — pending bets exist. Suspend instead.' });
      await query('DELETE FROM markets WHERE event_id=$1',[req.params.id]);
      await query('DELETE FROM events WHERE id=$1',[req.params.id]);
      res.json({ message:'Event deleted.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
  }
);

// Bonus — super_admin
adminApiRouter.get('/bonus/campaigns',  requirePermission('settings','can_view'), adminCtrl.listCampaigns);
adminApiRouter.post('/bonus/free-bet',  requirePermission('settings','can_create'), adminCtrl.assignFreeBet);

// Tax — finance_admin, super_admin
adminApiRouter.get('/tax/summary', requirePermission('tax','can_view'), async (req, res) => {
  const { query } = require('../config/database');
  try {
    const today  = new Date(); today.setHours(0,0,0,0);
    const week   = new Date(Date.now()-7*24*3600*1000);
    const month  = new Date(today.getFullYear(),today.getMonth(),1);
    const year   = new Date(today.getFullYear(),0,1);
    const [daily,weekly,monthly,annual,total] = await Promise.all([
      query("SELECT COALESCE(SUM(tax_deducted),0) as total FROM tickets WHERE status='won' AND settled_at>=$1",[today]),
      query("SELECT COALESCE(SUM(tax_deducted),0) as total FROM tickets WHERE status='won' AND settled_at>=$1",[week]),
      query("SELECT COALESCE(SUM(tax_deducted),0) as total FROM tickets WHERE status='won' AND settled_at>=$1",[month]),
      query("SELECT COALESCE(SUM(tax_deducted),0) as total FROM tickets WHERE status='won' AND settled_at>=$1",[year]),
      query("SELECT COALESCE(SUM(tax_deducted),0) as total, COUNT(*) as count FROM tickets WHERE status='won'"),
    ]);
    res.json({
      daily:   parseFloat(daily.rows[0].total),
      weekly:  parseFloat(weekly.rows[0].total),
      monthly: parseFloat(monthly.rows[0].total),
      annual:  parseFloat(annual.rows[0].total),
      total:   parseFloat(total.rows[0].total),
      count:   parseInt(total.rows[0].count),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = { adminAuthRouter, adminMgmtRouter, adminApiRouter };

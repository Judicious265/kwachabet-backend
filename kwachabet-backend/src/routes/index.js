// ── Kwacha Bet - Complete Routes File ─────────────────────────────────────────
// src/routes/index.js

const express = require('express');
const { authenticate, requireAdmin, requirePin } = require('../middleware/auth');
const authCtrl    = require('../controllers/authController');
const walletCtrl  = require('../controllers/walletController');
const bettingCtrl = require('../controllers/bettingController');
const oddsCtrl    = require('../controllers/oddsController');
const adminCtrl   = require('../controllers/adminController');

// ── Auth Router ───────────────────────────────────────────────────────────────
const authRouter = express.Router();
authRouter.post('/register/initiate', authCtrl.initiateRegister);
authRouter.post('/register/verify',   authCtrl.verifyRegister);
authRouter.post('/login',             authCtrl.login);
authRouter.post('/pin/set',           authenticate, authCtrl.setPin);
authRouter.post('/pin/verify',        authenticate, authCtrl.verifyPin);
authRouter.post('/otp/withdrawal',    authenticate, authCtrl.requestWithdrawalOTP);

// ── Users Router ──────────────────────────────────────────────────────────────
const usersRouter = express.Router();
usersRouter.use(authenticate);
usersRouter.get('/me', async (req, res) => {
  try {
    const { query } = require('../config/database');
    const { rows } = await query(
      'SELECT id,phone,full_name,referral_code,is_admin,risk_score,created_at FROM users WHERE id=$1',
      [req.user.id]
    );
    res.json({ user: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// ── Wallet Router ─────────────────────────────────────────────────────────────
const walletRouter = express.Router();
walletRouter.use(authenticate);
walletRouter.get('/balance',      walletCtrl.getBalance);
walletRouter.get('/transactions', walletCtrl.getTransactions);
walletRouter.post('/deposit',     walletCtrl.initiateDeposit);
walletRouter.post('/withdraw',    requirePin, walletCtrl.requestWithdrawal);

// ── Betting Router ────────────────────────────────────────────────────────────
const bettingRouter = express.Router();
bettingRouter.get('/check/:code', bettingCtrl.checkTicket); // public
bettingRouter.use(authenticate);
bettingRouter.post('/place',        bettingCtrl.placeBet);
bettingRouter.get('/tickets',       bettingCtrl.getTickets);
bettingRouter.get('/tickets/:code', bettingCtrl.getTicket);

// ── Odds Router ───────────────────────────────────────────────────────────────
const oddsRouter = express.Router();
oddsRouter.get('/events',   oddsCtrl.getEvents);
oddsRouter.get('/featured', oddsCtrl.getFeatured);
oddsRouter.get('/sports',   oddsCtrl.getSports);

// ── Payments Router ───────────────────────────────────────────────────────────
const paymentsRouter = express.Router();
paymentsRouter.use(authenticate);
paymentsRouter.get('/', (req, res) => res.json({ message: 'Payment endpoints active' }));

// ── Bonus Router ──────────────────────────────────────────────────────────────
const bonusRouter = express.Router();
bonusRouter.use(authenticate);
bonusRouter.get('/', async (req, res) => {
  try {
    const { query } = require('../config/database');
    const { rows } = await query(
      "SELECT * FROM user_bonuses WHERE user_id=$1 AND status='active'",
      [req.user.id]
    );
    res.json({ bonuses: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get bonuses' });
  }
});

// ── Admin Router ──────────────────────────────────────────────────────────────
const adminRouter = express.Router();
adminRouter.use(authenticate, requireAdmin);

// Dashboard
adminRouter.get('/dashboard/stats', adminCtrl.getDashboard);

// Users
adminRouter.get('/users',                  adminCtrl.listUsers);
adminRouter.patch('/users/:id/suspend',    adminCtrl.suspendUser);
adminRouter.patch('/users/:id/unsuspend',  adminCtrl.unsuspendUser);

// Tickets
adminRouter.get('/tickets', adminCtrl.listTickets);

// Transactions
adminRouter.get('/transactions', adminCtrl.listTransactions);

// Withdrawals
adminRouter.get('/withdrawals/pending',       adminCtrl.pendingWithdrawals);
adminRouter.patch('/withdrawals/:id/approve', adminCtrl.approveWithdrawal);
adminRouter.patch('/withdrawals/:id/reject',  adminCtrl.rejectWithdrawal);

// Fraud
adminRouter.get('/fraud/dashboard',            adminCtrl.fraudDashboard);
adminRouter.patch('/fraud/flags/:id/resolve',  adminCtrl.resolveFraudFlag);

// Bonus
adminRouter.get('/bonus/campaigns',  adminCtrl.listCampaigns);
adminRouter.post('/bonus/free-bet',  adminCtrl.assignFreeBet);

// ── Admin Sports Routes (production) ─────────────────────────────────────────
// These power the Sports & Odds Management page in the admin dashboard
// Any change here instantly broadcasts to the live frontend via WebSocket

// GET /api/v1/admin/events
adminRouter.get('/events', async (req, res) => {
  try {
    const { query } = require('../config/database');
    const { sport, status, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let sql = `
      SELECT e.*,
        json_agg(
          json_build_object(
            'id', m.id,
            'market_type', m.market_type,
            'outcome', m.outcome,
            'odds', m.odds,
            'is_active', m.is_active
          )
        ) FILTER (WHERE m.id IS NOT NULL) as markets
      FROM events e
      LEFT JOIN markets m ON m.event_id = e.id
      WHERE 1=1
    `;
    const args = [];

    if (status && status !== 'all') {
      args.push(status);
      sql += ` AND e.status = $${args.length}`;
    }
    if (sport && sport !== 'all') {
      args.push(sport);
      sql += ` AND e.sport_id = $${args.length}`;
    }

    sql += ` GROUP BY e.id ORDER BY e.commence_time ASC`;
    sql += ` LIMIT ${Math.min(parseInt(limit), 100)} OFFSET ${offset}`;

    const { rows } = await query(sql, args);

    let countSql = 'SELECT COUNT(*) FROM events WHERE 1=1';
    const countArgs = [];
    if (status && status !== 'all') { countArgs.push(status); countSql += ` AND status = $${countArgs.length}`; }
    if (sport && sport !== 'all')   { countArgs.push(sport);  countSql += ` AND sport_id = $${countArgs.length}`; }
    const countRes = await query(countSql, countArgs);

    res.json({ events: rows, total: parseInt(countRes.rows[0].count) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/admin/events — create local match
adminRouter.post('/events', async (req, res) => {
  const { pool } = require('../config/database');
  const { generateId } = require('../utils/helpers');
  const { query } = require('../config/database');
  try {
    const { home_team, away_team, league, sport_id = 'football', commence_time, odds_home, odds_draw, odds_away } = req.body;

    if (!home_team || !away_team || !commence_time) {
      return res.status(400).json({ error: 'home_team, away_team and commence_time are required' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const eventId    = generateId();
      const externalId = 'manual_' + eventId;

      await client.query(`
        INSERT INTO events (id, external_id, sport_id, home_team, away_team, league, commence_time, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'upcoming')
      `, [eventId, externalId, sport_id, home_team, away_team, league || 'Local', new Date(commence_time)]);

      if (odds_home && parseFloat(odds_home) > 1) {
        await client.query(`INSERT INTO markets (id,event_id,market_type,outcome,odds,bookmaker,is_active,updated_at) VALUES ($1,$2,'h2h',$3,$4,'manual',true,NOW()) ON CONFLICT (event_id,market_type,outcome) DO UPDATE SET odds=EXCLUDED.odds,updated_at=NOW()`,
          [generateId(), eventId, home_team, parseFloat(odds_home)]);
      }
      if (odds_draw && parseFloat(odds_draw) > 1) {
        await client.query(`INSERT INTO markets (id,event_id,market_type,outcome,odds,bookmaker,is_active,updated_at) VALUES ($1,$2,'h2h','Draw',$3,'manual',true,NOW()) ON CONFLICT (event_id,market_type,outcome) DO UPDATE SET odds=EXCLUDED.odds,updated_at=NOW()`,
          [generateId(), eventId, parseFloat(odds_draw)]);
      }
      if (odds_away && parseFloat(odds_away) > 1) {
        await client.query(`INSERT INTO markets (id,event_id,market_type,outcome,odds,bookmaker,is_active,updated_at) VALUES ($1,$2,'h2h',$3,$4,'manual',true,NOW()) ON CONFLICT (event_id,market_type,outcome) DO UPDATE SET odds=EXCLUDED.odds,updated_at=NOW()`,
          [generateId(), eventId, away_team, parseFloat(odds_away)]);
      }

      await client.query('COMMIT');

      // Broadcast to frontend instantly
      if (global.broadcastOdds) {
        const updated = await query(`SELECT e.*,json_agg(json_build_object('id',m.id,'market_type',m.market_type,'outcome',m.outcome,'odds',m.odds)) FILTER (WHERE m.id IS NOT NULL) as markets FROM events e LEFT JOIN markets m ON m.event_id=e.id AND m.is_active=true WHERE e.status IN ('upcoming','live') GROUP BY e.id ORDER BY e.commence_time ASC LIMIT 100`);
        global.broadcastOdds({ type: 'odds_update', events: updated.rows, timestamp: Date.now() });
      }

      res.status(201).json({ message: 'Match created. Live on frontend now.', event_id: eventId });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/v1/admin/events/:id/odds — update odds
adminRouter.patch('/events/:id/odds', async (req, res) => {
  try {
    const { query } = require('../config/database');
    const { generateId } = require('../utils/helpers');
    const { id } = req.params;
    const { odds_home, odds_draw, odds_away } = req.body;

    const { rows: evRows } = await query('SELECT * FROM events WHERE id=$1', [id]);
    const ev = evRows[0];
    if (!ev) return res.status(404).json({ error: 'Event not found' });

    if (odds_home) await query(`INSERT INTO markets (id,event_id,market_type,outcome,odds,bookmaker,is_active,updated_at) VALUES ($1,$2,'h2h',$3,$4,'manual',true,NOW()) ON CONFLICT (event_id,market_type,outcome) DO UPDATE SET odds=EXCLUDED.odds,updated_at=NOW()`, [generateId(), id, ev.home_team, parseFloat(odds_home)]);
    if (odds_draw) await query(`INSERT INTO markets (id,event_id,market_type,outcome,odds,bookmaker,is_active,updated_at) VALUES ($1,$2,'h2h','Draw',$3,'manual',true,NOW()) ON CONFLICT (event_id,market_type,outcome) DO UPDATE SET odds=EXCLUDED.odds,updated_at=NOW()`, [generateId(), id, parseFloat(odds_draw)]);
    if (odds_away) await query(`INSERT INTO markets (id,event_id,market_type,outcome,odds,bookmaker,is_active,updated_at) VALUES ($1,$2,'h2h',$3,$4,'manual',true,NOW()) ON CONFLICT (event_id,market_type,outcome) DO UPDATE SET odds=EXCLUDED.odds,updated_at=NOW()`, [generateId(), id, ev.away_team, parseFloat(odds_away)]);

    if (global.broadcastOdds) {
      const updated = await query(`SELECT e.*,json_agg(json_build_object('id',m.id,'market_type',m.market_type,'outcome',m.outcome,'odds',m.odds)) FILTER (WHERE m.id IS NOT NULL) as markets FROM events e LEFT JOIN markets m ON m.event_id=e.id AND m.is_active=true WHERE e.status IN ('upcoming','live') GROUP BY e.id ORDER BY e.commence_time ASC LIMIT 100`);
      global.broadcastOdds({ type: 'odds_update', events: updated.rows, timestamp: Date.now() });
    }

    res.json({ message: 'Odds updated. Live on frontend instantly.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/v1/admin/events/:id/suspend — suspend or reopen market
adminRouter.patch('/events/:id/suspend', async (req, res) => {
  try {
    const { query } = require('../config/database');
    const { id } = req.params;
    const { suspend = true } = req.body;

    await query('UPDATE markets SET is_active=$1, updated_at=NOW() WHERE event_id=$2', [!suspend, id]);

    if (global.broadcastOdds) {
      const updated = await query(`SELECT e.*,json_agg(json_build_object('id',m.id,'market_type',m.market_type,'outcome',m.outcome,'odds',m.odds)) FILTER (WHERE m.id IS NOT NULL) as markets FROM events e LEFT JOIN markets m ON m.event_id=e.id AND m.is_active=true WHERE e.status IN ('upcoming','live') GROUP BY e.id ORDER BY e.commence_time ASC LIMIT 100`);
      global.broadcastOdds({ type: 'odds_update', events: updated.rows, timestamp: Date.now() });
    }

    res.json({ message: suspend ? 'Market suspended. Hidden from frontend.' : 'Market reopened. Live on frontend.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/v1/admin/events/:id/result — set result and settle bets
adminRouter.patch('/events/:id/result', async (req, res) => {
  try {
    const { query } = require('../config/database');
    const { id } = req.params;
    const { home_score, away_score, result } = req.body;

    if (!result || !['home','draw','away'].includes(result)) {
      return res.status(400).json({ error: 'result must be home, draw, or away' });
    }

    await query(`UPDATE events SET home_score=$1,away_score=$2,result=$3,status='finished',updated_at=NOW() WHERE id=$4`,
      [home_score, away_score, result, id]);

    const { rows: evRows } = await query('SELECT * FROM events WHERE id=$1', [id]);
    const ev = evRows[0];
    const winningOutcome = result === 'home' ? ev.home_team : result === 'away' ? ev.away_team : 'Draw';

    await query(`UPDATE ticket_selections SET status=CASE WHEN selection=$1 THEN 'won' ELSE 'lost' END, settled_at=NOW() WHERE event_id=$2 AND status='pending'`,
      [winningOutcome, id]);

    res.json({ message: 'Result saved. Bets will be settled in next cycle.', winner: winningOutcome });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/v1/admin/events/:id — delete manual event
adminRouter.delete('/events/:id', async (req, res) => {
  try {
    const { query } = require('../config/database');
    const { id } = req.params;

    const bets = await query("SELECT COUNT(*) FROM ticket_selections WHERE event_id=$1 AND status='pending'", [id]);
    if (parseInt(bets.rows[0].count) > 0) {
      return res.status(400).json({ error: 'Cannot delete — there are pending bets. Suspend it instead.' });
    }

    await query('DELETE FROM markets WHERE event_id=$1', [id]);
    await query('DELETE FROM events WHERE id=$1', [id]);
    res.json({ message: 'Event deleted.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Webhook Router ────────────────────────────────────────────────────────────
const webhookRouter = require('./webhooks');

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  authRouter,
  usersRouter,
  walletRouter,
  bettingRouter,
  oddsRouter,
  paymentsRouter,
  adminRouter,
  bonusRouter,
  webhookRouter,
};

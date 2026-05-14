// ── Auth Routes ───────────────────────────────────────────────────────────────
const express = require('express');
const { authenticate, requireAdmin, requirePin } = require('../middleware/auth');
const authCtrl    = require('../controllers/authController');
const walletCtrl  = require('../controllers/walletController');
const bettingCtrl = require('../controllers/bettingController');
const oddsCtrl    = require('../controllers/oddsController');
const adminCtrl   = require('../controllers/adminController');

// ── Auth ──────────────────────────────────────────────────────────────────────
const authRouter = express.Router();
authRouter.post('/register/initiate', authCtrl.initiateRegister);
authRouter.post('/register/verify',   authCtrl.verifyRegister);
authRouter.post('/login',             authCtrl.login);
authRouter.post('/pin/set',           authenticate, authCtrl.setPin);
authRouter.post('/pin/verify',        authenticate, authCtrl.verifyPin);
authRouter.post('/otp/withdrawal',    authenticate, authCtrl.requestWithdrawalOTP);

// ── Users ─────────────────────────────────────────────────────────────────────
const usersRouter = express.Router();
usersRouter.use(authenticate);
usersRouter.get('/me', async (req, res) => {
  const { query } = require('../config/database');
  const { rows } = await query(
    'SELECT id,phone,full_name,referral_code,is_admin,risk_score,created_at FROM users WHERE id=$1',
    [req.user.id]
  );
  res.json({ user: rows[0] });
});

// ── Wallet ────────────────────────────────────────────────────────────────────
const walletRouter = express.Router();
walletRouter.use(authenticate);
walletRouter.get('/balance',       walletCtrl.getBalance);
walletRouter.get('/transactions',  walletCtrl.getTransactions);
walletRouter.post('/deposit',      walletCtrl.initiateDeposit);
walletRouter.post('/withdraw', requirePin, walletCtrl.requestWithdrawal);

// ── Betting ───────────────────────────────────────────────────────────────────
const bettingRouter = express.Router();
bettingRouter.get('/check/:code',  bettingCtrl.checkTicket); // public
bettingRouter.use(authenticate);
bettingRouter.post('/place',       bettingCtrl.placeBet);
bettingRouter.get('/tickets',      bettingCtrl.getTickets);
bettingRouter.get('/tickets/:code',bettingCtrl.getTicket);

// ── Odds ──────────────────────────────────────────────────────────────────────
const oddsRouter = express.Router();
oddsRouter.get('/events',   oddsCtrl.getEvents);
oddsRouter.get('/featured', oddsCtrl.getFeatured);
oddsRouter.get('/sports',   oddsCtrl.getSports);

// ── Payments ──────────────────────────────────────────────────────────────────
const paymentsRouter = express.Router();
paymentsRouter.use(authenticate);
paymentsRouter.get('/', (req, res) => res.json({ message: 'Payment endpoints' }));

// ── Admin ─────────────────────────────────────────────────────────────────────
const adminRouter = express.Router();
adminRouter.use(authenticate, requireAdmin);
adminRouter.get('/dashboard/stats',          adminCtrl.getDashboard);
adminRouter.get('/users',                    adminCtrl.listUsers);
adminRouter.patch('/users/:id/suspend',      adminCtrl.suspendUser);
adminRouter.patch('/users/:id/unsuspend',    adminCtrl.unsuspendUser);
adminRouter.get('/tickets',                  adminCtrl.listTickets);
adminRouter.get('/transactions',             adminCtrl.listTransactions);
adminRouter.get('/withdrawals/pending',      adminCtrl.pendingWithdrawals);
adminRouter.patch('/withdrawals/:id/approve',adminCtrl.approveWithdrawal);
adminRouter.patch('/withdrawals/:id/reject', adminCtrl.rejectWithdrawal);
adminRouter.get('/fraud/dashboard',          adminCtrl.fraudDashboard);
adminRouter.patch('/fraud/flags/:id/resolve',adminCtrl.resolveFraudFlag);
adminRouter.get('/bonus/campaigns',          adminCtrl.listCampaigns);
adminRouter.post('/bonus/free-bet',          adminCtrl.assignFreeBet);

// ── Bonus ─────────────────────────────────────────────────────────────────────
const bonusRouter = express.Router();
bonusRouter.use(authenticate);
bonusRouter.get('/', async (req, res) => {
  const { query } = require('../config/database');
  const { rows } = await query(
    'SELECT * FROM user_bonuses WHERE user_id=$1 AND status=$2',
    [req.user.id, 'active']
  );
  res.json({ bonuses: rows });
});

// ── Webhooks ──────────────────────────────────────────────────────────────────
const webhookRouter = express.Router();
const logger = require('../utils/logger');

webhookRouter.post('/paychangu', async (req, res) => {
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    logger.info('Webhook received:', body?.event);

    if (body?.event === 'charge.completed' && body?.data?.status === 'successful') {
      const { query } = require('../config/database');
      const txRef = body.data.tx_ref;
      const amount = parseFloat(body.data.amount);

      const { rows } = await query('SELECT * FROM deposits WHERE id=$1 AND status=$2', [txRef, 'pending']);
      if (rows[0]) {
        await walletCtrl.creditWallet(txRef, amount, body.data.flw_ref || txRef);
      }
    }

    res.json({ received: true });
  } catch (err) {
    logger.error('Webhook error:', err.message);
    res.status(500).json({ error: 'Webhook failed' });
  }
});

// Demo: manually credit wallet (remove in production)
webhookRouter.post('/demo/credit', authenticate, async (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'Not found' });
  try {
    const { amount = 10000 } = req.body;
    const { query } = require('../config/database');
    const { generateId } = require('../utils/helpers');

    const { rows: wRows } = await query('SELECT * FROM wallets WHERE user_id=$1', [req.user.id]);
    const wallet = wRows[0];
    const balBefore = parseFloat(wallet.balance);
    const newBal    = balBefore + parseFloat(amount);

    await query('UPDATE wallets SET balance=$1 WHERE user_id=$2', [newBal, req.user.id]);
    await query(
      'INSERT INTO transactions (id,user_id,wallet_id,type,amount,balance_before,balance_after,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [generateId(), req.user.id, wallet.id, 'deposit', amount, balBefore, newBal, 'completed']
    );
    res.json({ message: `Demo: MWK ${amount} credited`, new_balance: newBal });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = { authRouter, usersRouter, walletRouter, bettingRouter, oddsRouter, paymentsRouter, adminRouter, bonusRouter, webhookRouter };

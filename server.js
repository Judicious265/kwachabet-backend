// server.js - KWACHA BET Main API Server
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const cron    = require('node-cron');
const axios   = require('axios');
require('dotenv').config();

const { db, stmts, initSchema } = require('./db');
const { injectDemoMatches, fetchRealOdds, simulateOddsDrift, simulateLiveScores } = require('./sportsData');

// =====================================================
// STARTUP
// =====================================================
initSchema();
injectDemoMatches();

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'kwachabet_change_this_secret_2024';

// =====================================================
// MIDDLEWARE
// =====================================================
app.use(helmet({ crossOriginEmbedderPolicy: false }));
app.use(express.json());
app.use(cors({
  origin: '*',
  credentials: true,
}));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 500 });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: { error: 'Too many attempts. Try again later.' } });
app.use('/api/', limiter);
app.use('/api/auth/', authLimiter);

// =====================================================
// AUTH MIDDLEWARE
// =====================================================
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = stmts.getUserById.get(decoded.userId);
    if (!user || user.status === 'banned') return res.status(401).json({ error: 'Account not found or banned' });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token. Please log in again.' });
  }
}

function adminAuth(req, res, next) {
  auth(req, res, function() {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    next();
  });
}

// =====================================================
// PHONE VALIDATION (Malawi only)
// =====================================================
function validPhone(p) {
  const c = p.replace(/[\s\-\(\)]/g, '');
  return /^\+265(88|99)\d{7}$/.test(c) || /^0(88|99)\d{7}$/.test(c);
}

function normPhone(p) {
  const c = p.replace(/[\s\-\(\)]/g, '');
  return c.startsWith('0') ? '+265' + c.slice(1) : c;
}

function pubUser(u) {
  return {
    id: u.id, name: u.name, phone: u.phone,
    balance: u.balance, bonus_balance: u.bonus_balance,
    status: u.status, role: u.role,
    total_deposited: u.total_deposited,
    total_withdrawn: u.total_withdrawn,
    total_winnings: u.total_winnings,
    bets_count: u.bets_count,
    created_at: u.created_at,
    last_login: u.last_login,
  };
}

// =====================================================
// AUTH ROUTES
// =====================================================
app.post('/api/auth/register', async function(req, res) {
  try {
    const { name, phone, pin } = req.body;
    if (!name || !phone || !pin) return res.status(400).json({ error: 'Name, phone and PIN are required' });
    if (!/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'PIN must be exactly 4 digits' });
    if (!validPhone(phone)) return res.status(400).json({ error: 'Enter a valid Malawian number (+265 88x or +265 99x)' });

    const norm = normPhone(phone);
    if (stmts.getUserByPhone.get(norm)) return res.status(409).json({ error: 'An account already exists for this number' });

    const pinHash = await bcrypt.hash(pin, 10);
    const userId = uuidv4();
    const bonus = 2000;

    stmts.createUser.run(userId, name.trim(), norm, pinHash, bonus, 0);
    stmts.createTransaction.run(uuidv4(), userId, 'bonus', bonus, bonus, 'Welcome Bonus', 'KWACHA BET', null, 'completed');

    const token = jwt.sign({ userId: userId }, JWT_SECRET, { expiresIn: '30d' });
    const user = stmts.getUserById.get(userId);
    res.status(201).json({ message: 'Account created successfully', token: token, user: pubUser(user) });
  } catch (err) {
    console.error('[Register]', err);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

app.post('/api/auth/login', async function(req, res) {
  try {
    const { phone, pin } = req.body;
    if (!phone || !pin) return res.status(400).json({ error: 'Phone and PIN are required' });
    if (!validPhone(phone)) return res.status(400).json({ error: 'Invalid Malawian phone number' });

    const norm = normPhone(phone);
    const user = stmts.getUserByPhone.get(norm);
    if (!user) return res.status(401).json({ error: 'No account found for this number. Please register.' });
    if (user.status === 'banned') return res.status(403).json({ error: 'Account suspended. Contact support.' });

    const valid = await bcrypt.compare(pin, user.pin_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect PIN. Please try again.' });

    stmts.updateLastLogin.run(user.id);
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ message: 'Login successful', token: token, user: pubUser(user) });
  } catch (err) {
    console.error('[Login]', err);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

app.get('/api/auth/me', auth, function(req, res) {
  const user = stmts.getUserById.get(req.user.id);
  res.json({ user: pubUser(user) });
});

// =====================================================
// MATCH ROUTES
// =====================================================
app.get('/api/matches', auth, function(req, res) {
  try {
    const { sport, status } = req.query;
    let query = `
      SELECT m.*, l.name as league_name, l.country, l.priority, s.name as sport_name
      FROM matches m
      JOIN leagues l ON m.league_id = l.id
      JOIN sports s ON m.sport_id = s.id
      WHERE m.match_date >= datetime('now', '-3 hours')
    `;
    const params = [];
    if (status) { query += ' AND m.status = ?'; params.push(status); }
    else { query += " AND m.status IN ('upcoming','live')"; }
    if (sport) { query += ' AND m.sport_id = ?'; params.push(sport); }
    query += ' ORDER BY l.priority DESC, m.match_date ASC LIMIT 200';
    const matches = db.prepare(query).all(...params);
    res.json({ matches: matches, count: matches.length, updated_at: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch matches' });
  }
});

app.get('/api/matches/live', auth, function(req, res) {
  try {
    res.json({ matches: stmts.getLiveMatches.all() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch live matches' });
  }
});

app.get('/api/matches/:id', auth, function(req, res) {
  const match = db.prepare('SELECT m.*,l.name as league_name,s.name as sport_name FROM matches m JOIN leagues l ON m.league_id=l.id JOIN sports s ON m.sport_id=s.id WHERE m.id=?').get(req.params.id);
  if (!match) return res.status(404).json({ error: 'Match not found' });
  res.json({ match: match });
});

app.get('/api/sports', auth, function(req, res) {
  const sports = db.prepare("SELECT s.*,COUNT(m.id) as match_count FROM sports s LEFT JOIN matches m ON m.sport_id=s.id AND m.status IN ('upcoming','live') WHERE s.active=1 GROUP BY s.id ORDER BY s.name").all();
  res.json({ sports: sports });
});

// =====================================================
// BET ROUTES
// =====================================================
app.post('/api/bets', auth, function(req, res) {
  try {
    const { stake, selections } = req.body;
    if (!stake || stake < 100) return res.status(400).json({ error: 'Minimum stake is MWK 100' });
    if (!selections || !selections.length) return res.status(400).json({ error: 'No selections provided' });
    if (selections.length > 20) return res.status(400).json({ error: 'Maximum 20 selections per bet' });

    const user = stmts.getUserById.get(req.user.id);
    if (user.balance < stake) return res.status(400).json({ error: 'Insufficient balance. Please deposit.' });

    // Validate each selection
    const enriched = [];
    for (const sel of selections) {
      const match = stmts.getMatchById.get(sel.match_id);
      if (!match) return res.status(400).json({ error: 'Match not found: ' + sel.match_id });
      if (match.status === 'finished') return res.status(400).json({ error: match.home_team + ' vs ' + match.away_team + ' has already finished' });
      if (!['home', 'draw', 'away'].includes(sel.selection)) return res.status(400).json({ error: 'Selection must be home, draw, or away' });
      if (sel.selection === 'draw' && !match.odds_draw) return res.status(400).json({ error: 'Draw not available for ' + match.home_team + ' vs ' + match.away_team });

      const currOdd = sel.selection === 'home' ? match.odds_home : sel.selection === 'away' ? match.odds_away : match.odds_draw;
      // Allow small odds drift but reject big changes (anti-abuse)
      if (Math.abs(currOdd - sel.odds) > 0.8) {
        return res.status(409).json({
          error: 'Odds have changed for ' + match.home_team + ' vs ' + match.away_team + '. Please check new odds.',
          current_odds: { home: match.odds_home, draw: match.odds_draw, away: match.odds_away },
        });
      }
      enriched.push({ sel: sel, match: match, odd: currOdd });
    }

    const totalOdds = enriched.reduce(function(a, e) { return a * e.odd; }, 1);
    const potentialWin = +(stake * totalOdds).toFixed(2);
    const betId = uuidv4();
    const betType = selections.length === 1 ? 'single' : 'accumulator';

    const placeTx = db.transaction(function() {
      stmts.createBet.run(betId, user.id, stake, +totalOdds.toFixed(4), potentialWin, betType, selections.length);
      enriched.forEach(function(e) {
        stmts.createBetLeg.run(uuidv4(), betId, e.match.id, e.sel.selection, e.odd);
      });
      stmts.updateBalance.run(user.balance - stake, user.id);
      stmts.updateUserStats.run(0, 0, 0, stake, 1, user.id);
      stmts.createTransaction.run(
        uuidv4(), user.id, 'bet', -stake, user.balance - stake,
        'Bet #' + betId.slice(0, 8) + ' (' + selections.length + ' selection' + (selections.length > 1 ? 's' : '') + ')',
        'Account', betId, 'completed'
      );
    });
    placeTx();

    res.status(201).json({
      message: 'Bet placed successfully',
      bet: { id: betId, stake: stake, total_odds: +totalOdds.toFixed(4), potential_win: potentialWin, status: 'open', bet_type: betType, legs_count: selections.length, placed_at: new Date().toISOString() },
      new_balance: user.balance - stake,
    });
  } catch (err) {
    console.error('[PlaceBet]', err);
    res.status(500).json({ error: 'Failed to place bet. Please try again.' });
  }
});

app.get('/api/bets', auth, function(req, res) {
  try {
    const { status } = req.query;
    let bets = stmts.getUserBets.all(req.user.id).map(function(b) {
      return Object.assign({}, b, { legs: JSON.parse(b.legs || '[]') });
    });
    if (status && status !== 'all') {
      bets = bets.filter(function(b) { return status === 'open' ? b.status === 'open' : b.status !== 'open'; });
    }
    res.json({ bets: bets, count: bets.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch bets' });
  }
});

// =====================================================
// WALLET ROUTES
// =====================================================
app.get('/api/wallet', auth, function(req, res) {
  try {
    const user = stmts.getUserById.get(req.user.id);
    const txs = stmts.getUserTransactions.all(req.user.id);
    res.json({
      balance: user.balance,
      bonus_balance: user.bonus_balance,
      total_deposited: user.total_deposited,
      total_withdrawn: user.total_withdrawn,
      total_winnings: user.total_winnings,
      transactions: txs,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch wallet' });
  }
});

app.post('/api/wallet/deposit', auth, async function(req, res) {
  try {
    const { amount, method } = req.body;
    if (!amount || amount < 500) return res.status(400).json({ error: 'Minimum deposit is MWK 500' });
    if (!['airtel', 'mpamba', 'paychangu', 'bank'].includes(method)) return res.status(400).json({ error: 'Invalid payment method' });

    const user = stmts.getUserById.get(req.user.id);
    const payId = uuidv4();
    const ref = 'KB-DEP-' + Date.now();

    // If Paychangu is configured, call their API
    const pgKey = process.env.PAYCHANGU_SECRET_KEY;
    if (pgKey && pgKey !== 'your_paychangu_secret_key') {
      try {
        const pgRes = await axios.post((process.env.PAYCHANGU_BASE_URL || 'https://api.paychangu.com') + '/payment', {
          amount: amount, currency: 'MWK',
          email: req.user.phone.replace('+', '') + '@kwachabet.mw',
          first_name: user.name.split(' ')[0],
          last_name: user.name.split(' ')[1] || '',
          callback_url: (process.env.PAYMENT_CALLBACK_URL || 'https://yourapp.railway.app/api/payments/callback') + '?pid=' + payId,
          return_url: (process.env.FRONTEND_URL || 'https://yoursite.github.io') + '?deposit=success',
          tx_ref: ref,
          customization: { title: 'KWACHA BET Deposit', description: 'Deposit MWK ' + amount },
        }, { headers: { Authorization: 'Bearer ' + pgKey } });
        stmts.createPayment.run(payId, user.id, 'deposit', amount, method, user.phone, ref);
        return res.json({ payment_id: payId, redirect_url: pgRes.data.data && pgRes.data.data.link, reference: ref, message: 'Redirecting to payment page...' });
      } catch (pgErr) {
        console.error('[Paychangu]', pgErr.message);
      }
    }

    // Demo mode: credit immediately
    const newBal = user.balance + amount;
    stmts.updateBalance.run(newBal, user.id);
    stmts.updateUserStats.run(amount, 0, 0, 0, 0, user.id);
    stmts.createTransaction.run(uuidv4(), user.id, 'deposit', amount, newBal,
      'Deposit via ' + (method === 'airtel' ? 'Airtel Money' : method === 'mpamba' ? 'Mpamba (TNM)' : method),
      method, ref, 'completed');
    stmts.createPayment.run(payId, user.id, 'deposit', amount, method, user.phone, ref);

    res.json({ message: 'MWK ' + amount.toLocaleString() + ' deposited successfully', new_balance: newBal, reference: ref });
  } catch (err) {
    console.error('[Deposit]', err);
    res.status(500).json({ error: 'Deposit failed. Please try again.' });
  }
});

app.post('/api/wallet/withdraw', auth, async function(req, res) {
  try {
    const { amount, method, pin } = req.body;
    if (!amount || amount < 500) return res.status(400).json({ error: 'Minimum withdrawal is MWK 500' });
    if (!pin) return res.status(400).json({ error: 'PIN is required to withdraw' });

    const user = stmts.getUserById.get(req.user.id);
    const pinOk = await bcrypt.compare(pin, user.pin_hash);
    if (!pinOk) return res.status(401).json({ error: 'Incorrect PIN. Withdrawal denied.' });
    if (user.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });

    const ref = 'KB-WIT-' + Date.now();
    const newBal = user.balance - amount;
    stmts.updateBalance.run(newBal, user.id);
    stmts.updateUserStats.run(0, amount, 0, 0, 0, user.id);
    stmts.createTransaction.run(uuidv4(), user.id, 'withdrawal', -amount, newBal,
      'Withdrawal to ' + (method === 'airtel' ? 'Airtel Money' : method === 'mpamba' ? 'Mpamba (TNM)' : method),
      method, ref, 'completed');
    stmts.createPayment.run(uuidv4(), user.id, 'withdrawal', amount, method, user.phone, ref);

    res.json({ message: 'MWK ' + amount.toLocaleString() + ' withdrawal submitted. Arriving in your ' + method + ' shortly.', reference: ref, new_balance: newBal });
  } catch (err) {
    console.error('[Withdraw]', err);
    res.status(500).json({ error: 'Withdrawal failed. Please try again.' });
  }
});

// Paychangu payment callback
app.post('/api/payments/callback', function(req, res) {
  try {
    const data = req.body;
    const pid = req.query.pid;
    if (data.status === 'success' && pid) {
      const pay = db.prepare('SELECT * FROM payments WHERE id=?').get(pid);
      if (pay && pay.status === 'pending' && pay.type === 'deposit') {
        db.prepare("UPDATE payments SET status='completed',updated_at=datetime('now') WHERE id=?").run(pid);
        const user = stmts.getUserById.get(pay.user_id);
        if (user) {
          const newBal = user.balance + pay.amount;
          stmts.updateBalance.run(newBal, user.id);
          stmts.updateUserStats.run(pay.amount, 0, 0, 0, 0, user.id);
          stmts.createTransaction.run(uuidv4(), user.id, 'deposit', pay.amount, newBal,
            'Deposit via ' + pay.method + ' (confirmed)', pay.method, pid, 'completed');
        }
      }
    }
    res.json({ received: true });
  } catch (err) {
    res.status(400).json({ error: 'Invalid payload' });
  }
});

// =====================================================
// ADMIN ROUTES
// =====================================================
app.get('/api/admin/stats', adminAuth, function(req, res) {
  res.json({ stats: stmts.getPlatformStats.get() });
});

app.get('/api/admin/users', adminAuth, function(req, res) {
  res.json({ users: stmts.getAllUsers.all() });
});

app.get('/api/admin/transactions', adminAuth, function(req, res) {
  res.json({ transactions: stmts.getAllTransactions.all() });
});

app.patch('/api/admin/users/:id/status', adminAuth, function(req, res) {
  const { status } = req.body;
  if (!['active', 'banned', 'suspended'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  db.prepare('UPDATE users SET status=? WHERE id=?').run(status, req.params.id);
  res.json({ message: 'User status updated to ' + status });
});

app.patch('/api/admin/users/:id/role', adminAuth, function(req, res) {
  const { role } = req.body;
  if (!['admin', 'customer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  db.prepare('UPDATE users SET role=? WHERE id=?').run(role, req.params.id);
  res.json({ message: 'User role updated to ' + role });
});

// =====================================================
// HEALTH CHECK
// =====================================================
app.get('/api/health', function(req, res) {
  res.json({ status: 'ok', service: 'KWACHA BET API', version: '2.0.0', timestamp: new Date().toISOString() });
});

// =====================================================
// SCHEDULED JOBS
// =====================================================
// Odds drift every 15 seconds
cron.schedule('*/15 * * * * *', simulateOddsDrift);

// Live score simulation every 30 seconds
cron.schedule('*/30 * * * * *', simulateLiveScores);

// Fetch real odds every 10 minutes
cron.schedule('*/10 * * * *', fetchRealOdds);

// =====================================================
// START SERVER
// =====================================================
app.listen(PORT, function() {
  console.log('');
  console.log('  KWACHA BET API running on port ' + PORT);
  console.log('  Health: http://localhost:' + PORT + '/api/health');
  console.log('');
  // Initial odds fetch after 5 seconds
  setTimeout(fetchRealOdds, 5000);
});

module.exports = app;

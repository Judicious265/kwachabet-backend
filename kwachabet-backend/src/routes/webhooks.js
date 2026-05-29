const express = require('express');
const router  = express.Router();
const logger  = require('../utils/logger');

// ── PayChangu webhook ─────────────────────────────────────────────────────────
router.post('/paychangu', async (req, res) => {
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    logger.info('Webhook received:', body?.event);

    if (body?.event === 'charge.completed' && body?.data?.status === 'successful') {
      const { query } = require('../config/database');
      const walletCtrl = require('../controllers/walletController');
      const txRef  = body.data.tx_ref;
      const amount = parseFloat(body.data.amount);
      const { rows } = await query(
        'SELECT * FROM deposits WHERE id=$1 AND status=$2', [txRef, 'pending']
      );
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

// ── ONE-TIME DATABASE SETUP ───────────────────────────────────────────────────
// Visit: https://kwachabet-backend.onrender.com
// This creates all tables. Safe to run multiple times (uses IF NOT EXISTS)
router.get('/setup-db', async (req, res) => {
  const { pool } = require('../config/database');
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        phone VARCHAR(15) UNIQUE NOT NULL,
        email VARCHAR(255),
        full_name VARCHAR(255) NOT NULL,
        date_of_birth DATE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        pin_hash VARCHAR(255),
        referral_code VARCHAR(10) UNIQUE NOT NULL,
        referred_by UUID REFERENCES users(id),
        is_verified BOOLEAN DEFAULT TRUE,
        is_active BOOLEAN DEFAULT TRUE,
        is_suspended BOOLEAN DEFAULT FALSE,
        is_admin BOOLEAN DEFAULT FALSE,
        suspension_reason TEXT,
        risk_score SMALLINT DEFAULT 0,
        last_login_at TIMESTAMPTZ,
        last_login_ip TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS wallets (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        balance NUMERIC(18,2) DEFAULT 0 CHECK (balance >= 0),
        bonus_balance NUMERIC(18,2) DEFAULT 0 CHECK (bonus_balance >= 0),
        locked_amount NUMERIC(18,2) DEFAULT 0,
        currency CHAR(3) DEFAULT 'MWK',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id),
        wallet_id UUID REFERENCES wallets(id),
        type VARCHAR(30) NOT NULL,
        amount NUMERIC(18,2) NOT NULL,
        balance_before NUMERIC(18,2) DEFAULT 0,
        balance_after NUMERIC(18,2) DEFAULT 0,
        reference VARCHAR(100),
        payment_method VARCHAR(30),
        status VARCHAR(20) DEFAULT 'completed',
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS deposits (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id),
        transaction_id UUID REFERENCES transactions(id),
        amount NUMERIC(18,2) NOT NULL,
        payment_method VARCHAR(30) NOT NULL,
        provider_ref VARCHAR(100),
        phone_used VARCHAR(15),
        status VARCHAR(20) DEFAULT 'pending',
        checkout_url TEXT,
        webhook_data JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS withdrawals (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id),
        transaction_id UUID REFERENCES transactions(id),
        amount NUMERIC(18,2) NOT NULL,
        payment_method VARCHAR(30) NOT NULL,
        destination VARCHAR(20) NOT NULL,
        status VARCHAR(30) DEFAULT 'pending',
        is_auto BOOLEAN DEFAULT TRUE,
        approved_by UUID REFERENCES users(id),
        approved_at TIMESTAMPTZ,
        fraud_score SMALLINT DEFAULT 0,
        admin_notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sports (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        is_active BOOLEAN DEFAULT TRUE
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS events (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        external_id VARCHAR(100) UNIQUE,
        sport_id VARCHAR(50) REFERENCES sports(id),
        home_team VARCHAR(200) NOT NULL,
        away_team VARCHAR(200) NOT NULL,
        league VARCHAR(200),
        commence_time TIMESTAMPTZ NOT NULL,
        status VARCHAR(20) DEFAULT 'upcoming',
        home_score SMALLINT,
        away_score SMALLINT,
        result VARCHAR(10),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS markets (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        market_type VARCHAR(50) NOT NULL,
        outcome VARCHAR(100) NOT NULL,
        odds NUMERIC(8,3) NOT NULL CHECK (odds > 1),
        bookmaker VARCHAR(50),
        is_active BOOLEAN DEFAULT TRUE,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_markets_unique
      ON markets(event_id, market_type, outcome);
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS tickets (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id),
        ticket_code VARCHAR(20) UNIQUE NOT NULL,
        type VARCHAR(20) DEFAULT 'single',
        stake NUMERIC(18,2) NOT NULL,
        bonus_stake NUMERIC(18,2) DEFAULT 0,
        total_odds NUMERIC(10,3) NOT NULL,
        potential_win NUMERIC(18,2) NOT NULL,
        actual_win NUMERIC(18,2),
        tax_deducted NUMERIC(18,2) DEFAULT 0,
        status VARCHAR(20) DEFAULT 'pending',
        is_live BOOLEAN DEFAULT FALSE,
        settled_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS ticket_selections (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        event_id UUID NOT NULL REFERENCES events(id),
        market_id UUID REFERENCES markets(id),
        market_type VARCHAR(50) NOT NULL,
        selection VARCHAR(100) NOT NULL,
        odds NUMERIC(8,3) NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        settled_at TIMESTAMPTZ
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS fraud_flags (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id),
        rule_code VARCHAR(50) NOT NULL,
        severity VARCHAR(10) DEFAULT 'medium',
        description TEXT,
        metadata JSONB DEFAULT '{}',
        resolved BOOLEAN DEFAULT FALSE,
        resolved_by UUID REFERENCES users(id),
        resolved_at TIMESTAMPTZ,
        admin_notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS bonus_campaigns (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name VARCHAR(100) NOT NULL,
        type VARCHAR(30) NOT NULL,
        percent NUMERIC(5,2),
        amount NUMERIC(18,2),
        max_bonus NUMERIC(18,2),
        min_deposit NUMERIC(18,2) DEFAULT 500,
        wagering_req NUMERIC(5,2) DEFAULT 5,
        min_odds NUMERIC(5,2) DEFAULT 1.5,
        expiry_days SMALLINT DEFAULT 30,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_bonuses (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id),
        campaign_id UUID REFERENCES bonus_campaigns(id),
        type VARCHAR(30) NOT NULL,
        bonus_amount NUMERIC(18,2) NOT NULL,
        wagered_amount NUMERIC(18,2) DEFAULT 0,
        required_wager NUMERIC(18,2) NOT NULL,
        status VARCHAR(20) DEFAULT 'active',
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS referrals (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        referrer_id UUID NOT NULL REFERENCES users(id),
        referred_id UUID UNIQUE NOT NULL REFERENCES users(id),
        status VARCHAR(20) DEFAULT 'pending',
        reward_amount NUMERIC(18,2),
        rewarded_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS otp_codes (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        phone VARCHAR(15) NOT NULL,
        code_hash VARCHAR(255) NOT NULL,
        purpose VARCHAR(30) NOT NULL,
        attempts SMALLINT DEFAULT 0,
        is_used BOOLEAN DEFAULT FALSE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
      CREATE INDEX IF NOT EXISTS idx_wallets_user ON wallets(user_id);
      CREATE INDEX IF NOT EXISTS idx_txn_user ON transactions(user_id);
      CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets(user_id);
      CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
      CREATE INDEX IF NOT EXISTS idx_markets_event ON markets(event_id);
    `);

    await pool.query(`
      INSERT INTO sports (id, name) VALUES
        ('football','Football'),
        ('basketball','Basketball'),
        ('tennis','Tennis'),
        ('ice_hockey','Ice Hockey'),
        ('baseball','Baseball'),
        ('rugby_league','Rugby League')
      ON CONFLICT (id) DO NOTHING;
    `);

    await pool.query(`
      INSERT INTO bonus_campaigns
        (name, type, percent, max_bonus, min_deposit, wagering_req, min_odds, expiry_days, is_active)
      VALUES
        ('100% Welcome Bonus','welcome',100,50000,500,5,1.5,30,true)
      ON CONFLICT DO NOTHING;
    `);

    // Verify tables were created
    const { rows } = await pool.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename;
    `);

    const tables = rows.map(r => r.tablename);
    logger.info('Database setup complete. Tables:', tables.join(', '));

    res.json({
      success: true,
      message: 'Database setup complete! All tables created.',
      tables: tables,
      next_steps: [
        '1. Register an account on your frontend',
        '2. Make yourself admin using the /webhooks/make-admin endpoint',
        '3. Remove this setup endpoint from production when done'
      ]
    });
  } catch (err) {
    logger.error('Setup error:', err.message);
    res.status(500).json({
      success: false,
      error: err.message,
      hint: 'Check if DATABASE_URL is set correctly'
    });
  }
});

// ── Make user admin ───────────────────────────────────────────────────────────
router.get('/make-admin', async (req, res) => {
  const { phone, secret } = req.query;
  
  // Safety check - require a secret so random people can't use this
  if (secret !== 'kwachabet2024') {
    return res.status(403).json({ error: 'Invalid secret' });
  }
  
  if (!phone) return res.status(400).json({ error: 'Add ?phone=+265998337818&secret=kwachabet2024' });
  
  try {
    const { pool } = require('../config/database');
    
    // First check if user exists
    const check = await pool.query('SELECT id, phone, full_name, is_admin FROM users WHERE phone = $1', [phone]);
    
    if (check.rows.length === 0) {
      // List all users to help debug
      const all = await pool.query('SELECT phone, full_name, created_at FROM users ORDER BY created_at DESC LIMIT 10');
      return res.status(404).json({ 
        error: 'User not found',
        hint: 'Check the phone number format exactly as stored',
        registered_numbers: all.rows.map(r => r.phone),
        total_users: all.rows.length
      });
    }
    
    await pool.query('UPDATE users SET is_admin = true WHERE phone = $1', [phone]);
    
    res.json({
      success: true,
      message: `Admin granted to ${check.rows[0].full_name}`,
      user: { id: check.rows[0].id, phone: check.rows[0].phone, full_name: check.rows[0].full_name }
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Demo credit (development only) ────────────────────────────────────────────
router.post('/demo/credit', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }
  res.json({ message: 'Demo credit disabled in production' });
});

module.exports = router;

-- ============================================================
-- KWACHA BET - PostgreSQL Schema
-- Run this ONCE in your Render PostgreSQL query tool
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Users ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone           VARCHAR(15) UNIQUE NOT NULL,
  email           VARCHAR(255),
  full_name       VARCHAR(255) NOT NULL,
  date_of_birth   DATE NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  pin_hash        VARCHAR(255),
  referral_code   VARCHAR(10) UNIQUE NOT NULL,
  referred_by     UUID REFERENCES users(id),
  is_verified     BOOLEAN DEFAULT TRUE,
  is_active       BOOLEAN DEFAULT TRUE,
  is_suspended    BOOLEAN DEFAULT FALSE,
  is_admin        BOOLEAN DEFAULT FALSE,
  suspension_reason TEXT,
  risk_score      SMALLINT DEFAULT 0,
  last_login_at   TIMESTAMPTZ,
  last_login_ip   TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Wallets ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wallets (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  balance         NUMERIC(18,2) DEFAULT 0 CHECK (balance >= 0),
  bonus_balance   NUMERIC(18,2) DEFAULT 0 CHECK (bonus_balance >= 0),
  locked_amount   NUMERIC(18,2) DEFAULT 0,
  currency        CHAR(3) DEFAULT 'MWK',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Transactions ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id),
  wallet_id       UUID REFERENCES wallets(id),
  type            VARCHAR(30) NOT NULL,
  amount          NUMERIC(18,2) NOT NULL,
  balance_before  NUMERIC(18,2) DEFAULT 0,
  balance_after   NUMERIC(18,2) DEFAULT 0,
  reference       VARCHAR(100),
  payment_method  VARCHAR(30),
  status          VARCHAR(20) DEFAULT 'completed',
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Deposits ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deposits (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id),
  transaction_id  UUID REFERENCES transactions(id),
  amount          NUMERIC(18,2) NOT NULL,
  payment_method  VARCHAR(30) NOT NULL,
  provider_ref    VARCHAR(100),
  phone_used      VARCHAR(15),
  status          VARCHAR(20) DEFAULT 'pending',
  checkout_url    TEXT,
  webhook_data    JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Withdrawals ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS withdrawals (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id),
  transaction_id  UUID REFERENCES transactions(id),
  amount          NUMERIC(18,2) NOT NULL,
  payment_method  VARCHAR(30) NOT NULL,
  destination     VARCHAR(20) NOT NULL,
  status          VARCHAR(30) DEFAULT 'pending',
  is_auto         BOOLEAN DEFAULT TRUE,
  approved_by     UUID REFERENCES users(id),
  approved_at     TIMESTAMPTZ,
  fraud_score     SMALLINT DEFAULT 0,
  admin_notes     TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Sports & Events ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sports (
  id        VARCHAR(50) PRIMARY KEY,
  name      VARCHAR(100) NOT NULL,
  is_active BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS events (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  external_id     VARCHAR(100) UNIQUE,
  sport_id        VARCHAR(50) REFERENCES sports(id),
  home_team       VARCHAR(200) NOT NULL,
  away_team       VARCHAR(200) NOT NULL,
  league          VARCHAR(200),
  commence_time   TIMESTAMPTZ NOT NULL,
  status          VARCHAR(20) DEFAULT 'upcoming',
  home_score      SMALLINT,
  away_score      SMALLINT,
  result          VARCHAR(10),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS markets (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_id    UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  market_type VARCHAR(50) NOT NULL,
  outcome     VARCHAR(100) NOT NULL,
  odds        NUMERIC(8,3) NOT NULL CHECK (odds > 1),
  bookmaker   VARCHAR(50),
  is_active   BOOLEAN DEFAULT TRUE,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Tickets ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tickets (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id),
  ticket_code     VARCHAR(20) UNIQUE NOT NULL,
  type            VARCHAR(20) DEFAULT 'single',
  stake           NUMERIC(18,2) NOT NULL,
  bonus_stake     NUMERIC(18,2) DEFAULT 0,
  total_odds      NUMERIC(10,3) NOT NULL,
  potential_win   NUMERIC(18,2) NOT NULL,
  actual_win      NUMERIC(18,2),
  tax_deducted    NUMERIC(18,2) DEFAULT 0,
  status          VARCHAR(20) DEFAULT 'pending',
  is_live         BOOLEAN DEFAULT FALSE,
  settled_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ticket_selections (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ticket_id   UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  event_id    UUID NOT NULL REFERENCES events(id),
  market_id   UUID REFERENCES markets(id),
  market_type VARCHAR(50) NOT NULL,
  selection   VARCHAR(100) NOT NULL,
  odds        NUMERIC(8,3) NOT NULL,
  status      VARCHAR(20) DEFAULT 'pending',
  settled_at  TIMESTAMPTZ
);

-- ── Fraud ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fraud_flags (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id),
  rule_code   VARCHAR(50) NOT NULL,
  severity    VARCHAR(10) DEFAULT 'medium',
  description TEXT,
  metadata    JSONB DEFAULT '{}',
  resolved    BOOLEAN DEFAULT FALSE,
  resolved_by UUID REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  admin_notes TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Bonus ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bonus_campaigns (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          VARCHAR(100) NOT NULL,
  type          VARCHAR(30) NOT NULL,
  percent       NUMERIC(5,2),
  amount        NUMERIC(18,2),
  max_bonus     NUMERIC(18,2),
  min_deposit   NUMERIC(18,2) DEFAULT 500,
  wagering_req  NUMERIC(5,2) DEFAULT 5,
  min_odds      NUMERIC(5,2) DEFAULT 1.5,
  expiry_days   SMALLINT DEFAULT 30,
  is_active     BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_bonuses (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id),
  campaign_id     UUID REFERENCES bonus_campaigns(id),
  type            VARCHAR(30) NOT NULL,
  bonus_amount    NUMERIC(18,2) NOT NULL,
  wagered_amount  NUMERIC(18,2) DEFAULT 0,
  required_wager  NUMERIC(18,2) NOT NULL,
  status          VARCHAR(20) DEFAULT 'active',
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Referrals ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS referrals (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  referrer_id UUID NOT NULL REFERENCES users(id),
  referred_id UUID UNIQUE NOT NULL REFERENCES users(id),
  status      VARCHAR(20) DEFAULT 'pending',
  reward_amount NUMERIC(18,2),
  rewarded_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── SMS Logs ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sms_logs (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID REFERENCES users(id),
  phone       VARCHAR(15) NOT NULL,
  message     TEXT NOT NULL,
  template    VARCHAR(50),
  status      VARCHAR(20) DEFAULT 'pending',
  provider_id VARCHAR(100),
  retries     SMALLINT DEFAULT 0,
  error_msg   TEXT,
  sent_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── OTP ───────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS otp_codes (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone       VARCHAR(15) NOT NULL,
  code_hash   VARCHAR(255) NOT NULL,
  purpose     VARCHAR(30) NOT NULL,
  attempts    SMALLINT DEFAULT 0,
  is_used     BOOLEAN DEFAULT FALSE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_users_phone    ON users(phone);
CREATE INDEX IF NOT EXISTS idx_wallets_user   ON wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_txn_user       ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_txn_created    ON transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_user   ON tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_events_status  ON events(status);
CREATE INDEX IF NOT EXISTS idx_events_sport   ON events(sport_id);
CREATE INDEX IF NOT EXISTS idx_markets_event  ON markets(event_id);
CREATE INDEX IF NOT EXISTS idx_fraud_user     ON fraud_flags(user_id);
CREATE INDEX IF NOT EXISTS idx_otp_phone      ON otp_codes(phone, purpose);

-- ── Seed sports ───────────────────────────────────────────────────────────────
INSERT INTO sports (id, name) VALUES
  ('football',     'Football'),
  ('basketball',   'Basketball'),
  ('tennis',       'Tennis'),
  ('ice_hockey',   'Ice Hockey'),
  ('baseball',     'Baseball'),
  ('rugby_league', 'Rugby League')
ON CONFLICT (id) DO NOTHING;

-- ── Default bonus campaign ────────────────────────────────────────────────────
INSERT INTO bonus_campaigns (name, type, percent, max_bonus, min_deposit, wagering_req, min_odds, expiry_days, is_active)
VALUES ('100% Welcome Bonus', 'welcome', 100, 50000, 500, 5, 1.5, 30, true)
ON CONFLICT DO NOTHING;

SELECT 'Schema created successfully' AS result;
-- ── Admin Roles ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_roles (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        VARCHAR(50) UNIQUE NOT NULL,
  label       VARCHAR(100) NOT NULL,
  description TEXT,
  color       VARCHAR(20) DEFAULT 'blue',
  is_active   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_permissions (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  role_id     UUID NOT NULL REFERENCES admin_roles(id) ON DELETE CASCADE,
  resource    VARCHAR(50) NOT NULL,
  can_view    BOOLEAN DEFAULT FALSE,
  can_create  BOOLEAN DEFAULT FALSE,
  can_edit    BOOLEAN DEFAULT FALSE,
  can_delete  BOOLEAN DEFAULT FALSE,
  can_approve BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(role_id, resource)
);

CREATE TABLE IF NOT EXISTS admins (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  role_id         UUID NOT NULL REFERENCES admin_roles(id),
  full_name       VARCHAR(255) NOT NULL,
  phone           VARCHAR(15) UNIQUE NOT NULL,
  email           VARCHAR(255),
  password_hash   VARCHAR(255) NOT NULL,
  pin_hash        VARCHAR(255),
  is_active       BOOLEAN DEFAULT TRUE,
  is_suspended    BOOLEAN DEFAULT FALSE,
  suspension_reason TEXT,
  last_login_at   TIMESTAMPTZ,
  last_login_ip   TEXT,
  failed_attempts SMALLINT DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  created_by      UUID REFERENCES admins(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_activity_logs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  admin_id      UUID NOT NULL REFERENCES admins(id),
  action        VARCHAR(100) NOT NULL,
  resource_type VARCHAR(50),
  resource_id   UUID,
  description   TEXT NOT NULL,
  old_value     JSONB,
  new_value     JSONB,
  ip_address    TEXT,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS withdrawal_approvals (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  withdrawal_id   UUID NOT NULL REFERENCES withdrawals(id),
  admin_id        UUID NOT NULL REFERENCES admins(id),
  action          VARCHAR(20) NOT NULL CHECK (action IN ('approved','rejected','flagged')),
  notes           TEXT,
  processed_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS investigation_notes (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  flag_id     UUID NOT NULL REFERENCES fraud_flags(id),
  admin_id    UUID NOT NULL REFERENCES admins(id),
  note        TEXT NOT NULL,
  action_taken VARCHAR(50),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admins_phone       ON admins(phone);
CREATE INDEX IF NOT EXISTS idx_admins_role        ON admins(role_id);
CREATE INDEX IF NOT EXISTS idx_admin_logs_admin   ON admin_activity_logs(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_logs_created ON admin_activity_logs(created_at DESC);

-- Seed roles
INSERT INTO admin_roles (name, label, description, color) VALUES
  ('super_admin',      'Super Admin',       'Full system control',                 'red'),
  ('customer_support', 'Customer Support',  'Customer management and withdrawals', 'blue'),
  ('fraud_analyst',    'Fraud Analyst',     'Fraud detection and risk management', 'orange'),
  ('odds_manager',     'Odds Manager',      'Sports, odds and match settlement',   'green'),
  ('finance_admin',    'Finance Admin',     'Payments, revenue and tax management','purple')
ON CONFLICT (name) DO NOTHING;

-- Super Admin permissions
INSERT INTO admin_permissions (role_id, resource, can_view, can_create, can_edit, can_delete, can_approve)
SELECT id, unnest(ARRAY['dashboard','customers','bets','payments','fraud','sports','tax','reports','admins','settings']),
  true, true, true, true, true
FROM admin_roles WHERE name = 'super_admin'
ON CONFLICT (role_id, resource) DO NOTHING;

-- Customer Support permissions
INSERT INTO admin_permissions (role_id, resource, can_view, can_create, can_edit, can_delete, can_approve)
SELECT id, unnest(ARRAY['dashboard','customers','bets','payments']),
  true, false, true, false, true
FROM admin_roles WHERE name = 'customer_support'
ON CONFLICT (role_id, resource) DO NOTHING;

-- Fraud Analyst permissions
INSERT INTO admin_permissions (role_id, resource, can_view, can_create, can_edit, can_delete, can_approve)
SELECT id, unnest(ARRAY['dashboard','fraud','customers','bets']),
  true, true, true, false, false
FROM admin_roles WHERE name = 'fraud_analyst'
ON CONFLICT (role_id, resource) DO NOTHING;

-- Odds Manager permissions
INSERT INTO admin_permissions (role_id, resource, can_view, can_create, can_edit, can_delete, can_approve)
SELECT id, unnest(ARRAY['dashboard','sports','bets']),
  true, true, true, true, false
FROM admin_roles WHERE name = 'odds_manager'
ON CONFLICT (role_id, resource) DO NOTHING;

-- Finance Admin permissions
INSERT INTO admin_permissions (role_id, resource, can_view, can_create, can_edit, can_delete, can_approve)
SELECT id, unnest(ARRAY['dashboard','payments','tax','reports']),
  true, false, false, false, true
FROM admin_roles WHERE name = 'finance_admin'
ON CONFLICT (role_id, resource) DO NOTHING;

INSERT INTO admins (full_name, phone, password_hash, role_id, is_active)
SELECT 
  'Young Duwa',
  '+265998337818',
  (SELECT password_hash FROM users WHERE phone = '+265998337818'),
  (SELECT id FROM admin_roles WHERE name = 'super_admin'),
  true
ON CONFLICT (phone) DO NOTHING;

SELECT 'RBAC tables created successfully' AS result;

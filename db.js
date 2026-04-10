// db.js - KWACHA BET Database
const Database = require('better-sqlite3');
require('dotenv').config();

const db = new Database(process.env.DB_PATH || './kwachabet.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      pin_hash TEXT NOT NULL,
      balance REAL NOT NULL DEFAULT 0,
      bonus_balance REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      role TEXT NOT NULL DEFAULT 'customer',
      total_deposited REAL DEFAULT 0,
      total_withdrawn REAL DEFAULT 0,
      total_winnings REAL DEFAULT 0,
      total_staked REAL DEFAULT 0,
      bets_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_login TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sports (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT,
      active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS leagues (
      id TEXT PRIMARY KEY,
      sport_id TEXT NOT NULL,
      name TEXT NOT NULL,
      country TEXT,
      priority INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS matches (
      id TEXT PRIMARY KEY,
      external_id TEXT,
      league_id TEXT NOT NULL,
      sport_id TEXT NOT NULL,
      home_team TEXT NOT NULL,
      away_team TEXT NOT NULL,
      home_score INTEGER,
      away_score INTEGER,
      status TEXT NOT NULL DEFAULT 'upcoming',
      match_date TEXT NOT NULL,
      minute INTEGER,
      odds_home REAL,
      odds_draw REAL,
      odds_away REAL,
      odds_updated TEXT,
      source TEXT DEFAULT 'demo',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      stake REAL NOT NULL,
      total_odds REAL NOT NULL,
      potential_win REAL NOT NULL,
      actual_win REAL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open',
      bet_type TEXT NOT NULL DEFAULT 'accumulator',
      legs_count INTEGER NOT NULL DEFAULT 1,
      placed_at TEXT NOT NULL DEFAULT (datetime('now')),
      settled_at TEXT
    );

    CREATE TABLE IF NOT EXISTS bet_legs (
      id TEXT PRIMARY KEY,
      bet_id TEXT NOT NULL,
      match_id TEXT NOT NULL,
      selection TEXT NOT NULL,
      odds REAL NOT NULL,
      result TEXT NOT NULL DEFAULT 'pending',
      home_score INTEGER,
      away_score INTEGER
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      balance_after REAL NOT NULL,
      description TEXT NOT NULL,
      method TEXT,
      reference TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      method TEXT NOT NULL,
      phone_number TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      gateway_ref TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
    CREATE INDEX IF NOT EXISTS idx_bets_user ON bets(user_id);
    CREATE INDEX IF NOT EXISTS idx_bet_legs_bet ON bet_legs(bet_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);
    CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
  `);

  seedSports();
  console.log('[DB] Schema ready');
}

function seedSports() {
  const count = db.prepare('SELECT COUNT(*) as c FROM sports').get();
  if (count.c > 0) return;

  db.prepare('INSERT OR IGNORE INTO sports (id, name, icon) VALUES (?, ?, ?)').run('football', 'Football', 'soccer');
  db.prepare('INSERT OR IGNORE INTO sports (id, name, icon) VALUES (?, ?, ?)').run('basketball', 'Basketball', 'basketball');
  db.prepare('INSERT OR IGNORE INTO sports (id, name, icon) VALUES (?, ?, ?)').run('tennis', 'Tennis', 'tennis');
  db.prepare('INSERT OR IGNORE INTO sports (id, name, icon) VALUES (?, ?, ?)').run('baseball', 'Baseball', 'baseball');
  db.prepare('INSERT OR IGNORE INTO sports (id, name, icon) VALUES (?, ?, ?)').run('icehockey', 'Ice Hockey', 'hockey');
  db.prepare('INSERT OR IGNORE INTO sports (id, name, icon) VALUES (?, ?, ?)').run('rugby', 'Rugby', 'rugby');
  db.prepare('INSERT OR IGNORE INTO sports (id, name, icon) VALUES (?, ?, ?)').run('mma', 'MMA/Boxing', 'mma');
  db.prepare('INSERT OR IGNORE INTO sports (id, name, icon) VALUES (?, ?, ?)').run('cricket', 'Cricket', 'cricket');

  const leagues = [
    ['epl', 'football', 'Premier League', 'England', 100],
    ['laliga', 'football', 'La Liga', 'Spain', 99],
    ['ucl', 'football', 'UEFA Champions League', 'Europe', 98],
    ['seriea', 'football', 'Serie A', 'Italy', 97],
    ['bundesliga', 'football', 'Bundesliga', 'Germany', 96],
    ['ligue1', 'football', 'Ligue 1', 'France', 95],
    ['eredivisie', 'football', 'Eredivisie', 'Netherlands', 90],
    ['ligaportugal', 'football', 'Liga Portugal', 'Portugal', 89],
    ['uel', 'football', 'UEFA Europa League', 'Europe', 84],
    ['mls', 'football', 'MLS', 'USA', 80],
    ['brasileirao', 'football', 'Brasileirao', 'Brazil', 79],
    ['cafligue', 'football', 'CAF Champions League', 'Africa', 75],
    ['cosafa', 'football', 'COSAFA Cup', 'Southern Africa', 72],
    ['tnmsuper', 'football', 'TNM Super League', 'Malawi', 85],
    ['famcup', 'football', 'FAM Cup', 'Malawi', 80],
    ['saudi', 'football', 'Saudi Pro League', 'Saudi Arabia', 71],
    ['j1league', 'football', 'J1 League', 'Japan', 68],
    ['nba', 'basketball', 'NBA', 'USA', 100],
    ['euroleague', 'basketball', 'EuroLeague', 'Europe', 90],
    ['atp', 'tennis', 'ATP Tour', 'Global', 100],
    ['wta', 'tennis', 'WTA Tour', 'Global', 99],
    ['mlb', 'baseball', 'MLB', 'USA', 100],
    ['nhl', 'icehockey', 'NHL', 'USA/Canada', 100],
    ['khl', 'icehockey', 'KHL', 'Russia', 85],
    ['sixnations', 'rugby', 'Six Nations', 'Europe', 100],
    ['rugbywc', 'rugby', 'Rugby World Cup', 'Global', 99],
    ['superrugby', 'rugby', 'Super Rugby', 'Global', 90],
    ['ufc', 'mma', 'UFC', 'Global', 100],
    ['bellator', 'mma', 'Bellator MMA', 'Global', 90],
    ['ipl', 'cricket', 'IPL', 'India', 100],
    ['icc', 'cricket', 'ICC Events', 'Global', 99],
  ];

  const ins = db.prepare('INSERT OR IGNORE INTO leagues (id, sport_id, name, country, priority) VALUES (?, ?, ?, ?, ?)');
  const insAll = db.transaction(() => leagues.forEach(l => ins.run(...l)));
  insAll();
  console.log('[DB] Sports and leagues seeded');
}

const stmts = {
  getUserByPhone: db.prepare('SELECT * FROM users WHERE phone = ?'),
  getUserById:    db.prepare('SELECT * FROM users WHERE id = ?'),
  createUser:     db.prepare('INSERT INTO users (id, name, phone, pin_hash, balance, bonus_balance) VALUES (?, ?, ?, ?, ?, ?)'),
  updateBalance:  db.prepare("UPDATE users SET balance = ?, updated_at = datetime('now') WHERE id = ?"),
  updateUserStats:db.prepare("UPDATE users SET total_deposited=total_deposited+?, total_withdrawn=total_withdrawn+?, total_winnings=total_winnings+?, total_staked=total_staked+?, bets_count=bets_count+?, updated_at=datetime('now') WHERE id=?"),
  updateLastLogin:db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?"),
  getAllUsers:     db.prepare("SELECT id,name,phone,balance,status,role,total_deposited,total_withdrawn,total_winnings,bets_count,created_at,last_login FROM users ORDER BY created_at DESC"),
  getPlatformStats: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users) as total_users,
      (SELECT COUNT(*) FROM users WHERE last_login >= datetime('now','-1 day')) as active_today,
      (SELECT COUNT(*) FROM bets) as total_bets,
      (SELECT COUNT(*) FROM bets WHERE status='open') as open_bets,
      (SELECT COALESCE(SUM(amount),0) FROM transactions WHERE type='deposit' AND status='completed') as total_deposits,
      (SELECT COALESCE(SUM(amount),0) FROM transactions WHERE type='withdrawal' AND status='completed') as total_withdrawals,
      (SELECT COUNT(*) FROM matches WHERE status='live') as live_matches,
      (SELECT COUNT(*) FROM matches WHERE status='upcoming') as upcoming_matches,
      (SELECT COUNT(*) FROM payments WHERE status='pending' AND type='withdrawal') as pending_withdrawals
  `),
  getUpcomingMatches: db.prepare(`
    SELECT m.*, l.name as league_name, l.country, l.priority, s.name as sport_name
    FROM matches m
    JOIN leagues l ON m.league_id = l.id
    JOIN sports s ON m.sport_id = s.id
    WHERE m.status IN ('upcoming','live')
    AND m.match_date >= datetime('now', '-3 hours')
    ORDER BY l.priority DESC, m.match_date ASC
    LIMIT 200
  `),
  getLiveMatches: db.prepare(`
    SELECT m.*, l.name as league_name, l.country, s.name as sport_name
    FROM matches m JOIN leagues l ON m.league_id=l.id JOIN sports s ON m.sport_id=s.id
    WHERE m.status='live' ORDER BY l.priority DESC
  `),
  getMatchById:   db.prepare('SELECT * FROM matches WHERE id = ?'),
  updateMatchOdds:db.prepare("UPDATE matches SET odds_home=?,odds_draw=?,odds_away=?,odds_updated=datetime('now'),updated_at=datetime('now') WHERE id=?"),
  updateMatchScore:db.prepare("UPDATE matches SET home_score=?,away_score=?,status=?,minute=?,updated_at=datetime('now') WHERE id=?"),
  createBet:      db.prepare("INSERT INTO bets (id,user_id,stake,total_odds,potential_win,status,bet_type,legs_count) VALUES (?,?,?,?,?,'open',?,?)"),
  createBetLeg:   db.prepare("INSERT INTO bet_legs (id,bet_id,match_id,selection,odds,result) VALUES (?,?,?,?,?,'pending')"),
  getUserBets:    db.prepare(`
    SELECT b.*,
      json_group_array(json_object(
        'id',bl.id,'match_id',bl.match_id,'selection',bl.selection,'odds',bl.odds,'result',bl.result,
        'home_team',m.home_team,'away_team',m.away_team,'home_score',m.home_score,'away_score',m.away_score,
        'league',l.name,'match_date',m.match_date,'status',m.status
      )) as legs
    FROM bets b
    JOIN bet_legs bl ON b.id=bl.bet_id
    JOIN matches m ON bl.match_id=m.id
    JOIN leagues l ON m.league_id=l.id
    WHERE b.user_id=?
    GROUP BY b.id ORDER BY b.placed_at DESC LIMIT 50
  `),
  getOpenBetsForMatch: db.prepare("SELECT bl.*,b.user_id,b.id as bet_id,b.stake,b.total_odds,b.potential_win,b.legs_count FROM bet_legs bl JOIN bets b ON bl.bet_id=b.id WHERE bl.match_id=? AND bl.result='pending' AND b.status='open'"),
  updateBetLegResult:  db.prepare('UPDATE bet_legs SET result=?,home_score=?,away_score=? WHERE id=?'),
  updateBetStatus:     db.prepare("UPDATE bets SET status=?,actual_win=?,settled_at=datetime('now') WHERE id=?"),
  createTransaction:   db.prepare('INSERT INTO transactions (id,user_id,type,amount,balance_after,description,method,reference,status) VALUES (?,?,?,?,?,?,?,?,?)'),
  getUserTransactions: db.prepare('SELECT * FROM transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 50'),
  getAllTransactions:   db.prepare('SELECT t.*,u.name as user_name,u.phone as user_phone FROM transactions t JOIN users u ON t.user_id=u.id ORDER BY t.created_at DESC LIMIT 100'),
  createPayment:       db.prepare("INSERT INTO payments (id,user_id,type,amount,method,phone_number,status,gateway_ref) VALUES (?,?,?,?,?,?,'pending',?)"),
};

module.exports = { db, stmts, initSchema };

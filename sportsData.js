// sportsData.js - KWACHA BET Sports Data Engine
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { db, stmts } = require('./db');
require('dotenv').config();

// =====================================================
// INJECT DEMO MATCHES (runs when no API keys set)
// =====================================================
function injectDemoMatches() {
  const count = db.prepare("SELECT COUNT(*) as c FROM matches WHERE status IN ('upcoming','live')").get();
  if (count.c >= 20) return;

  console.log('[Demo] Injecting match data...');
  const now = new Date();

  const matches = [
    // LIVE NOW
    { league:'epl', sport:'football', home:'Arsenal', away:'Manchester City', status:'live', ho:2.20, dr:3.40, ao:3.10, hs:1, as_:1, min:67 },
    { league:'laliga', sport:'football', home:'Real Madrid', away:'Barcelona', status:'live', ho:1.95, dr:3.60, ao:3.80, hs:0, as_:0, min:23 },
    { league:'ucl', sport:'football', home:'Bayern Munich', away:'PSG', status:'live', ho:2.10, dr:3.50, ao:3.20, hs:2, as_:1, min:55 },
    { league:'tnmsuper', sport:'football', home:'Nyasa Big Bullets', away:'Silver Strikers', status:'live', ho:1.75, dr:3.50, ao:4.20, hs:1, as_:0, min:72 },
    { league:'nba', sport:'basketball', home:'LA Lakers', away:'Golden State Warriors', status:'live', ho:1.85, dr:null, ao:1.95, hs:74, as_:68 },
    { league:'nhl', sport:'icehockey', home:'Toronto Maple Leafs', away:'Montreal Canadiens', status:'live', ho:1.75, dr:null, ao:2.05, hs:3, as_:2 },
    // UPCOMING TODAY
    { league:'epl', sport:'football', home:'Liverpool', away:'Tottenham', status:'upcoming', ho:1.60, dr:4.00, ao:5.50 },
    { league:'epl', sport:'football', home:'Chelsea', away:'Aston Villa', status:'upcoming', ho:1.80, dr:3.40, ao:4.20 },
    { league:'epl', sport:'football', home:'Manchester United', away:'Newcastle', status:'upcoming', ho:2.10, dr:3.30, ao:3.40 },
    { league:'laliga', sport:'football', home:'Atletico Madrid', away:'Sevilla', status:'upcoming', ho:1.90, dr:3.40, ao:3.90 },
    { league:'laliga', sport:'football', home:'Valencia', away:'Athletic Bilbao', status:'upcoming', ho:2.30, dr:3.10, ao:3.00 },
    { league:'seriea', sport:'football', home:'Juventus', away:'Inter Milan', status:'upcoming', ho:2.40, dr:3.20, ao:2.80 },
    { league:'seriea', sport:'football', home:'AC Milan', away:'Napoli', status:'upcoming', ho:2.20, dr:3.30, ao:3.10 },
    { league:'bundesliga', sport:'football', home:'Borussia Dortmund', away:'RB Leipzig', status:'upcoming', ho:1.80, dr:3.70, ao:4.10 },
    { league:'bundesliga', sport:'football', home:'Bayer Leverkusen', away:'Frankfurt', status:'upcoming', ho:1.65, dr:4.00, ao:5.00 },
    { league:'ligue1', sport:'football', home:'PSG', away:'Marseille', status:'upcoming', ho:1.50, dr:3.90, ao:5.50 },
    { league:'ucl', sport:'football', home:'Manchester City', away:'Real Madrid', status:'upcoming', ho:2.50, dr:3.40, ao:2.70 },
    { league:'cafligue', sport:'football', home:'Al Ahly', away:'Wydad Casablanca', status:'upcoming', ho:1.90, dr:3.40, ao:3.90 },
    { league:'tnmsuper', sport:'football', home:'Wanderers FC', away:'MAFCO FC', status:'upcoming', ho:2.00, dr:3.20, ao:3.50 },
    { league:'tnmsuper', sport:'football', home:'Mighty Tigers', away:'Kamuzu Barracks', status:'upcoming', ho:2.20, dr:3.10, ao:3.20 },
    { league:'cosafa', sport:'football', home:'Malawi', away:'Zimbabwe', status:'upcoming', ho:2.10, dr:3.30, ao:3.40 },
    { league:'cosafa', sport:'football', home:'Zambia', away:'Tanzania', status:'upcoming', ho:1.90, dr:3.50, ao:3.80 },
    { league:'brasileirao', sport:'football', home:'Flamengo', away:'Palmeiras', status:'upcoming', ho:2.10, dr:3.30, ao:3.40 },
    { league:'saudi', sport:'football', home:'Al Hilal', away:'Al Nassr', status:'upcoming', ho:2.30, dr:3.20, ao:3.00 },
    { league:'j1league', sport:'football', home:'Urawa Red Diamonds', away:'Kashima Antlers', status:'upcoming', ho:2.00, dr:3.40, ao:3.50 },
    { league:'nba', sport:'basketball', home:'Boston Celtics', away:'Miami Heat', status:'upcoming', ho:1.60, dr:null, ao:2.30 },
    { league:'nba', sport:'basketball', home:'Milwaukee Bucks', away:'Philadelphia 76ers', status:'upcoming', ho:1.75, dr:null, ao:2.05 },
    { league:'nba', sport:'basketball', home:'Denver Nuggets', away:'Oklahoma City Thunder', status:'upcoming', ho:1.80, dr:null, ao:2.00 },
    { league:'euroleague', sport:'basketball', home:'Real Madrid', away:'CSKA Moscow', status:'upcoming', ho:1.70, dr:null, ao:2.10 },
    { league:'atp', sport:'tennis', home:'Djokovic N.', away:'Alcaraz C.', status:'upcoming', ho:1.65, dr:null, ao:2.20 },
    { league:'atp', sport:'tennis', home:'Sinner J.', away:'Medvedev D.', status:'upcoming', ho:1.80, dr:null, ao:2.00 },
    { league:'wta', sport:'tennis', home:'Swiatek I.', away:'Sabalenka A.', status:'upcoming', ho:1.70, dr:null, ao:2.10 },
    { league:'mlb', sport:'baseball', home:'NY Yankees', away:'LA Dodgers', status:'upcoming', ho:1.90, dr:null, ao:1.90 },
    { league:'mlb', sport:'baseball', home:'Chicago Cubs', away:'Boston Red Sox', status:'upcoming', ho:2.10, dr:null, ao:1.75 },
    { league:'nhl', sport:'icehockey', home:'Vegas Golden Knights', away:'Colorado Avalanche', status:'upcoming', ho:1.80, dr:null, ao:2.00 },
    { league:'khl', sport:'icehockey', home:'CSKA Moscow', away:'SKA St.Petersburg', status:'upcoming', ho:1.90, dr:null, ao:1.90 },
    { league:'sixnations', sport:'rugby', home:'England', away:'France', status:'upcoming', ho:2.10, dr:null, ao:1.75 },
    { league:'rugbywc', sport:'rugby', home:'South Africa', away:'New Zealand', status:'upcoming', ho:1.90, dr:null, ao:1.90 },
    { league:'superrugby', sport:'rugby', home:'Chiefs', away:'Crusaders', status:'upcoming', ho:1.85, dr:null, ao:1.95 },
    { league:'ufc', sport:'mma', home:'Islam Makhachev', away:'Dustin Poirier', status:'upcoming', ho:1.45, dr:null, ao:2.70 },
    { league:'bellator', sport:'mma', home:'Jon Jones', away:'Stipe Miocic', status:'upcoming', ho:1.60, dr:null, ao:2.30 },
    { league:'ipl', sport:'cricket', home:'Mumbai Indians', away:'Chennai Super Kings', status:'upcoming', ho:1.80, dr:null, ao:2.00 },
    { league:'icc', sport:'cricket', home:'India', away:'Australia', status:'upcoming', ho:1.75, dr:null, ao:2.05 },
  ];

  const ins = db.prepare(`
    INSERT OR IGNORE INTO matches (id,external_id,league_id,sport_id,home_team,away_team,match_date,home_score,away_score,status,minute,odds_home,odds_draw,odds_away,source,odds_updated)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'demo',datetime('now'))
  `);

  const insAll = db.transaction(() => {
    matches.forEach((m, i) => {
      const id = uuidv4();
      let matchDate;
      if (m.status === 'live') {
        matchDate = new Date(now.getTime() - Math.random() * 80 * 60000).toISOString();
      } else {
        const hrs = 1 + i * 0.4;
        matchDate = new Date(now.getTime() + hrs * 3600000).toISOString();
      }
      ins.run(id, 'demo_' + i, m.league, m.sport, m.home, m.away, matchDate,
        m.hs ?? null, m.as_ ?? null, m.status, m.min ?? null, m.ho, m.dr, m.ao);
    });
  });
  insAll();
  console.log('[Demo] Injected ' + matches.length + ' matches');
}

// =====================================================
// FETCH REAL ODDS FROM THE ODDS API
// =====================================================
async function fetchRealOdds() {
  const key = process.env.ODDS_API_KEY;
  if (!key || key === 'your_odds_api_key_here') {
    console.log('[OddsAPI] No key - using demo mode');
    return;
  }

  const sports = [
    { key: 'soccer_epl', league: 'epl', sport: 'football' },
    { key: 'soccer_spain_la_liga', league: 'laliga', sport: 'football' },
    { key: 'soccer_uefa_champs_league', league: 'ucl', sport: 'football' },
    { key: 'soccer_italy_serie_a', league: 'seriea', sport: 'football' },
    { key: 'soccer_germany_bundesliga', league: 'bundesliga', sport: 'football' },
    { key: 'soccer_france_ligue_one', league: 'ligue1', sport: 'football' },
    { key: 'soccer_netherlands_eredivisie', league: 'eredivisie', sport: 'football' },
    { key: 'soccer_portugal_primeira_liga', league: 'ligaportugal', sport: 'football' },
    { key: 'soccer_usa_mls', league: 'mls', sport: 'football' },
    { key: 'basketball_nba', league: 'nba', sport: 'basketball' },
    { key: 'icehockey_nhl', league: 'nhl', sport: 'icehockey' },
    { key: 'baseball_mlb', league: 'mlb', sport: 'baseball' },
    { key: 'rugby_union_six_nations', league: 'sixnations', sport: 'rugby' },
    { key: 'mma_mixed_martial_arts', league: 'ufc', sport: 'mma' },
    { key: 'cricket_icc_world_cup', league: 'icc', sport: 'cricket' },
  ];

  let total = 0;
  for (const s of sports) {
    try {
      const res = await axios.get('https://api.the-odds-api.com/v4/sports/' + s.key + '/odds', {
        params: { apiKey: key, regions: 'eu', markets: 'h2h', oddsFormat: 'decimal', dateFormat: 'iso' },
        timeout: 10000,
      });

      for (const game of (res.data || [])) {
        const bm = game.bookmakers && game.bookmakers[0];
        if (!bm) continue;
        const h2h = bm.markets && bm.markets.find(function(m) { return m.key === 'h2h'; });
        if (!h2h) continue;
        const outcomes = h2h.outcomes;
        const homeOdd = outcomes.find(function(o) { return o.name === game.home_team; });
        const awayOdd = outcomes.find(function(o) { return o.name === game.away_team; });
        const drawOdd = outcomes.find(function(o) { return o.name === 'Draw'; });
        if (!homeOdd || !awayOdd) continue;

        const existing = db.prepare('SELECT id FROM matches WHERE external_id = ?').get(game.id);
        if (existing) {
          stmts.updateMatchOdds.run(homeOdd.price, drawOdd ? drawOdd.price : null, awayOdd.price, existing.id);
        } else {
          const matchId = uuidv4();
          db.prepare(`
            INSERT OR IGNORE INTO matches (id,external_id,league_id,sport_id,home_team,away_team,match_date,odds_home,odds_draw,odds_away,status,source,odds_updated)
            VALUES (?,?,?,?,?,?,?,'upcoming','odds_api',datetime('now'))
          `).run(matchId, game.id, s.league, s.sport, game.home_team, game.away_team,
            game.commence_time, homeOdd.price, drawOdd ? drawOdd.price : null, awayOdd.price);
        }
        total++;
      }
      await new Promise(function(r) { setTimeout(r, 500); });
    } catch (err) {
      if (err.response && err.response.status === 422) continue;
      console.error('[OddsAPI] ' + s.key + ':', err.message);
    }
  }
  console.log('[OddsAPI] Updated ' + total + ' matches');
}

// =====================================================
// SIMULATE ODDS DRIFT (every 15 seconds)
// =====================================================
function simulateOddsDrift() {
  const matches = db.prepare("SELECT id,odds_home,odds_draw,odds_away,status FROM matches WHERE status IN ('live','upcoming')").all();
  const update = db.transaction(function() {
    matches.forEach(function(m) {
      const vol = m.status === 'live' ? 0.09 : 0.03;
      const nh = Math.max(1.05, Math.min(20, m.odds_home + (Math.random() - 0.48) * vol));
      const na = Math.max(1.05, Math.min(20, m.odds_away + (Math.random() - 0.48) * vol));
      const nd = m.odds_draw ? Math.max(2.0, Math.min(8, m.odds_draw + (Math.random() - 0.48) * vol * 0.5)) : null;
      stmts.updateMatchOdds.run(+nh.toFixed(2), nd ? +nd.toFixed(2) : null, +na.toFixed(2), m.id);
    });
  });
  update();
}

// =====================================================
// SIMULATE LIVE SCORES (every 30 seconds)
// =====================================================
function simulateLiveScores() {
  const live = db.prepare("SELECT id,sport_id,home_score,away_score,minute,odds_home,odds_draw,odds_away FROM matches WHERE status='live'").all();
  live.forEach(function(m) {
    if (m.sport_id === 'football' && m.minute !== null) {
      const newMin = Math.min(95, (m.minute || 0) + 1);
      if (Math.random() < 0.018) {
        const scorer = Math.random() < 0.55 ? 'home' : 'away';
        const hs = (m.home_score || 0) + (scorer === 'home' ? 1 : 0);
        const as_ = (m.away_score || 0) + (scorer === 'away' ? 1 : 0);
        db.prepare("UPDATE matches SET home_score=?,away_score=?,minute=?,updated_at=datetime('now') WHERE id=?").run(hs, as_, newMin, m.id);
        const lead = hs - as_;
        const nho = lead > 0 ? Math.max(1.05, (m.odds_home || 2) - 0.3) : Math.min(15, (m.odds_home || 2) + 0.3);
        const nao = lead < 0 ? Math.max(1.05, (m.odds_away || 2) - 0.3) : Math.min(15, (m.odds_away || 2) + 0.3);
        stmts.updateMatchOdds.run(+nho.toFixed(2), m.odds_draw, +nao.toFixed(2), m.id);
        console.log('[Live] GOAL! ' + (scorer === 'home' ? m.home_team : m.away_team) + ' scores! ' + hs + '-' + as_);
        if (newMin >= 90) {
          db.prepare("UPDATE matches SET status='finished',updated_at=datetime('now') WHERE id=?").run(m.id);
          settleBets(m.id);
        }
      } else {
        db.prepare("UPDATE matches SET minute=?,updated_at=datetime('now') WHERE id=?").run(newMin, m.id);
      }
    }
  });
}

// =====================================================
// SETTLE BETS WHEN MATCH FINISHES
// =====================================================
function settleBets(matchId) {
  const match = db.prepare('SELECT * FROM matches WHERE id=?').get(matchId);
  if (!match) return;
  const hs = match.home_score || 0;
  const as_ = match.away_score || 0;
  const outcome = hs > as_ ? 'home' : as_ > hs ? 'away' : 'draw';
  const legs = stmts.getOpenBetsForMatch.all(matchId);

  legs.forEach(function(leg) {
    const won = leg.selection === outcome;
    stmts.updateBetLegResult.run(won ? 'win' : 'loss', hs, as_, leg.id);

    const allLegs = db.prepare('SELECT * FROM bet_legs WHERE bet_id=?').all(leg.bet_id);
    if (allLegs.every(function(l) { return l.result !== 'pending'; })) {
      const allWon = allLegs.every(function(l) { return l.result === 'win'; });
      const bet = db.prepare('SELECT * FROM bets WHERE id=?').get(leg.bet_id);
      if (!bet) return;
      if (allWon) {
        const user = stmts.getUserById.get(bet.user_id);
        if (!user) return;
        const newBal = user.balance + bet.potential_win;
        stmts.updateBalance.run(newBal, user.id);
        stmts.updateBetStatus.run('won', bet.potential_win, bet.id);
        stmts.updateUserStats.run(0, 0, bet.potential_win, 0, 0, user.id);
        stmts.createTransaction.run(
          uuidv4(), user.id, 'winning', bet.potential_win, newBal,
          'Winnings from bet #' + bet.id.slice(0, 8), 'Account', bet.id, 'completed'
        );
        console.log('[Settle] Bet ' + bet.id.slice(0, 8) + ' WON - MWK ' + bet.potential_win + ' paid to ' + user.name);
      } else {
        stmts.updateBetStatus.run('lost', 0, bet.id);
        console.log('[Settle] Bet ' + bet.id.slice(0, 8) + ' LOST');
      }
    }
  });
}

module.exports = { injectDemoMatches, fetchRealOdds, simulateOddsDrift, simulateLiveScores };

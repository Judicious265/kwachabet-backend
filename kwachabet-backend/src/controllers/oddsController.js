/**
 * Odds Controller
 * Fetches multiple markets from The Odds API automatically
 * Correct Score is manually set by Odds Manager in admin dashboard
 */

const axios    = require('axios');
const { query } = require('../config/database');
const { generateId } = require('../utils/helpers');
const logger   = require('../utils/logger');

const ODDS_API_KEY  = process.env.ODDS_API_KEY;
const ODDS_API_BASE = process.env.ODDS_API_BASE_URL || 'https://api.the-odds-api.com/v4';

// Sports mapping to The Odds API sport keys
const SPORT_MAP = {
  football:     'soccer_epl',
  basketball:   'basketball_nba',
  tennis:       'tennis_atp_french_open',
  ice_hockey:   'icehockey_nhl',
  baseball:     'baseball_mlb',
  rugby_league: 'rugbyleague_nrl',
};

// Markets to fetch automatically from The Odds API
// Each costs API quota so we group them per request
const AUTO_MARKETS = [
  'h2h',              // Match Betting (1X2)
  'btts',             // Both Teams To Score Yes/No
  'double_chance',    // Double Chance (1X, X2, 12)
  'draw_no_bet',      // Draw No Bet
  'totals',           // Total Goals Over/Under
  'alternate_totals', // More total goals lines
];

// Market type display names for the frontend
const MARKET_LABELS = {
  h2h:              'Match Betting',
  btts:             'Both Teams To Score',
  double_chance:    'Double Chance',
  draw_no_bet:      'Draw No Bet',
  totals:           'Total Goals',
  alternate_totals: 'Total Goals (Alt)',
  h2h_h1:          'Half Time Result',
  btts_h1:         'BTTS - 1st Half',
  correct_score:   'Correct Score',    // Manual only
  handicap:        '3-Way Handicap',   // Manual only
  corners:         'Total Corners',    // Manual only
  cards:           'Total Cards',      // Manual only
  yellow_cards:    'Yellow Cards 1X2', // Manual only
  odd_even:        'Odd/Even Goals',   // Manual only
  penalty:         'Penalty In Match', // Manual only
  ht_ft:           'HT/FT',           // Manual only
  win_both_halves: 'Win Both Halves',  // Manual only
};

// ── Get events for frontend ───────────────────────────────────────────────────
exports.getEvents = async (req, res) => {
  try {
    const { sport, status = 'upcoming', market } = req.query;

    let sql = `
      SELECT e.*,
        json_agg(
          json_build_object(
            'id', m.id,
            'market_type', m.market_type,
            'outcome', m.outcome,
            'odds', m.odds,
            'bookmaker', m.bookmaker,
            'line', m.line
          ) ORDER BY m.market_type, m.odds
        ) FILTER (WHERE m.id IS NOT NULL) as markets
      FROM events e
      LEFT JOIN markets m ON m.event_id = e.id AND m.is_active = true
      WHERE e.status = $1
    `;
    const args = [status];

    if (sport) { args.push(sport); sql += ' AND e.sport_id = $' + args.length; }
    if (market) { args.push(market); sql += ' AND m.market_type = $' + args.length; }

    sql += ' GROUP BY e.id ORDER BY e.commence_time ASC LIMIT 100';

    const { rows } = await query(sql, args);
    res.json({ events: rows });
  } catch (err) {
    logger.error('getEvents: ' + err.message);
    res.status(500).json({ error: 'Could not fetch events.' });
  }
};

// ── Get featured events ───────────────────────────────────────────────────────
exports.getFeatured = async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT e.*,
        json_agg(
          json_build_object(
            'id', m.id,
            'market_type', m.market_type,
            'outcome', m.outcome,
            'odds', m.odds,
            'line', m.line
          ) ORDER BY m.market_type, m.odds
        ) FILTER (WHERE m.id IS NOT NULL) as markets
      FROM events e
      LEFT JOIN markets m ON m.event_id = e.id AND m.is_active = true
      WHERE e.status IN ('upcoming', 'live')
      GROUP BY e.id
      ORDER BY e.commence_time ASC
      LIMIT 20
    `);
    res.json({ events: rows });
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch featured events.' });
  }
};

// ── Get sports ────────────────────────────────────────────────────────────────
exports.getSports = async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM sports WHERE is_active = true ORDER BY name');
    res.json({ sports: rows });
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch sports.' });
  }
};

// ── Get available markets for an event ───────────────────────────────────────
exports.getEventMarkets = async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await query(`
      SELECT
        m.market_type,
        json_agg(
          json_build_object(
            'id', m.id,
            'outcome', m.outcome,
            'odds', m.odds,
            'line', m.line
          ) ORDER BY m.odds
        ) as outcomes
      FROM markets m
      WHERE m.event_id = $1 AND m.is_active = true
      GROUP BY m.market_type
      ORDER BY m.market_type
    `, [id]);

    // Add labels
    const markets = rows.map(function(r) {
      return {
        market_type: r.market_type,
        label:       MARKET_LABELS[r.market_type] || r.market_type,
        outcomes:    r.outcomes,
      };
    });

    res.json({ markets });
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch markets.' });
  }
};

// ── Sync odds from The Odds API ───────────────────────────────────────────────
exports.syncOdds = async function() {
  if (!ODDS_API_KEY) {
    logger.warn('ODDS_API_KEY not set — skipping odds sync');
    return;
  }

  logger.info('Starting odds sync...');
  var totalEvents  = 0;
  var totalMarkets = 0;

  for (var sportKey in SPORT_MAP) {
    var apiSport = SPORT_MAP[sportKey];
    try {
      // Fetch all auto markets in one API call (comma separated)
      var marketsParam = AUTO_MARKETS.join(',');

      var response = await axios.get(ODDS_API_BASE + '/sports/' + apiSport + '/odds', {
        params: {
          apiKey:      ODDS_API_KEY,
          regions:     'uk,eu',
          markets:     marketsParam,
          oddsFormat:  'decimal',
          dateFormat:  'iso',
        },
        timeout: 20000,
      });

      var games = response.data || [];
      logger.debug('Syncing ' + games.length + ' ' + sportKey + ' events...');

      for (var i = 0; i < games.length; i++) {
        var game = games[i];
        try {
          // Upsert event
          var eventId = generateId();
          await query(`
            INSERT INTO events (id, external_id, sport_id, home_team, away_team, league, commence_time, status)
            VALUES ($1,$2,$3,$4,$5,$6,$7,'upcoming')
            ON CONFLICT (external_id) DO UPDATE SET
              home_team     = EXCLUDED.home_team,
              away_team     = EXCLUDED.away_team,
              commence_time = EXCLUDED.commence_time,
              status        = CASE
                WHEN events.status = 'finished' THEN events.status
                WHEN EXCLUDED.commence_time < NOW() THEN 'live'
                ELSE 'upcoming'
              END,
              updated_at = NOW()
          `, [eventId, game.id, sportKey, game.home_team, game.away_team, apiSport, new Date(game.commence_time)]);

          // Get actual event ID
          var evResult = await query('SELECT id FROM events WHERE external_id = $1', [game.id]);
          var evId = evResult.rows[0] && evResult.rows[0].id;
          if (!evId) continue;

          // Process each bookmaker's markets
          var bookmakers = game.bookmakers || [];
          // Use first available bookmaker, prefer Pinnacle or Bet365
          var bm = bookmakers.find(function(b) { return b.key === 'pinnacle'; })
            || bookmakers.find(function(b) { return b.key === 'bet365'; })
            || bookmakers[0];

          if (!bm) continue;

          // Process each market
          for (var j = 0; j < bm.markets.length; j++) {
            var mkt = bm.markets[j];
            var marketType = mkt.key; // h2h, btts, double_chance etc.

            for (var k = 0; k < mkt.outcomes.length; k++) {
              var outcome = mkt.outcomes[k];
              var outcomeName = outcome.name;
              var odds        = parseFloat(outcome.price);
              var line        = outcome.point || null; // for totals (Over 2.5 etc.)

              // For totals, include the line in outcome name e.g. "Over 2.5"
              if (line !== null && (marketType === 'totals' || marketType === 'alternate_totals')) {
                outcomeName = outcome.name + ' ' + line;
              }

              if (odds <= 1) continue; // skip invalid odds

              await query(`
                INSERT INTO markets (id, event_id, market_type, outcome, odds, bookmaker, line, is_active, updated_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7,true,NOW())
                ON CONFLICT (event_id, market_type, outcome) DO UPDATE SET
                  odds      = EXCLUDED.odds,
                  line      = EXCLUDED.line,
                  bookmaker = EXCLUDED.bookmaker,
                  is_active = true,
                  updated_at = NOW()
              `, [generateId(), evId, marketType, outcomeName, odds, bm.key, line]);

              totalMarkets++;
            }
          }
          totalEvents++;
        } catch (gameErr) {
          logger.error('Error syncing game ' + (game.id || '') + ': ' + gameErr.message);
        }
      }

      logger.info('Synced ' + sportKey + ': ' + games.length + ' events');

      // Small delay between sports to avoid rate limiting
      await new Promise(function(r) { setTimeout(r, 500); });

    } catch (err) {
      logger.error('Odds sync failed for ' + sportKey + ': ' + err.message);
      if (err.response && err.response.status === 401) {
        logger.error('Invalid ODDS_API_KEY — check your Render environment variable');
        break;
      }
      if (err.response && err.response.status === 422) {
        logger.warn(sportKey + ' market not available in your Odds API plan');
      }
    }
  }

  logger.info('Odds sync complete. Events: ' + totalEvents + ', Markets: ' + totalMarkets);

  // Broadcast updated odds to frontend via WebSocket
  try {
    var wsResult = await query(`
      SELECT e.*,
        json_agg(
          json_build_object(
            'id', m.id,
            'market_type', m.market_type,
            'outcome', m.outcome,
            'odds', m.odds,
            'line', m.line
          )
        ) FILTER (WHERE m.id IS NOT NULL) as markets
      FROM events e
      LEFT JOIN markets m ON m.event_id = e.id AND m.is_active = true
      WHERE e.status IN ('upcoming', 'live')
      GROUP BY e.id
      ORDER BY e.commence_time ASC
      LIMIT 100
    `);
    if (global.broadcastOdds) {
      global.broadcastOdds({ type: 'odds_update', events: wsResult.rows, timestamp: Date.now() });
    }
  } catch (wsErr) {
    logger.error('WebSocket broadcast failed: ' + wsErr.message);
  }
};

// ── Ensure market unique index ────────────────────────────────────────────────
exports.ensureMarketUniqueIndex = async function() {
  try {
    await query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_markets_unique
      ON markets (event_id, market_type, outcome)
    `);
  } catch (err) {
    logger.warn('Market index already exists or failed: ' + err.message);
  }
};

// Export market labels for use in frontend
exports.MARKET_LABELS = MARKET_LABELS;

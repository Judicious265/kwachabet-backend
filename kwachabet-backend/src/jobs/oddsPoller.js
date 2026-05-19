/**
 * Odds Poller - Fetches from The Odds API every 5 minutes
 * Covers all 6 sports with maximum events
 */

const cron     = require('node-cron');
const axios    = require('axios');
const { pool } = require('../config/database');
const logger   = require('../utils/logger');

const ODDS_API_KEY  = process.env.ODDS_API_KEY;
const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';

// All sports mapped to The Odds API keys
// Using multiple keys per sport to get more events
const SPORTS = [
  // Football - multiple leagues
  { key: 'soccer_epl',             name: 'football', label: 'Premier League' },
  { key: 'soccer_spain_la_liga',   name: 'football', label: 'La Liga' },
  { key: 'soccer_italy_serie_a',   name: 'football', label: 'Serie A' },
  { key: 'soccer_germany_bundesliga', name: 'football', label: 'Bundesliga' },
  { key: 'soccer_france_ligue_one',name: 'football', label: 'Ligue 1' },
  { key: 'soccer_uefa_champs_league', name: 'football', label: 'Champions League' },
  { key: 'soccer_africa_cup_of_nations', name: 'football', label: 'Africa Cup' },
  // Basketball
  { key: 'basketball_nba',         name: 'basketball', label: 'NBA' },
  { key: 'basketball_euroleague',  name: 'basketball', label: 'EuroLeague' },
  // Tennis
  { key: 'tennis_atp_french_open', name: 'tennis', label: 'ATP' },
  { key: 'tennis_wta_french_open', name: 'tennis', label: 'WTA' },
  // Ice Hockey
  { key: 'icehockey_nhl',          name: 'ice_hockey', label: 'NHL' },
  // Baseball
  { key: 'baseball_mlb',           name: 'baseball', label: 'MLB' },
  // Rugby
  { key: 'rugbyleague_nrl',        name: 'rugby_league', label: 'NRL Rugby' },
];

let requestsUsed = 0;

async function fetchSportOdds(sport) {
  if (!ODDS_API_KEY) return [];

  try {
    const response = await axios.get(`${ODDS_API_BASE}/sports/${sport.key}/odds`, {
      params: {
        apiKey:     ODDS_API_KEY,
        regions:    'uk,eu',
        markets:    'h2h',
        oddsFormat: 'decimal',
      },
      timeout: 15000,
    });

    // Track remaining requests from headers
    const remaining = response.headers['x-requests-remaining'];
    const used      = response.headers['x-requests-used'];
    if (remaining) logger.debug(`Odds API: ${remaining} requests remaining`);
    if (used) requestsUsed = parseInt(used);

    return response.data || [];
  } catch (err) {
    if (err.response?.status === 422) {
      // Sport not currently in season - skip silently
      return [];
    }
    if (err.response?.status === 401) {
      logger.error('ODDS_API_KEY is invalid. Check your API key in Render environment.');
      return [];
    }
    if (err.response?.status === 429) {
      logger.warn('Odds API rate limit reached. Will retry next cycle.');
      return [];
    }
    logger.error(`Odds fetch error for ${sport.key}:`, err.message);
    return [];
  }
}

async function upsertEvent(client, game, sport) {
  // Upsert event
  await client.query(`
    INSERT INTO events (id, external_id, sport_id, home_team, away_team, league, commence_time, status)
    VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5, $6,
      CASE WHEN $6::timestamptz < NOW() THEN 'live' ELSE 'upcoming' END
    )
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
  `, [game.id, sport.name, game.home_team, game.away_team, sport.label, new Date(game.commence_time)]);

  // Get the event id
  const { rows } = await client.query('SELECT id FROM events WHERE external_id = $1', [game.id]);
  return rows[0]?.id;
}

async function upsertMarkets(client, eventId, bookmakers) {
  if (!bookmakers?.length || !eventId) return;

  // Use the best bookmaker available (prefer Pinnacle, then Bet365, then first available)
  const preferred = ['pinnacle', 'bet365', 'betfair', 'unibet'];
  let bm = null;
  for (const pref of preferred) {
    bm = bookmakers.find(b => b.key === pref);
    if (bm) break;
  }
  if (!bm) bm = bookmakers[0];
  if (!bm) return;

  const h2h = bm.markets?.find(m => m.key === 'h2h');
  if (!h2h?.outcomes) return;

  for (const outcome of h2h.outcomes) {
    await client.query(`
      INSERT INTO markets (id, event_id, market_type, outcome, odds, bookmaker, is_active, updated_at)
      VALUES (uuid_generate_v4(), $1, 'h2h', $2, $3, $4, true, NOW())
      ON CONFLICT (event_id, market_type, outcome) DO UPDATE SET
        odds      = EXCLUDED.odds,
        bookmaker = EXCLUDED.bookmaker,
        updated_at = NOW()
    `, [eventId, outcome.name, parseFloat(outcome.price), bm.key]);
  }
}

async function syncAllOdds() {
  if (!ODDS_API_KEY) {
    logger.warn('ODDS_API_KEY not set — add it in Render Environment Variables');
    return;
  }

  let totalEvents = 0;

  for (const sport of SPORTS) {
    const games = await fetchSportOdds(sport);
    if (!games.length) continue;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (const game of games) {
        const eventId = await upsertEvent(client, game, sport);
        if (eventId) {
          await upsertMarkets(client, eventId, game.bookmakers);
          totalEvents++;
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error(`Error syncing ${sport.key}:`, err.message);
    } finally {
      client.release();
    }

    // Small delay between sports to avoid rate limiting
    await new Promise(r => setTimeout(r, 1000));
  }

  if (totalEvents > 0) {
    logger.info(`Odds sync complete: ${totalEvents} events updated`);

    // Broadcast to WebSocket clients
    try {
      const { rows } = await pool.query(`
        SELECT e.*,
          json_agg(json_build_object(
            'id', m.id, 'market_type', m.market_type,
            'outcome', m.outcome, 'odds', m.odds
          )) FILTER (WHERE m.id IS NOT NULL) as markets
        FROM events e
        LEFT JOIN markets m ON m.event_id = e.id AND m.is_active = true
        WHERE e.status IN ('upcoming', 'live')
        GROUP BY e.id
        ORDER BY e.commence_time ASC
        LIMIT 100
      `);

      if (global.broadcastOdds) {
        global.broadcastOdds({ type: 'odds_update', events: rows, timestamp: Date.now() });
      }
    } catch (err) {
      logger.error('Broadcast error:', err.message);
    }
  }
}

// Ensure unique index exists
pool.query(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_markets_unique
  ON markets (event_id, market_type, outcome)
`).catch(() => {});

// Run immediately on startup after 5 seconds
setTimeout(() => {
  logger.info('Running initial odds sync...');
  syncAllOdds();
}, 5000);

// Then run every 5 minutes
// This uses ~14 requests per cycle (14 sports) x 288 cycles/day = ~4032 requests/month
// Well within the 500/month free limit if we reduce to every 2 hours for free tier
cron.schedule('*/10 * * * *', syncAllOdds); // Every 10 minutes = ~2000 requests/month

logger.info('✅ Odds poller started — syncing every 10 minutes');

module.exports = { syncAllOdds };

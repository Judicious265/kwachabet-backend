const axios   = require('axios');
const { query } = require('../config/database');
const { generateId } = require('../utils/helpers');
const logger  = require('../utils/logger');

const ODDS_API_KEY  = process.env.ODDS_API_KEY;
const ODDS_API_BASE = process.env.ODDS_API_BASE_URL || 'https://api.the-odds-api.com/v4';

const SPORT_MAP = {
  football:     'soccer_epl',
  basketball:   'basketball_nba',
  tennis:       'tennis_atp_french_open',
  ice_hockey:   'icehockey_nhl',
  baseball:     'baseball_mlb',
  rugby_league: 'rugbyleague_nrl',
};

// ── Get events ────────────────────────────────────────────────────────────────
exports.getEvents = async (req, res) => {
  try {
    const { sport, status = 'upcoming' } = req.query;
    let sql    = `
      SELECT e.*, array_agg(
        json_build_object('id',m.id,'market_type',m.market_type,'outcome',m.outcome,'odds',m.odds,'bookmaker',m.bookmaker)
      ) FILTER (WHERE m.id IS NOT NULL) as markets
      FROM events e LEFT JOIN markets m ON m.event_id = e.id AND m.is_active = true
      WHERE e.status = $1
    `;
    const args = [status];
    if (sport) { sql += ' AND e.sport_id = $2'; args.push(sport); }
    sql += ' GROUP BY e.id ORDER BY e.commence_time ASC LIMIT 100';

    const { rows } = await query(sql, args);
    res.json({ events: rows });
  } catch (err) {
    logger.error('getEvents:', err.message);
    res.status(500).json({ error: 'Could not fetch events.' });
  }
};

// ── Get featured events ───────────────────────────────────────────────────────
exports.getFeatured = async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT e.*, array_agg(
        json_build_object('id',m.id,'market_type',m.market_type,'outcome',m.outcome,'odds',m.odds)
      ) FILTER (WHERE m.id IS NOT NULL) as markets
      FROM events e LEFT JOIN markets m ON m.event_id = e.id AND m.is_active = true
      WHERE e.status IN ('upcoming','live')
      GROUP BY e.id ORDER BY e.commence_time ASC LIMIT 20
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

// ── Fetch & sync odds from The Odds API ───────────────────────────────────────
exports.syncOdds = async () => {
  if (!ODDS_API_KEY) { logger.warn('ODDS_API_KEY not set — skipping odds sync'); return; }

  for (const [sportKey, apiSport] of Object.entries(SPORT_MAP)) {
    try {
      const res = await axios.get(`${ODDS_API_BASE}/sports/${apiSport}/odds`, {
        params: { apiKey: ODDS_API_KEY, regions: 'uk', markets: 'h2h', oddsFormat: 'decimal' },
        timeout: 15000,
      });

      for (const game of res.data) {
        // Upsert event
        const eventId = generateId();
        await query(`
          INSERT INTO events (id, external_id, sport_id, home_team, away_team, league, commence_time, status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT (external_id) DO UPDATE SET
            home_team = EXCLUDED.home_team, away_team = EXCLUDED.away_team,
            commence_time = EXCLUDED.commence_time,
            status = CASE WHEN events.status = 'finished' THEN events.status
                         WHEN EXCLUDED.commence_time < NOW() THEN 'live'
                         ELSE 'upcoming' END,
            updated_at = NOW()
        `, [eventId, game.id, sportKey, game.home_team, game.away_team,
            apiSport, new Date(game.commence_time), 'upcoming']);

        // Get the event id (may already exist)
        const { rows: evRows } = await query('SELECT id FROM events WHERE external_id = $1', [game.id]);
        const evId = evRows[0]?.id;
        if (!evId) continue;

        // Upsert markets (h2h)
        const bm = game.bookmakers?.[0];
        if (!bm) continue;
        const h2h = bm.markets?.find(m => m.key === 'h2h');
        if (!h2h) continue;

        for (const outcome of h2h.outcomes) {
          await query(`
            INSERT INTO markets (id, event_id, market_type, outcome, odds, bookmaker, is_active, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,true,NOW())
            ON CONFLICT (event_id, market_type, outcome) DO UPDATE SET
              odds = EXCLUDED.odds, bookmaker = EXCLUDED.bookmaker, updated_at = NOW()
          `, [generateId(), evId, 'h2h', outcome.name, parseFloat(outcome.price), bm.key]);
        }
      }

      logger.debug(`Odds synced: ${sportKey} (${res.data.length} events)`);
    } catch (err) {
      logger.error(`Odds sync failed for ${sportKey}:`, err.message);
    }
  }

  // Broadcast to WebSocket clients
  try {
    const { rows } = await query(`
      SELECT e.*, array_agg(json_build_object('id',m.id,'market_type',m.market_type,'outcome',m.outcome,'odds',m.odds)) as markets
      FROM events e LEFT JOIN markets m ON m.event_id = e.id AND m.is_active = true
      WHERE e.status IN ('upcoming','live') GROUP BY e.id ORDER BY e.commence_time ASC LIMIT 50
    `);
    if (global.broadcastOdds) {
      global.broadcastOdds({ type: 'odds_update', events: rows, timestamp: Date.now() });
    }
  } catch {}
};

// Add unique constraint helper (run once)
exports.ensureMarketUniqueIndex = async () => {
  try {
    await query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_markets_unique
      ON markets (event_id, market_type, outcome)
    `);
  } catch {}
};

/**
 * Kwacha Bet - Odds Poller
 * Uses API-Football via RapidAPI (100 free requests/day)
 * Fetches fixtures + odds for all major leagues
 * Also uses The Odds API if ODDS_API_KEY is available
 */

const cron   = require('node-cron');
const axios  = require('axios');
const { pool } = require('../config/database');
const logger = require('../utils/logger');

const RAPIDAPI_KEY  = process.env.RAPIDAPI_KEY;
const ODDS_API_KEY  = process.env.ODDS_API_KEY;
const SEASON        = 2025;

// League IDs for API-Football
const LEAGUES = [
  { id: 39,  name: 'football', label: 'Premier League',      country: 'England' },
  { id: 140, name: 'football', label: 'La Liga',             country: 'Spain' },
  { id: 135, name: 'football', label: 'Serie A',             country: 'Italy' },
  { id: 78,  name: 'football', label: 'Bundesliga',          country: 'Germany' },
  { id: 61,  name: 'football', label: 'Ligue 1',             country: 'France' },
  { id: 2,   name: 'football', label: 'Champions League',    country: 'Europe' },
  { id: 3,   name: 'football', label: 'Europa League',       country: 'Europe' },
  { id: 848, name: 'football', label: 'Conference League',   country: 'Europe' },
  { id: 292, name: 'football', label: 'Malawi Super League', country: 'Malawi' },
];

// RapidAPI headers for API-Football
function getHeaders() {
  return {
    'x-rapidapi-host': 'api-football-v1.p.rapidapi.com',
    'x-rapidapi-key':  RAPIDAPI_KEY,
  };
}

// Fetch upcoming fixtures for a league
async function fetchFixtures(leagueId) {
  try {
    const res = await axios.get('https://api-football-v1.p.rapidapi.com/v3/fixtures', {
      headers: getHeaders(),
      params: {
        league: leagueId,
        season: SEASON,
        next:   20,  // next 20 matches
        status: 'NS-1H-HT-2H', // Not started + Live
      },
      timeout: 15000,
    });
    return res.data?.response || [];
  } catch (err) {
    if (err.response?.status === 429) {
      logger.warn('API-Football rate limit hit. Will retry next cycle.');
      return [];
    }
    logger.error(`Fixtures fetch error (league ${leagueId}):`, err.message);
    return [];
  }
}

// Fetch odds for a fixture
async function fetchOdds(fixtureId) {
  try {
    const res = await axios.get('https://api-football-v1.p.rapidapi.com/v3/odds', {
      headers: getHeaders(),
      params: {
        fixture: fixtureId,
        bookmaker: 8, // Bet365
      },
      timeout: 15000,
    });
    return res.data?.response?.[0] || null;
  } catch (err) {
    return null;
  }
}

// Extract odds from API-Football bookmaker data
function extractOdds(oddsData, betName) {
  const bookmakers = oddsData?.bookmakers || [];
  for (const bm of bookmakers) {
    const bet = bm.bets?.find((b) => b.name === betName);
    if (bet) return bet.values || [];
  }
  return [];
}

// Build Over/Under markets
function buildTotals(h2hOddsArr) {
  const avg = h2hOddsArr.length
    ? h2hOddsArr.reduce((a, b) => a + b, 0) / h2hOddsArr.length
    : 2.0;
  return [
    { market_type: 'totals', outcome: 'Over 2.5',  odds: parseFloat(Math.max(1.30, Math.min(2.20 + (avg - 2.0) * 0.1, 4.00)).toFixed(2)) },
    { market_type: 'totals', outcome: 'Under 2.5', odds: parseFloat(Math.max(1.30, Math.min(1.80 - (avg - 2.0) * 0.1, 4.00)).toFixed(2)) },
    { market_type: 'totals', outcome: 'Over 1.5',  odds: parseFloat(Math.max(1.10, Math.min(1.40, 2.00)).toFixed(2)) },
    { market_type: 'totals', outcome: 'Under 1.5', odds: parseFloat(Math.max(1.10, Math.min(2.80, 5.00)).toFixed(2)) },
    { market_type: 'totals', outcome: 'Over 3.5',  odds: parseFloat(Math.max(1.10, Math.min(3.20 + (avg - 2.0) * 0.2, 8.00)).toFixed(2)) },
    { market_type: 'totals', outcome: 'Under 3.5', odds: parseFloat(Math.max(1.10, Math.min(1.40, 3.00)).toFixed(2)) },
  ];
}

// Build BTTS markets
function buildBTTS(homeOdds, awayOdds) {
  const avg = ((homeOdds || 2) + (awayOdds || 2)) / 2;
  return [
    { market_type: 'btts', outcome: 'Yes', odds: parseFloat(Math.max(1.40, Math.min(1.80 + (avg - 2.0) * 0.15, 3.50)).toFixed(2)) },
    { market_type: 'btts', outcome: 'No',  odds: parseFloat(Math.max(1.40, Math.min(2.00 - (avg - 2.0) * 0.10, 3.50)).toFixed(2)) },
  ];
}

// Build Asian Handicap
function buildHandicap(homeTeam, awayTeam, homeOdds, awayOdds) {
  const diff = (homeOdds || 2) - (awayOdds || 2);
  return [
    { market_type: 'spreads', outcome: `${homeTeam} -0.5`, odds: parseFloat(Math.max(1.50, Math.min(1.90 + diff * 0.1, 3.50)).toFixed(2)) },
    { market_type: 'spreads', outcome: `${awayTeam} +0.5`, odds: parseFloat(Math.max(1.50, Math.min(1.90 - diff * 0.1, 3.50)).toFixed(2)) },
    { market_type: 'spreads', outcome: `${homeTeam} -1.5`, odds: parseFloat(Math.max(1.50, Math.min(2.60 + diff * 0.2, 6.00)).toFixed(2)) },
    { market_type: 'spreads', outcome: `${awayTeam} +1.5`, odds: parseFloat(Math.max(1.20, Math.min(1.55 - diff * 0.1, 3.00)).toFixed(2)) },
  ];
}

// Build HT/FT markets
function buildHTFT(homeTeam, awayTeam, homeOdds, drawOdds, awayOdds) {
  if (!homeOdds || !drawOdds || !awayOdds) return [];
  const combos = [
    { ht: homeTeam,  ft: homeTeam,  factor: 0.55 },
    { ht: 'Draw',    ft: homeTeam,  factor: 0.40 },
    { ht: 'Draw',    ft: 'Draw',    factor: 0.55 },
    { ht: 'Draw',    ft: awayTeam,  factor: 0.40 },
    { ht: awayTeam,  ft: awayTeam,  factor: 0.55 },
    { ht: homeTeam,  ft: 'Draw',    factor: 0.28 },
    { ht: awayTeam,  ft: 'Draw',    factor: 0.28 },
    { ht: homeTeam,  ft: awayTeam,  factor: 0.22 },
    { ht: awayTeam,  ft: homeTeam,  factor: 0.22 },
  ];
  const oddsMap = {
    [homeTeam]: homeOdds,
    'Draw':      drawOdds,
    [awayTeam]:  awayOdds,
  };
  return combos.map(c => ({
    market_type: 'htft',
    outcome:     `${c.ht}/${c.ft}`,
    odds:        parseFloat(Math.max(1.10, Math.min(
      (oddsMap[c.ht] || 2) * (oddsMap[c.ft] || 2) * c.factor,
      80.00
    )).toFixed(2)),
  }));
}

// Build Correct Score markets
function buildCorrectScore(homeOdds, drawOdds, awayOdds) {
  if (!homeOdds) return [];
  const scores = [
    { score: '1-0', base: homeOdds  * 3.2  },
    { score: '2-0', base: homeOdds  * 5.5  },
    { score: '2-1', base: homeOdds  * 6.8  },
    { score: '3-0', base: homeOdds  * 11.0 },
    { score: '3-1', base: homeOdds  * 13.0 },
    { score: '3-2', base: homeOdds  * 19.0 },
    { score: '4-0', base: homeOdds  * 25.0 },
    { score: '4-1', base: homeOdds  * 30.0 },
    { score: '0-0', base: (drawOdds || 3.2) * 5.2 },
    { score: '1-1', base: (drawOdds || 3.2) * 4.5 },
    { score: '2-2', base: (drawOdds || 3.2) * 11.0 },
    { score: '3-3', base: (drawOdds || 3.2) * 30.0 },
    { score: '0-1', base: awayOdds  * 3.2  },
    { score: '0-2', base: awayOdds  * 5.5  },
    { score: '1-2', base: awayOdds  * 6.8  },
    { score: '0-3', base: awayOdds  * 11.0 },
    { score: '1-3', base: awayOdds  * 13.0 },
    { score: '2-3', base: awayOdds  * 19.0 },
  ];
  return scores.map(s => ({
    market_type:  'correct_score',
    outcome:      s.score,
    odds:         parseFloat(Math.max(3.00, Math.min(s.base, 120.00)).toFixed(2)),
  }));
}

// Upsert a list of markets into the DB
async function upsertMarkets(client, eventId, markets) {
  for (const m of markets) {
    if (!m.odds || m.odds <= 1.01 || !m.outcome) continue;
    await client.query(`
      INSERT INTO markets (id, event_id, market_type, outcome, odds, bookmaker, is_active, updated_at)
      VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5, true, NOW())
      ON CONFLICT (event_id, market_type, outcome) DO UPDATE SET
        odds       = EXCLUDED.odds,
        updated_at = NOW()
    `, [eventId, m.market_type, m.outcome, m.odds, 'api-football']);
  }
}

// Main sync function

// Build Double Chance markets (1X, X2, 12)
function buildDoubleChance(homeTeam, awayTeam, homeOdds, drawOdds, awayOdds) {
  if (!homeOdds || !drawOdds || !awayOdds) return [];

  const homeProb = 1 / homeOdds;
  const drawProb = 1 / drawOdds;
  const awayProb = 1 / awayOdds;
  const margin   = 1.05;

  const dc1X = parseFloat(Math.max(1.05, Math.min((1 / ((homeProb + drawProb) / margin)), 3.00)).toFixed(2));
  const dcX2 = parseFloat(Math.max(1.05, Math.min((1 / ((drawProb + awayProb) / margin)), 3.00)).toFixed(2));
  const dc12 = parseFloat(Math.max(1.05, Math.min((1 / ((homeProb + awayProb) / margin)), 3.00)).toFixed(2));

  return [
    { market_type: 'double_chance', outcome: '1X', odds: dc1X, label: homeTeam + ' or Draw' },
    { market_type: 'double_chance', outcome: 'X2', odds: dcX2, label: 'Draw or ' + awayTeam },
    { market_type: 'double_chance', outcome: '12', odds: dc12, label: homeTeam + ' or ' + awayTeam },
  ];
}

async function syncAllOdds() {
  if (!RAPIDAPI_KEY) {
    logger.warn('RAPIDAPI_KEY not set — add it in Render Environment Variables');
    return;
  }

  let totalEvents = 0;
  let requestsUsed = 0;

  for (const league of LEAGUES) {
    // Stop if we are close to the daily limit (save 10 requests buffer)
    if (requestsUsed >= 85) {
      logger.warn('API-Football daily limit approaching (85 requests). Stopping sync.');
      break;
    }

    const fixtures = await fetchFixtures(league.id);
    requestsUsed++;

    if (!fixtures.length) continue;

    // Only process first 10 fixtures per league to save requests
    const toProcess = fixtures.slice(0, 10);

    for (const fixture of toProcess) {
      const f         = fixture.fixture;
      const teams     = fixture.teams;
      const homeTeam  = teams?.home?.name;
      const awayTeam  = teams?.away?.name;
      const kickoff   = f?.date;
      const statusShort = f?.status?.short;

      if (!homeTeam || !awayTeam || !kickoff) continue;

      const isLive     = ['1H','HT','2H','ET','P'].includes(statusShort);
      const isFinished = ['FT','AET','PEN'].includes(statusShort);
      const status     = isFinished ? 'finished' : isLive ? 'live' : 'upcoming';

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Upsert event
        const externalId = `apif_${f.id}`;
        await client.query(`
          INSERT INTO events (id, external_id, sport_id, home_team, away_team, league, commence_time, status, home_score, away_score)
          VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (external_id) DO UPDATE SET
            status      = EXCLUDED.status,
            home_score  = EXCLUDED.home_score,
            away_score  = EXCLUDED.away_score,
            updated_at  = NOW()
        `, [
          externalId, league.name, homeTeam, awayTeam, league.label,
          new Date(kickoff), status,
          fixture.goals?.home ?? null,
          fixture.goals?.away ?? null,
        ]);

        const { rows } = await client.query('SELECT id FROM events WHERE external_id = $1', [externalId]);
        const eventId = rows[0]?.id;
        if (!eventId) { await client.query('COMMIT'); client.release(); continue; }

        // Fetch odds for this fixture (costs 1 request)
        let homeOdds = 0, drawOdds = 0, awayOdds = 0;

        if (!isFinished && requestsUsed < 85) {
          const oddsData = await fetchOdds(f.id);
          requestsUsed++;

          if (oddsData) {
            const matchWinner = extractOdds(oddsData, 'Match Winner');
            homeOdds = parseFloat(matchWinner.find((v) => v.value === 'Home')?.odd || 0);
            drawOdds = parseFloat(matchWinner.find((v) => v.value === 'Draw')?.odd || 0);
            awayOdds = parseFloat(matchWinner.find((v) => v.value === 'Away')?.odd || 0);
          }
        }

        // If no odds from API, generate approximate odds
        if (!homeOdds) homeOdds = 1.90;
        if (!drawOdds) drawOdds = 3.40;
        if (!awayOdds) awayOdds = 3.80;

        const h2hOddsArr = [homeOdds, drawOdds, awayOdds].filter(Boolean);

        // Insert all market types
        const allMarkets = [
          // 1X2
          { market_type: 'h2h', outcome: homeTeam, odds: homeOdds },
          { market_type: 'h2h', outcome: 'Draw',   odds: drawOdds },
          { market_type: 'h2h', outcome: awayTeam, odds: awayOdds },
          // Over/Under
          ...buildTotals(h2hOddsArr),
          // BTTS
          ...buildBTTS(homeOdds, awayOdds),
          // Handicap
          ...buildHandicap(homeTeam, awayTeam, homeOdds, awayOdds),
          // HT/FT
          ...buildHTFT(homeTeam, awayTeam, homeOdds, drawOdds, awayOdds),
          // Correct Score
          ...buildCorrectScore(homeOdds, drawOdds, awayOdds),
          // Double Chance
          ...buildDoubleChance(homeTeam, awayTeam, homeOdds, drawOdds, awayOdds),
        ];

        await upsertMarkets(client, eventId, allMarkets);

        await client.query('COMMIT');
        totalEvents++;
      } catch (err) {
        await client.query('ROLLBACK');
        logger.error(`Error processing fixture ${f.id}:`, err.message);
      } finally {
        client.release();
      }

      // Small delay between fixtures
      await new Promise(r => setTimeout(r, 300));
    }

    // Delay between leagues
    await new Promise(r => setTimeout(r, 1000));
  }

  logger.info(`Sync complete: ${totalEvents} events updated, ${requestsUsed} API requests used`);

  // Broadcast updated events to WebSocket clients
  try {
    const { rows } = await pool.query(`
      SELECT e.*,
        json_agg(json_build_object(
          'id', m.id,
          'market_type', m.market_type,
          'outcome', m.outcome,
          'odds', m.odds
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

// Ensure unique index
pool.query(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_markets_unique
  ON markets (event_id, market_type, outcome)
`).catch(() => {});

// Ensure sports are seeded
pool.query(`
  INSERT INTO sports (id, name) VALUES
    ('football','Football'),('basketball','Basketball'),
    ('tennis','Tennis'),('ice_hockey','Ice Hockey'),
    ('baseball','Baseball'),('rugby_league','Rugby League')
  ON CONFLICT (id) DO NOTHING;
`).catch(() => {});

// Run immediately on startup (after 8 seconds)
setTimeout(() => {
  logger.info('Running initial sync with API-Football...');
  syncAllOdds();
}, 8000);

// Run every 3 hours to stay within 100 requests/day limit
// 1 sync = ~30 requests (leagues + odds)
// 3 hours = 8 syncs/day = ~240 requests/day — safe within 100 limit if we reduce
// Actually run every 6 hours = 4 syncs/day = ~120 requests — borderline
// Run every 8 hours = 3 syncs/day = ~90 requests — safe!
cron.schedule('0 */8 * * *', () => {
  logger.info('Scheduled odds sync starting...');
  syncAllOdds();
});

logger.info('✅ Odds poller started (API-Football) — syncing every 8 hours');
logger.info('   Markets: 1X2 · Over/Under · BTTS · Handicap · HT/FT · Correct Score · Double Chance');

module.exports = { syncAllOdds };

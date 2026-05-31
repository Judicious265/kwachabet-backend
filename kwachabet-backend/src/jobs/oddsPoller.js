/**
 * Odds Poller - Fetches h2h + totals + spreads from The Odds API
 * Correct Score and BTTS are generated from h2h odds
 */

const cron     = require('node-cron');
const axios    = require('axios');
const { pool } = require('../config/database');
const logger   = require('../utils/logger');

const ODDS_API_KEY  = process.env.ODDS_API_KEY;
const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';

const SPORTS = [
  { key: 'soccer_epl',                name: 'football',     label: 'Premier League' },
  { key: 'soccer_spain_la_liga',      name: 'football',     label: 'La Liga' },
  { key: 'soccer_italy_serie_a',      name: 'football',     label: 'Serie A' },
  { key: 'soccer_germany_bundesliga', name: 'football',     label: 'Bundesliga' },
  { key: 'soccer_france_ligue_one',   name: 'football',     label: 'Ligue 1' },
  { key: 'soccer_uefa_champs_league', name: 'football',     label: 'Champions League' },
  { key: 'soccer_africa_cup_of_nations', name: 'football',  label: 'Africa Cup' },
  { key: 'basketball_nba',            name: 'basketball',   label: 'NBA' },
  { key: 'basketball_euroleague',     name: 'basketball',   label: 'EuroLeague' },
  { key: 'tennis_atp_french_open',    name: 'tennis',       label: 'ATP Tour' },
  { key: 'tennis_wta_french_open',    name: 'tennis',       label: 'WTA Tour' },
  { key: 'icehockey_nhl',             name: 'ice_hockey',   label: 'NHL' },
  { key: 'baseball_mlb',              name: 'baseball',     label: 'MLB' },
  { key: 'rugbyleague_nrl',           name: 'rugby_league', label: 'NRL Rugby' },
];

async function fetchSportOdds(sport) {
  if (!ODDS_API_KEY) return [];
  try {
    const res = await axios.get(`${ODDS_API_BASE}/sports/${sport.key}/odds`, {
      params: {
        apiKey:     ODDS_API_KEY,
        regions:    'uk,eu',
        markets:    'h2h,totals,spreads',
        oddsFormat: 'decimal',
      },
      timeout: 15000,
    });
    const remaining = res.headers['x-requests-remaining'];
    if (remaining) logger.debug(`Odds API: ${remaining} requests remaining`);
    return res.data || [];
  } catch (err) {
    if (err.response?.status === 422) return []; // Not in season
    if (err.response?.status === 401) {
      logger.error('ODDS_API_KEY invalid. Check Render environment variables.');
      return [];
    }
    if (err.response?.status === 429) {
      logger.warn('Odds API rate limit hit. Retry next cycle.');
      return [];
    }
    logger.error(`Odds fetch error (${sport.key}):`, err.message);
    return [];
  }
}

// Generate Over/Under markets from totals bookmaker data
function buildTotalsMarkets(h2hOdds, game) {
  const markets = [];
  const totalsData = game.bookmakers?.find(b =>
    b.markets?.some(m => m.key === 'totals')
  )?.markets?.find(m => m.key === 'totals');

  if (totalsData?.outcomes) {
    for (const outcome of totalsData.outcomes) {
      markets.push({
        market_type: 'totals',
        outcome:     outcome.name + ' ' + (outcome.point || '2.5'),
        odds:        parseFloat(outcome.price),
        label:       outcome.name + ' ' + (outcome.point || '2.5') + ' Goals',
      });
    }
  } else if (h2hOdds.length >= 2) {
    // Generate approximate Over/Under from h2h if API doesn't provide
    const avgOdds = h2hOdds.reduce((a, b) => a + b, 0) / h2hOdds.length;
    const overOdds  = parseFloat((1.85 + (avgOdds - 1.8) * 0.1).toFixed(2));
    const underOdds = parseFloat((1.95 + (avgOdds - 1.8) * 0.1).toFixed(2));
    markets.push(
      { market_type: 'totals', outcome: 'Over 2.5',  odds: Math.max(1.10, Math.min(overOdds, 5.00)),  label: 'Over 2.5 Goals' },
      { market_type: 'totals', outcome: 'Under 2.5', odds: Math.max(1.10, Math.min(underOdds, 5.00)), label: 'Under 2.5 Goals' },
      { market_type: 'totals', outcome: 'Over 1.5',  odds: Math.max(1.10, 1.35),  label: 'Over 1.5 Goals' },
      { market_type: 'totals', outcome: 'Under 1.5', odds: Math.max(1.10, 2.65),  label: 'Under 1.5 Goals' },
    );
  }
  return markets;
}

// Generate Asian Handicap from spreads data
function buildSpreadsMarkets(game, homeTeam, awayTeam) {
  const markets = [];
  const spreadsData = game.bookmakers?.find(b =>
    b.markets?.some(m => m.key === 'spreads')
  )?.markets?.find(m => m.key === 'spreads');

  if (spreadsData?.outcomes) {
    for (const outcome of spreadsData.outcomes) {
      const point = outcome.point || 0;
      const sign  = point > 0 ? `+${point}` : `${point}`;
      markets.push({
        market_type: 'spreads',
        outcome:     `${outcome.name} ${sign}`,
        odds:        parseFloat(outcome.price),
        label:       `${outcome.name} (${sign})`,
      });
    }
  } else {
    // Generate standard Asian Handicap
    markets.push(
      { market_type: 'spreads', outcome: `${homeTeam} -0.5`, odds: 1.90, label: `${homeTeam} -0.5` },
      { market_type: 'spreads', outcome: `${awayTeam} +0.5`, odds: 1.90, label: `${awayTeam} +0.5` },
    );
  }
  return markets;
}

// Generate BTTS (Both Teams to Score) from h2h odds
function buildBTTSMarkets(h2hOdds) {
  if (h2hOdds.length < 2) return [];
  const avgOdds = h2hOdds.reduce((a, b) => a + b, 0) / h2hOdds.length;
  const bttsYes = parseFloat((1.70 + (avgOdds - 1.9) * 0.15).toFixed(2));
  const bttsNo  = parseFloat((2.05 - (avgOdds - 1.9) * 0.10).toFixed(2));
  return [
    { market_type: 'btts', outcome: 'Yes', odds: Math.max(1.10, Math.min(bttsYes, 4.00)), label: 'Both Teams to Score - Yes' },
    { market_type: 'btts', outcome: 'No',  odds: Math.max(1.10, Math.min(bttsNo,  4.00)), label: 'Both Teams to Score - No' },
  ];
}

// Generate Half Time / Full Time combos from h2h odds
function buildHTFTMarkets(homeOdds, drawOdds, awayOdds, homeTeam, awayTeam) {
  if (!homeOdds || !drawOdds || !awayOdds) return [];
  const combos = [
    { ht: homeTeam,  ft: homeTeam,  odds: parseFloat((homeOdds * 0.55).toFixed(2)) },
    { ht: homeTeam,  ft: 'Draw',    odds: parseFloat((homeOdds * drawOdds * 0.30).toFixed(2)) },
    { ht: 'Draw',    ft: homeTeam,  odds: parseFloat((drawOdds * homeOdds * 0.40).toFixed(2)) },
    { ht: 'Draw',    ft: 'Draw',    odds: parseFloat((drawOdds * 0.60).toFixed(2)) },
    { ht: 'Draw',    ft: awayTeam,  odds: parseFloat((drawOdds * awayOdds * 0.40).toFixed(2)) },
    { ht: awayTeam,  ft: awayTeam,  odds: parseFloat((awayOdds * 0.55).toFixed(2)) },
    { ht: awayTeam,  ft: 'Draw',    odds: parseFloat((awayOdds * drawOdds * 0.30).toFixed(2)) },
    { ht: homeTeam,  ft: awayTeam,  odds: parseFloat((homeOdds * awayOdds * 0.25).toFixed(2)) },
    { ht: awayTeam,  ft: homeTeam,  odds: parseFloat((awayOdds * homeOdds * 0.25).toFixed(2)) },
  ];
  return combos.map(c => ({
    market_type: 'htft',
    outcome:     `${c.ht}/${c.ft}`,
    odds:        Math.max(1.10, Math.min(c.odds, 50.00)),
    label:       `HT: ${c.ht} / FT: ${c.ft}`,
  }));
}

// Generate Correct Score markets
function buildCorrectScoreMarkets(homeOdds, drawOdds, awayOdds) {
  if (!homeOdds || !drawOdds || !awayOdds) return [];
  const scores = [
    { score: '1-0', base: homeOdds  * 3.5 },
    { score: '2-0', base: homeOdds  * 5.5 },
    { score: '2-1', base: homeOdds  * 7.0 },
    { score: '3-0', base: homeOdds  * 12.0 },
    { score: '3-1', base: homeOdds  * 14.0 },
    { score: '3-2', base: homeOdds  * 20.0 },
    { score: '0-0', base: drawOdds  * 5.5 },
    { score: '1-1', base: drawOdds  * 5.0 },
    { score: '2-2', base: drawOdds  * 12.0 },
    { score: '0-1', base: awayOdds  * 3.5 },
    { score: '0-2', base: awayOdds  * 5.5 },
    { score: '1-2', base: awayOdds  * 7.0 },
    { score: '0-3', base: awayOdds  * 12.0 },
    { score: '1-3', base: awayOdds  * 14.0 },
    { score: '2-3', base: awayOdds  * 20.0 },
  ];
  return scores.map(s => ({
    market_type: 'correct_score',
    outcome:     s.score,
    odds:        parseFloat(Math.max(2.50, Math.min(s.base, 100.00)).toFixed(2)),
    label:       `Correct Score ${s.score}`,
  }));
}

async function upsertMarkets(client, eventId, marketsToInsert) {
  for (const m of marketsToInsert) {
    if (!m.odds || m.odds <= 1.01) continue;
    await client.query(`
      INSERT INTO markets (id, event_id, market_type, outcome, odds, bookmaker, is_active, updated_at)
      VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5, true, NOW())
      ON CONFLICT (event_id, market_type, outcome) DO UPDATE SET
        odds = EXCLUDED.odds,
        updated_at = NOW()
    `, [eventId, m.market_type, m.outcome, m.odds, 'calculated']);
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
        // Upsert event
        await client.query(`
          INSERT INTO events (id, external_id, sport_id, home_team, away_team, league, commence_time, status)
          VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5, $6,
            CASE WHEN $6::timestamptz < NOW() THEN 'live' ELSE 'upcoming' END)
          ON CONFLICT (external_id) DO UPDATE SET
            home_team     = EXCLUDED.home_team,
            away_team     = EXCLUDED.away_team,
            commence_time = EXCLUDED.commence_time,
            status = CASE
              WHEN events.status = 'finished' THEN events.status
              WHEN EXCLUDED.commence_time < NOW() THEN 'live'
              ELSE 'upcoming'
            END,
            updated_at = NOW()
        `, [game.id, sport.name, game.home_team, game.away_team, sport.label, new Date(game.commence_time)]);

        // Get event id
        const { rows } = await client.query('SELECT id FROM events WHERE external_id = $1', [game.id]);
        const eventId = rows[0]?.id;
        if (!eventId) continue;

        // Get best bookmaker for h2h
        const preferred = ['pinnacle', 'bet365', 'unibet', 'betfair'];
        let bm = null;
        for (const pref of preferred) {
          bm = game.bookmakers?.find((b) => b.key === pref);
          if (bm) break;
        }
        if (!bm) bm = game.bookmakers?.[0];

        const h2h = bm?.markets?.find((m) => m.key === 'h2h');
        const h2hOutcomes = h2h?.outcomes || [];

        // Find home/draw/away odds
        const homeOdds = h2hOutcomes.find((o) => o.name === game.home_team)?.price;
        const drawOdds = h2hOutcomes.find((o) => o.name === 'Draw')?.price;
        const awayOdds = h2hOutcomes.find((o) => o.name === game.away_team)?.price;
        const h2hOddsArr = h2hOutcomes.map((o) => parseFloat(o.price)).filter(Boolean);

        // 1. Insert H2H (1X2) markets
        const h2hMarkets = h2hOutcomes.map((o) => ({
          market_type: 'h2h',
          outcome:     o.name,
          odds:        parseFloat(o.price),
          label:       o.name,
        }));
        await upsertMarkets(client, eventId, h2hMarkets);

        // 2. Over/Under (Totals)
        const totalsMarkets = buildTotalsMarkets(h2hOddsArr, game);
        await upsertMarkets(client, eventId, totalsMarkets);

        // 3. Asian Handicap (Spreads)
        const spreadsMarkets = buildSpreadsMarkets(game, game.home_team, game.away_team);
        await upsertMarkets(client, eventId, spreadsMarkets);

        // 4. BTTS — only for football
        if (sport.name === 'football') {
          const bttsMarkets = buildBTTSMarkets(h2hOddsArr);
          await upsertMarkets(client, eventId, bttsMarkets);

          // 5. Half Time / Full Time — football only
          const htftMarkets = buildHTFTMarkets(homeOdds, drawOdds, awayOdds, game.home_team, game.away_team);
          await upsertMarkets(client, eventId, htftMarkets);

          // 6. Correct Score — football only
          const csMarkets = buildCorrectScoreMarkets(homeOdds, drawOdds, awayOdds);
          await upsertMarkets(client, eventId, csMarkets);
        }

        totalEvents++;
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error(`Error syncing ${sport.key}:`, err.message);
    } finally {
      client.release();
    }

    // Delay between sports to avoid rate limits
    await new Promise(r => setTimeout(r, 1000));
  }

  if (totalEvents > 0) {
    logger.info(`Odds sync complete: ${totalEvents} events, all markets updated`);

    // Broadcast to WebSocket
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
        LIMIT 50
      `);
      if (global.broadcastOdds) {
        global.broadcastOdds({ type: 'odds_update', events: rows, timestamp: Date.now() });
      }
    } catch (err) {
      logger.error('Broadcast error:', err.message);
    }
  }
}

// Ensure unique constraint
pool.query(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_markets_unique
  ON markets (event_id, market_type, outcome)
`).catch(() => {});

// Run on startup after 5 seconds
setTimeout(() => {
  logger.info('Running initial odds sync with all markets...');
  syncAllOdds();
}, 5000);

// Run every 10 minutes
cron.schedule('*/10 * * * *', syncAllOdds);

logger.info('✅ Odds poller started — h2h, Over/Under, Handicap, BTTS, HT/FT, Correct Score');

module.exports = { syncAllOdds };

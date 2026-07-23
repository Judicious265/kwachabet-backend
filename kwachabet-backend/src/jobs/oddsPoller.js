/**
 * Odds Poller — API-Football via RapidAPI
 * Syncs fixtures every 8 hours, cleans up stale events every hour
 */

const axios  = require('axios');
const cron   = require('node-cron');
const { query } = require('../config/database');
const { generateId } = require('../utils/helpers');
const logger = require('../utils/logger');

const RAPIDAPI_KEY  = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = 'api-football-v1.p.rapidapi.com';
const SEASON        = new Date().getFullYear();

// Leagues to track
const LEAGUES = [39, 140, 135, 78, 61, 94, 88, 253, 307];

// Sport mapping
const SPORT_MAP = {
  1:  'football',
  2:  'basketball',
  3:  'baseball',
  4:  'hockey',
  5:  'rugby_league',
};

// ── Cleanup stale events ──────────────────────────────────────────────────────
async function cleanupStaleEvents() {
  try {
    // Mark live events finished if started more than 3 hours ago
    const r1 = await query(`
      UPDATE events
      SET status = 'finished', updated_at = NOW()
      WHERE status = 'live'
      AND commence_time < NOW() - INTERVAL '3 hours'
    `);
    if (r1.rowCount > 0) logger.info('Cleaned up ' + r1.rowCount + ' stale live events');

    // Mark upcoming events as live if kickoff has passed
    const r2 = await query(`
      UPDATE events
      SET status = 'live', updated_at = NOW()
      WHERE status = 'upcoming'
      AND commence_time <= NOW()
      AND commence_time > NOW() - INTERVAL '3 hours'
    `);
    if (r2.rowCount > 0) logger.info('Marked ' + r2.rowCount + ' events as live');

    // Broadcast updated events
    if (global.broadcastOdds) {
      const upd = await query(`
        SELECT e.*,
          json_agg(json_build_object(
            'id', m.id, 'market_type', m.market_type,
            'outcome', m.outcome, 'odds', m.odds, 'line', m.line
          )) FILTER (WHERE m.id IS NOT NULL) as markets
        FROM events e
        LEFT JOIN markets m ON m.event_id = e.id AND m.is_active = true
        WHERE e.status IN ('upcoming', 'live')
        GROUP BY e.id ORDER BY e.commence_time ASC LIMIT 100
      `);
      global.broadcastOdds({ type: 'odds_update', events: upd.rows, timestamp: Date.now() });
    }
  } catch (err) {
    logger.error('cleanupStaleEvents: ' + err.message);
  }
}

// ── Fetch fixtures from API-Football ─────────────────────────────────────────
async function fetchFixtures(leagueId) {
  if (!RAPIDAPI_KEY) {
    logger.warn('RAPIDAPI_KEY not set — skipping API-Football sync');
    return [];
  }
  try {
    const today = new Date().toISOString().split('T')[0];
    const res   = await axios.get('https://' + RAPIDAPI_HOST + '/v3/fixtures', {
      params:  { league: leagueId, season: SEASON, date: today },
      headers: { 'X-RapidAPI-Key': RAPIDAPI_KEY, 'X-RapidAPI-Host': RAPIDAPI_HOST },
      timeout: 10000,
    });
    const remaining = res.headers['x-ratelimit-requests-remaining'];
    if (remaining === '0') {
      logger.warn('API-Football rate limit hit. Will retry next cycle.');
      return [];
    }
    return res.data.response || [];
  } catch (err) {
    if (err.response && err.response.status === 429) {
      logger.warn('API-Football rate limit hit. Will retry next cycle.');
    } else {
      logger.error('Fixtures fetch error (league ' + leagueId + '): ' + err.message);
    }
    return [];
  }
}

// ── Sync fixtures to database ─────────────────────────────────────────────────
async function syncFixtures() {
  logger.info('Starting fixtures sync...');
  let synced = 0;

  for (const leagueId of LEAGUES) {
    const fixtures = await fetchFixtures(leagueId);

    for (const f of fixtures) {
      try {
        const fixture   = f.fixture;
        const teams     = f.teams;
        const leagueInfo= f.league;
        const goals     = f.goals;
        const extId     = 'apifootball_' + fixture.id;

        // Determine status
        let status = 'upcoming';
        const short = fixture.status && fixture.status.short;
        if (['1H','HT','2H','ET','BT','P'].includes(short)) status = 'live';
        if (['FT','AET','PEN'].includes(short))              status = 'finished';

        const homeScore = (goals && goals.home !== null) ? goals.home : null;
        const awayScore = (goals && goals.away !== null) ? goals.away : null;

        let result = null;
        if (status === 'finished' && homeScore !== null && awayScore !== null) {
          if (homeScore > awayScore)      result = 'home';
          else if (awayScore > homeScore) result = 'away';
          else                            result = 'draw';
        }

        await query(`
          INSERT INTO events (id, external_id, sport_id, home_team, away_team, league, commence_time, status, home_score, away_score, result)
          VALUES ($1,$2,'football',$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT (external_id) DO UPDATE SET
            status      = EXCLUDED.status,
            home_score  = EXCLUDED.home_score,
            away_score  = EXCLUDED.away_score,
            result      = EXCLUDED.result,
            updated_at  = NOW()
        `, [generateId(), extId, teams.home.name, teams.away.name, leagueInfo.name, new Date(fixture.date), status, homeScore, awayScore, result]);

        // Auto-settle bets for finished matches
        if (status === 'finished' && result) {
          const evRes = await query('SELECT id, home_team, away_team FROM events WHERE external_id=$1', [extId]);
          if (evRes.rows[0]) {
            const evId   = evRes.rows[0].id;
            const winner = result === 'home' ? evRes.rows[0].home_team
                         : result === 'away' ? evRes.rows[0].away_team
                         : 'Draw';
            await query(`
              UPDATE ticket_selections
              SET status = CASE WHEN selection=$1 THEN 'won' ELSE 'lost' END, settled_at=NOW()
              WHERE event_id=$2 AND status='pending'
            `, [winner, evId]);
          }
        }
        synced++;
      } catch (err) {
        logger.error('Error syncing fixture: ' + err.message);
      }
    }
    // Small delay between leagues
    await new Promise(r => setTimeout(r, 300));
  }

  logger.info('Fixtures sync complete. Synced: ' + synced);

  // Sync odds from The Odds API after fixtures
  try {
    const oddsCtrl = require('../controllers/oddsController');
    if (typeof oddsCtrl.syncOdds === 'function') {
      await oddsCtrl.syncOdds();
    }
  } catch (err) {
    logger.warn('Odds sync skipped: ' + err.message);
  }

  // Cleanup stale events after sync
  await cleanupStaleEvents();
}

// ── Schedule jobs ─────────────────────────────────────────────────────────────

// Full sync every 8 hours
cron.schedule('0 */8 * * *', () => {
  logger.info('Running scheduled fixtures sync...');
  syncFixtures().catch(err => logger.error('Scheduled sync failed: ' + err.message));
});

// Cleanup every hour
cron.schedule('0 * * * *', () => {
  logger.info('Running hourly event cleanup...');
  cleanupStaleEvents().catch(err => logger.error('Cleanup failed: ' + err.message));
});

// Initial sync on startup after 10 seconds
setTimeout(() => {
  syncFixtures().catch(err => logger.error('Initial sync failed: ' + err.message));
}, 10000);

logger.info('Odds poller started — fixtures every 8h, cleanup every 1h');

module.exports = { syncFixtures, cleanupStaleEvents };

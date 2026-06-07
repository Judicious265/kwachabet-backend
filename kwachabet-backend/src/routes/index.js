// ── Admin Sports Routes ───────────────────────────────────────────────────────
// Add these routes to your existing adminRouter in src/routes/index.js
// They go INSIDE the adminRouter section (after existing admin routes)

// GET /api/v1/admin/events - list all events with markets
adminRouter.get('/events', async (req, res) => {
  const { query } = require('../config/database');
  try {
    const { sport, status = 'upcoming', page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let sql = `
      SELECT e.*,
        json_agg(
          json_build_object(
            'id', m.id,
            'market_type', m.market_type,
            'outcome', m.outcome,
            'odds', m.odds,
            'is_active', m.is_active
          )
        ) FILTER (WHERE m.id IS NOT NULL) as markets
      FROM events e
      LEFT JOIN markets m ON m.event_id = e.id
      WHERE 1=1
    `;
    const args = [];

    if (status !== 'all') {
      args.push(status);
      sql += ` AND e.status = $${args.length}`;
    }
    if (sport && sport !== 'all') {
      args.push(sport);
      sql += ` AND e.sport_id = $${args.length}`;
    }

    sql += ` GROUP BY e.id ORDER BY e.commence_time ASC`;
    sql += ` LIMIT ${Math.min(parseInt(limit), 100)} OFFSET ${offset}`;

    const { rows } = await query(sql, args);

    const countRes = await query(
      'SELECT COUNT(*) FROM events WHERE 1=1' +
      (status !== 'all' ? ` AND status = '${status}'` : '') +
      (sport && sport !== 'all' ? ` AND sport_id = '${sport}'` : '')
    );

    res.json({ events: rows, total: parseInt(countRes.rows[0].count) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/admin/events - create a local match manually
adminRouter.post('/events', async (req, res) => {
  const { query, generateId } = require('../config/database');
  const { generateId: genId } = require('../utils/helpers');
  const { pool } = require('../config/database');
  try {
    const {
      home_team, away_team, league, sport_id = 'football',
      commence_time, odds_home, odds_draw, odds_away,
    } = req.body;

    if (!home_team || !away_team || !commence_time) {
      return res.status(400).json({ error: 'home_team, away_team and commence_time are required' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const eventId    = genId();
      const externalId = 'manual_' + eventId;

      await client.query(`
        INSERT INTO events (id, external_id, sport_id, home_team, away_team, league, commence_time, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'upcoming')
      `, [eventId, externalId, sport_id, home_team, away_team, league || 'Local', new Date(commence_time)]);

      // Insert odds if provided
      if (odds_home && parseFloat(odds_home) > 1) {
        await client.query(`
          INSERT INTO markets (id, event_id, market_type, outcome, odds, bookmaker, is_active, updated_at)
          VALUES ($1,$2,'h2h',$3,$4,'manual',true,NOW())
          ON CONFLICT (event_id, market_type, outcome) DO UPDATE SET odds = EXCLUDED.odds, updated_at = NOW()
        `, [genId(), eventId, home_team, parseFloat(odds_home)]);
      }
      if (odds_draw && parseFloat(odds_draw) > 1) {
        await client.query(`
          INSERT INTO markets (id, event_id, market_type, outcome, odds, bookmaker, is_active, updated_at)
          VALUES ($1,$2,'h2h','Draw',$3,'manual',true,NOW())
          ON CONFLICT (event_id, market_type, outcome) DO UPDATE SET odds = EXCLUDED.odds, updated_at = NOW()
        `, [genId(), eventId, parseFloat(odds_draw)]);
      }
      if (odds_away && parseFloat(odds_away) > 1) {
        await client.query(`
          INSERT INTO markets (id, event_id, market_type, outcome, odds, bookmaker, is_active, updated_at)
          VALUES ($1,$2,'h2h',$3,$4,'manual',true,NOW())
          ON CONFLICT (event_id, market_type, outcome) DO UPDATE SET odds = EXCLUDED.odds, updated_at = NOW()
        `, [genId(), eventId, away_team, parseFloat(odds_away)]);
      }

      await client.query('COMMIT');

      // Broadcast to frontend via WebSocket
      if (global.broadcastOdds) {
        const updated = await query(`
          SELECT e.*, json_agg(json_build_object('id',m.id,'market_type',m.market_type,'outcome',m.outcome,'odds',m.odds)) FILTER (WHERE m.id IS NOT NULL) as markets
          FROM events e LEFT JOIN markets m ON m.event_id = e.id AND m.is_active = true
          WHERE e.status IN ('upcoming','live') GROUP BY e.id ORDER BY e.commence_time ASC LIMIT 100
        `);
        global.broadcastOdds({ type: 'odds_update', events: updated.rows, timestamp: Date.now() });
      }

      res.status(201).json({ message: 'Match created successfully. Live on frontend now.', event_id: eventId });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/v1/admin/events/:id/odds - update odds for an event
adminRouter.patch('/events/:id/odds', async (req, res) => {
  const { query } = require('../config/database');
  const { generateId } = require('../utils/helpers');
  try {
    const { id } = req.params;
    const { odds_home, odds_draw, odds_away, market_id, new_odds } = req.body;

    // Single market update (from edit odds modal)
    if (market_id && new_odds) {
      await query(
        'UPDATE markets SET odds = $1, updated_at = NOW() WHERE id = $2',
        [parseFloat(new_odds), market_id]
      );
    }

    // Full H2H odds update
    if (odds_home || odds_draw || odds_away) {
      const { rows: evRows } = await query('SELECT * FROM events WHERE id = $1', [id]);
      const ev = evRows[0];
      if (!ev) return res.status(404).json({ error: 'Event not found' });

      if (odds_home) {
        await query(`
          INSERT INTO markets (id, event_id, market_type, outcome, odds, bookmaker, is_active, updated_at)
          VALUES ($1,$2,'h2h',$3,$4,'manual',true,NOW())
          ON CONFLICT (event_id, market_type, outcome) DO UPDATE SET odds = EXCLUDED.odds, updated_at = NOW()
        `, [generateId(), id, ev.home_team, parseFloat(odds_home)]);
      }
      if (odds_draw) {
        await query(`
          INSERT INTO markets (id, event_id, market_type, outcome, odds, bookmaker, is_active, updated_at)
          VALUES ($1,$2,'h2h','Draw',$3,'manual',true,NOW())
          ON CONFLICT (event_id, market_type, outcome) DO UPDATE SET odds = EXCLUDED.odds, updated_at = NOW()
        `, [generateId(), id, parseFloat(odds_draw)]);
      }
      if (odds_away) {
        await query(`
          INSERT INTO markets (id, event_id, market_type, outcome, odds, bookmaker, is_active, updated_at)
          VALUES ($1,$2,'h2h',$3,$4,'manual',true,NOW())
          ON CONFLICT (event_id, market_type, outcome) DO UPDATE SET odds = EXCLUDED.odds, updated_at = NOW()
        `, [generateId(), id, ev.away_team, parseFloat(odds_away)]);
      }
    }

    // Broadcast instantly to frontend
    if (global.broadcastOdds) {
      const { query: q } = require('../config/database');
      const updated = await q(`
        SELECT e.*, json_agg(json_build_object('id',m.id,'market_type',m.market_type,'outcome',m.outcome,'odds',m.odds)) FILTER (WHERE m.id IS NOT NULL) as markets
        FROM events e LEFT JOIN markets m ON m.event_id = e.id AND m.is_active = true
        WHERE e.status IN ('upcoming','live') GROUP BY e.id ORDER BY e.commence_time ASC LIMIT 100
      `);
      global.broadcastOdds({ type: 'odds_update', events: updated.rows, timestamp: Date.now() });
    }

    res.json({ message: 'Odds updated. Live on frontend instantly.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/v1/admin/events/:id/suspend - suspend/unsuspend market
adminRouter.patch('/events/:id/suspend', async (req, res) => {
  const { query } = require('../config/database');
  try {
    const { id } = req.params;
    const { suspend = true } = req.body;

    await query(
      'UPDATE markets SET is_active = $1, updated_at = NOW() WHERE event_id = $2',
      [!suspend, id]
    );

    if (global.broadcastOdds) {
      const updated = await query(`
        SELECT e.*, json_agg(json_build_object('id',m.id,'market_type',m.market_type,'outcome',m.outcome,'odds',m.odds)) FILTER (WHERE m.id IS NOT NULL) as markets
        FROM events e LEFT JOIN markets m ON m.event_id = e.id AND m.is_active = true
        WHERE e.status IN ('upcoming','live') GROUP BY e.id ORDER BY e.commence_time ASC LIMIT 100
      `);
      global.broadcastOdds({ type: 'odds_update', events: updated.rows, timestamp: Date.now() });
    }

    res.json({ message: suspend ? 'Market suspended. Hidden from frontend.' : 'Market reopened. Live on frontend.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/v1/admin/events/:id/result - set match result and settle bets
adminRouter.patch('/events/:id/result', async (req, res) => {
  const { query } = require('../config/database');
  try {
    const { id } = req.params;
    const { home_score, away_score, result } = req.body;

    // result = 'home' | 'draw' | 'away'
    if (!result || !['home', 'draw', 'away'].includes(result)) {
      return res.status(400).json({ error: 'result must be home, draw, or away' });
    }

    await query(`
      UPDATE events SET
        home_score = $1, away_score = $2, result = $3,
        status = 'finished', updated_at = NOW()
      WHERE id = $4
    `, [home_score, away_score, result, id]);

    // Get event to know teams
    const { rows: evRows } = await query('SELECT * FROM events WHERE id = $1', [id]);
    const ev = evRows[0];

    // Settle ticket_selections for this event
    const winningOutcome = result === 'home' ? ev.home_team : result === 'away' ? ev.away_team : 'Draw';

    await query(`
      UPDATE ticket_selections
      SET status = CASE WHEN selection = $1 THEN 'won' ELSE 'lost' END,
          settled_at = NOW()
      WHERE event_id = $2 AND status = 'pending'
    `, [winningOutcome, id]);

    res.json({
      message: 'Result saved. Bet settler will process payouts in the next cycle.',
      result: { home_score, away_score, winner: winningOutcome }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/v1/admin/events/:id - delete an event
adminRouter.delete('/events/:id', async (req, res) => {
  const { query } = require('../config/database');
  try {
    const { id } = req.params;

    // Check no bets are placed on this event
    const bets = await query(
      'SELECT COUNT(*) FROM ticket_selections WHERE event_id = $1 AND status = $2',
      [id, 'pending']
    );
    if (parseInt(bets.rows[0].count) > 0) {
      return res.status(400).json({
        error: 'Cannot delete — there are pending bets on this event. Suspend it instead.'
      });
    }

    await query('DELETE FROM markets WHERE event_id = $1', [id]);
    await query('DELETE FROM events WHERE id = $1', [id]);

    res.json({ message: 'Event deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

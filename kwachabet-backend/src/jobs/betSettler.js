// ── Bet Settler - runs every 5 minutes ───────────────────────────────────────
const cron         = require('node-cron');
const { query }    = require('../config/database');
const bettingCtrl  = require('../controllers/bettingController');
const logger       = require('../utils/logger');

async function settleFinishedEvents() {
  try {
    // Find events that started 2+ hours ago and are still "upcoming"
    const { rows: staleEvents } = await query(`
      SELECT id FROM events
      WHERE status = 'upcoming'
      AND commence_time < NOW() - INTERVAL '2 hours'
      LIMIT 20
    `);

    for (const ev of staleEvents) {
      await query("UPDATE events SET status='finished', updated_at=NOW() WHERE id=$1", [ev.id]);
    }

    // Find pending tickets for finished events and try to settle them
    const { rows: pendingTickets } = await query(`
      SELECT DISTINCT ts.ticket_id
      FROM ticket_selections ts
      JOIN events e ON ts.event_id = e.id
      JOIN tickets t ON ts.ticket_id = t.id
      WHERE e.status = 'finished'
      AND ts.status = 'pending'
      AND t.status = 'pending'
      LIMIT 50
    `);

    let settled = 0;
    for (const row of pendingTickets) {
      try {
        // Mark selections as won/lost based on event result (if available)
        const { rows: sels } = await query(
          `SELECT ts.*, e.result, e.home_team, e.away_team
           FROM ticket_selections ts JOIN events e ON ts.event_id = e.id
           WHERE ts.ticket_id = $1`,
          [row.ticket_id]
        );

        for (const sel of sels) {
          if (sel.status !== 'pending') continue;
          if (!sel.result) {
            // No result yet — mark as void so ticket can be refunded
            await query("UPDATE ticket_selections SET status='void' WHERE id=$1", [sel.id]);
          } else {
            const won = (
              (sel.selection === sel.home_team && sel.result === 'home') ||
              (sel.selection === sel.away_team && sel.result === 'away') ||
              (sel.selection === 'Draw'        && sel.result === 'draw')
            );
            await query("UPDATE ticket_selections SET status=$1, settled_at=NOW() WHERE id=$2",
              [won ? 'won' : 'lost', sel.id]);
          }
        }

        await bettingCtrl.settleBet(row.ticket_id);
        settled++;
      } catch (err) {
        logger.error(`Failed to settle ticket ${row.ticket_id}:`, err.message);
      }
    }

    if (settled > 0) logger.info(`Bet settler: settled ${settled} tickets`);
  } catch (err) {
    logger.error('Bet settler error:', err.message);
  }
}

cron.schedule('*/5 * * * *', settleFinishedEvents);

logger.info('✅ Bet settler started');
module.exports = { settleFinishedEvents };

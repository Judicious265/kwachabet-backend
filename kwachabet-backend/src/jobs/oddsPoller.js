// ── Odds Poller - runs every 2 minutes ───────────────────────────────────────
const cron      = require('node-cron');
const oddsCtrl  = require('../controllers/oddsController');
const logger    = require('../utils/logger');

// Ensure unique index exists on first run
oddsCtrl.ensureMarketUniqueIndex().catch(() => {});

// Poll every 2 minutes
cron.schedule('*/2 * * * *', async () => {
  try {
    logger.debug('Polling odds from The Odds API...');
    await oddsCtrl.syncOdds();
  } catch (err) {
    logger.error('Odds poller error:', err.message);
  }
});

// Initial sync on startup (after 10 seconds)
setTimeout(async () => {
  try {
    await oddsCtrl.syncOdds();
    logger.info('Initial odds sync complete');
  } catch (err) {
    logger.warn('Initial odds sync failed:', err.message);
  }
}, 10000);

logger.info('✅ Odds poller started');
module.exports = {};

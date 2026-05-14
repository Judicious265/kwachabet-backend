/**
 * Kwacha Bet - Main Server
 * PostgreSQL + Express + WebSocket
 */

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');
const http       = require('http');
const WebSocket  = require('ws');

const { testConnection } = require('./config/database');
const logger             = require('./utils/logger');

// ── Routes ────────────────────────────────────────────────────────────────────
const authRoutes     = require('./routes/auth');
const userRoutes     = require('./routes/users');
const walletRoutes   = require('./routes/wallet');
const bettingRoutes  = require('./routes/betting');
const oddsRoutes     = require('./routes/odds');
const paymentRoutes  = require('./routes/payments');
const adminRoutes    = require('./routes/admin');
const bonusRoutes    = require('./routes/bonus');
const webhookRoutes  = require('./routes/webhooks');

const app    = express();
const server = http.createServer(app);

// ── Security ──────────────────────────────────────────────────────────────────
app.use(helmet());
app.set('trust proxy', 1);

app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:3000',
    process.env.ADMIN_URL    || 'http://localhost:3001',
  ],
  credentials: true,
}));

// ── Rate limiting ─────────────────────────────────────────────────────────────
const globalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });
const authLimiter   = rateLimit({ windowMs: 15 * 60 * 1000, max: 15, message: { error: 'Too many attempts. Try again in 15 minutes.' } });

app.use(globalLimiter);
app.use(morgan('combined', { stream: { write: m => logger.info(m.trim()) } }));

// Raw body for webhooks BEFORE json parser
app.use('/webhooks', express.raw({ type: '*/*' }));

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ service: 'Kwacha Bet API', status: 'running', version: '1.0.0' }));

app.get('/health', async (req, res) => {
  const dbOk = await testConnection();
  res.status(dbOk ? 200 : 503).json({
    status:    dbOk ? 'healthy' : 'degraded',
    database:  dbOk,
    timestamp: new Date().toISOString(),
  });
});

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/v1/auth',     authLimiter, authRoutes);
app.use('/api/v1/users',    userRoutes);
app.use('/api/v1/wallet',   walletRoutes);
app.use('/api/v1/betting',  bettingRoutes);
app.use('/api/v1/odds',     oddsRoutes);
app.use('/api/v1/payments', paymentRoutes);
app.use('/api/v1/admin',    adminRoutes);
app.use('/api/v1/bonus',    bonusRoutes);
app.use('/webhooks',        webhookRoutes);

// ── 404 & Error handlers ──────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error(`${err.status || 500} - ${err.message} - ${req.originalUrl}`);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
});

// ── WebSocket for live odds ───────────────────────────────────────────────────
const wss = new WebSocket.Server({ server, path: '/ws/odds' });
const wsClients = new Set();

wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
});

// Expose broadcast function globally
global.broadcastOdds = (data) => {
  const payload = JSON.stringify(data);
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(payload); } catch {}
    }
  }
};

// ── Start ─────────────────────────────────────────────────────────────────────
async function start() {
  try {
    const dbOk = await testConnection();
    if (!dbOk) {
      logger.error('Cannot connect to PostgreSQL. Check DB_* environment variables.');
      process.exit(1);
    }
    logger.info('✅ PostgreSQL connected');

    // Start background jobs (safe — skip if Redis not available)
    try { require('./jobs/oddsPoller'); }    catch (e) { logger.warn('Odds poller skipped:', e.message); }
    try { require('./jobs/betSettler'); }    catch (e) { logger.warn('Bet settler skipped:', e.message); }

    const PORT = process.env.PORT || 5000;
    server.listen(PORT, () => {
      logger.info(`🚀 Kwacha Bet API running on port ${PORT}`);
      logger.info(`   ENV: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (err) {
    logger.error('Startup failed:', err.message);
    process.exit(1);
  }
}

start();

module.exports = app;

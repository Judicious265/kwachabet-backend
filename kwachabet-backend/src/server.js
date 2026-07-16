/**
 * Kwacha Bet - Main Server
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

const authRoutes     = require('./routes/auth');
const userRoutes     = require('./routes/users');
const walletRoutes   = require('./routes/wallet');
const bettingRoutes  = require('./routes/betting');
const oddsRoutes     = require('./routes/odds');
const paymentsRoutes = require('./routes/payments');
const bonusRoutes    = require('./routes/bonus');
const webhookRoutes  = require('./routes/webhooks');

const app    = express();
const server = http.createServer(app);

app.use(helmet());
app.set('trust proxy', 1);

// ── CORS — allow all Vercel deployments + localhost ───────────────────────────
const allowedOrigins = [
  'https://kwachabet-admin.vercel.app',
  'https://kwachabet-frontend.vercel.app',
  'http://localhost:3000',
  'http://localhost:3001',
];

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl, Render health checks)
    if (!origin) return callback(null, true);
    // Allow any vercel.app subdomain for preview deployments
    if (origin.endsWith('.vercel.app')) return callback(null, true);
    // Allow specific origins
    if (allowedOrigins.includes(origin)) return callback(null, true);
    // Allow localhost for dev
    if (origin.startsWith('http://localhost')) return callback(null, true);
    callback(null, true); // Remove this line after confirming all origins
  },
  credentials: true,
  methods:     ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
allowedHeaders: ['Content-Type','Authorization','X-Requested-With','X-Device-Fingerprint'],
}));

const globalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });
const authLimiter   = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { error: 'Too many attempts. Try again in 15 minutes.' },
});

app.use(globalLimiter);
app.use(morgan('combined', { stream: { write: m => logger.info(m.trim()) } }));
app.use('/webhooks', express.raw({ type: '*/*' }));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  service:   'Kwacha Bet API',
  status:    'running',
  version:   '1.0.0',
  timestamp: new Date().toISOString(),
}));

app.get('/health', async (req, res) => {
  const dbOk = await testConnection();
  res.status(dbOk ? 200 : 503).json({
    status:    dbOk ? 'healthy' : 'degraded',
    database:  dbOk,
    timestamp: new Date().toISOString(),
    env: {
      node_env:   process.env.NODE_ENV,
      has_db_url: !!process.env.DATABASE_URL,
      has_jwt:    !!process.env.JWT_SECRET,
    },
  });
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/v1/auth',     authLimiter, authRoutes);
app.use('/api/v1/users',    userRoutes);
app.use('/api/v1/wallet',   walletRoutes);
app.use('/api/v1/betting',  bettingRoutes);
app.use('/api/v1/odds',     oddsRoutes);
app.use('/api/v1/payments', paymentsRoutes);
app.use('/api/v1/bonus',    bonusRoutes);
app.use('/webhooks',        webhookRoutes);

// ── RBAC Admin Routes ─────────────────────────────────────────────────────────
const { adminAuthRouter, adminMgmtRouter, adminApiRouter } = require('./routes/adminRoutes');
app.use('/api/v1/admin-auth', adminAuthRouter);
app.use('/api/v1/admin-team', adminMgmtRouter);
app.use('/api/v1/admin',      adminApiRouter);

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// ── Error handler ─────────────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error('Error: ' + err.message);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
const wss       = new WebSocket.Server({ server, path: '/ws/odds' });
const wsClients = new Set();

wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
});

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
  logger.info('Starting Kwacha Bet API...');
  logger.info('NODE_ENV: ' + process.env.NODE_ENV);
  logger.info('DATABASE_URL set: ' + !!process.env.DATABASE_URL);
  logger.info('JWT_SECRET set: '   + !!process.env.JWT_SECRET);

  const dbOk = await testConnection();
  if (!dbOk) {
    logger.error('Database connection failed. Exiting.');
    process.exit(1);
  }

  try { require('./jobs/oddsPoller'); }
  catch (e) { logger.warn('Odds poller skipped: ' + e.message); }

  try { require('./jobs/betSettler'); }
  catch (e) { logger.warn('Bet settler skipped: ' + e.message); }

  const PORT = process.env.PORT || 5000;
  server.listen(PORT, '0.0.0.0', () => {
    logger.info('🚀 Kwacha Bet API running on port ' + PORT);
  });
}

start();
module.exports = app;

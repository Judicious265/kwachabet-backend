/**
 * PostgreSQL Database Configuration
 * Uses the pg library directly — NO SQLite, NO better-sqlite3
 */

const { Pool } = require('pg');
const logger   = require('../utils/logger');

// Render provides DATABASE_URL automatically when you attach a PostgreSQL database
// We support both DATABASE_URL and individual variables
const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production'
          ? { rejectUnauthorized: false }
          : false,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
      }
    : {
        host:     process.env.DB_HOST     || 'localhost',
        port:     parseInt(process.env.DB_PORT) || 5432,
        database: process.env.DB_NAME     || 'kwachabet',
        user:     process.env.DB_USER     || 'kwachabet_user',
        password: process.env.DB_PASSWORD || '',
        ssl: process.env.DB_SSL === 'true'
          ? { rejectUnauthorized: false }
          : false,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
      }
);

pool.on('error', (err) => {
  logger.error('PostgreSQL pool error:', err.message);
});

// ── Test connection ───────────────────────────────────────────────────────────
async function testConnection() {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    return true;
  } catch (err) {
    logger.error('PostgreSQL connection failed:', err.message);
    return false;
  }
}

// ── Simple query helper ───────────────────────────────────────────────────────
async function query(text, params = []) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    if (duration > 1000) {
      logger.warn(`Slow query (${duration}ms): ${text.substring(0, 100)}`);
    }
    return result;
  } catch (err) {
    logger.error('Query error:', err.message, '\nSQL:', text.substring(0, 200));
    throw err;
  }
}

// ── Transaction helper ────────────────────────────────────────────────────────
async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction, testConnection };

/**
 * PostgreSQL Database Configuration - Fixed for Render.com
 */

const { Pool } = require('pg');
const logger = require('../utils/logger');

// Render provides DATABASE_URL automatically
// We force SSL off for internal connections on Render
const getConfig = () => {
  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
      ssl: {
        rejectUnauthorized: false,
      },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    };
  }

  return {
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME     || 'kwachabet',
    user:     process.env.DB_USER     || 'kwachabet_user',
    password: process.env.DB_PASSWORD || '',
    ssl: process.env.DB_SSL === 'true'
      ? { rejectUnauthorized: false }
      : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  };
};

const pool = new Pool(getConfig());

pool.on('error', (err) => {
  logger.error('PostgreSQL pool error:', err.message);
});

pool.on('connect', () => {
  logger.info('New PostgreSQL client connected');
});

async function testConnection() {
  let client;
  try {
    client = await pool.connect();
    const result = await client.query('SELECT current_database() as db, NOW() as time');
    logger.info(`PostgreSQL connected to: ${result.rows[0].db}`);
    return true;
  } catch (err) {
    logger.error('PostgreSQL connection failed:', err.message);
    logger.error('Connection config:', {
      hasUrl: !!process.env.DATABASE_URL,
      host: process.env.DB_HOST || 'not set',
      database: process.env.DB_NAME || 'not set',
    });
    return false;
  } finally {
    if (client) client.release();
  }
}

async function query(text, params = []) {
  try {
    const result = await pool.query(text, params);
    return result;
  } catch (err) {
    logger.error('Query error:', err.message);
    throw err;
  }
}

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

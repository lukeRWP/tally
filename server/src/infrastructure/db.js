const mysql = require('mysql2/promise');

const QUERY_TIMEOUT_MS = 30_000;
const LONG_QUERY_TIMEOUT_MS = 5 * 60 * 1000;
const CONNECTION_CHECK_TIMEOUT_MS = 5_000;
const POOL_SIZE = 20;
const QUEUE_LIMIT = 100;

const TRANSIENT_ERRORS = new Set([
  'PROTOCOL_CONNECTION_LOST',
  'ECONNRESET',
  'ER_LOCK_DEADLOCK',
]);

function buildPoolConfig() {
  const sslEnabled = process.env.MYSQL_USE_SSL === 'true';

  const cfg = {
    host: process.env.MYSQL_URL,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.TALLY_DB,
    waitForConnections: true,
    connectionLimit: POOL_SIZE,
    queueLimit: QUEUE_LIMIT,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
    timezone: '+00:00',
    dateStrings: false,
  };

  if (sslEnabled) {
    const fs = require('fs');
    const path = require('path');
    const sslPath = process.env.MYSQL_SSL_PATH || '';
    const sslOpts = {};

    if (sslPath && fs.existsSync(path.join(sslPath, 'ca.pem'))) {
      sslOpts.ca = fs.readFileSync(path.join(sslPath, 'ca.pem'));
      sslOpts.rejectUnauthorized = true;
    } else {
      sslOpts.rejectUnauthorized = false;
      console.warn('[db] WARNING: SSL enabled without CA cert — certificate verification disabled');
      if (fs.existsSync(path.join(sslPath, 'client-cert.pem'))) {
        sslOpts.cert = fs.readFileSync(path.join(sslPath, 'client-cert.pem'));
        sslOpts.key = fs.readFileSync(path.join(sslPath, 'client-key.pem'));
      }
    }

    cfg.ssl = sslOpts;
  }

  return cfg;
}

const pool = mysql.createPool(buildPoolConfig());

function isTransientError(err) {
  return (
    TRANSIENT_ERRORS.has(err.code) ||
    TRANSIENT_ERRORS.has(err.errno)
  );
}

async function executeQuery(sql, params, timeoutMs) {
  const conn = await pool.getConnection();
  try {
    if (timeoutMs) {
      await conn.query(`SET SESSION MAX_EXECUTION_TIME=${timeoutMs}`);
    }
    const [rows] = await conn.query(sql, params);
    return rows;
  } finally {
    conn.release();
  }
}

async function query(sql, params) {
  try {
    return await executeQuery(sql, params, QUERY_TIMEOUT_MS);
  } catch (err) {
    if (isTransientError(err)) {
      // Single automatic retry for transient errors
      return executeQuery(sql, params, QUERY_TIMEOUT_MS);
    }
    throw err;
  }
}

async function queryLong(sql, params) {
  try {
    return await executeQuery(sql, params, LONG_QUERY_TIMEOUT_MS);
  } catch (err) {
    if (isTransientError(err)) {
      return executeQuery(sql, params, LONG_QUERY_TIMEOUT_MS);
    }
    throw err;
  }
}

async function getConnection() {
  return pool.getConnection();
}

async function checkConnection() {
  const conn = await pool.getConnection();
  try {
    // Set a tight timeout for the health check query
    await conn.query({ sql: 'SELECT 1', timeout: CONNECTION_CHECK_TIMEOUT_MS });
    return true;
  } finally {
    conn.release();
  }
}

function getPoolStats() {
  // mysql2 pool exposes these internal counters
  return {
    total: pool.pool._allConnections ? pool.pool._allConnections.length : undefined,
    free: pool.pool._freeConnections ? pool.pool._freeConnections.length : undefined,
    queued: pool.pool._connectionQueue ? pool.pool._connectionQueue.length : undefined,
  };
}

module.exports = { query, queryLong, getConnection, checkConnection, getPoolStats, pool };

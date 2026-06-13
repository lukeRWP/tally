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
      // Optional mutual TLS, only once the CA is trusted.
      if (fs.existsSync(path.join(sslPath, 'client-cert.pem'))) {
        sslOpts.cert = fs.readFileSync(path.join(sslPath, 'client-cert.pem'));
        sslOpts.key = fs.readFileSync(path.join(sslPath, 'client-key.pem'));
      }
    } else {
      // Fail closed: never connect with certificate verification disabled.
      throw new Error(
        `[db] MYSQL_USE_SSL=true but no CA cert found at ${sslPath || '(MYSQL_SSL_PATH unset)'}/ca.pem — ` +
          'refusing to connect with TLS verification disabled. Provide the CA or unset MYSQL_USE_SSL.'
      );
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

/**
 * Run `fn` inside a single database transaction.
 *
 * `fn` receives a `tx` executor that exposes the same `query()/queryLong()`
 * interface as this module but is bound to one connection with an open
 * transaction. Pass `tx` to any service/closure method that should take part
 * in the transaction. The transaction commits if `fn` resolves and rolls back
 * if it throws; the connection is always released.
 *
 * Note: transient-error auto-retry is intentionally NOT applied inside a
 * transaction — re-running a single statement against an aborted transaction
 * would be incorrect. Side effects that aren't transactional (e.g. MinIO
 * object removal) should be performed by the caller AFTER this resolves.
 *
 * @param {(tx: {query: Function, queryLong: Function}) => Promise<any>} fn
 * @returns {Promise<any>} whatever `fn` returns
 */
async function withTransaction(fn) {
  const conn = await pool.getConnection();
  const run = async (sql, params) => {
    const [rows] = await conn.query(sql, params);
    return rows;
  };
  const tx = { query: run, queryLong: run };
  try {
    await conn.query(`SET SESSION MAX_EXECUTION_TIME=${QUERY_TIMEOUT_MS}`);
    await conn.beginTransaction();
    const result = await fn(tx);
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch {
      /* ignore rollback failure — surface the original error */
    }
    throw err;
  } finally {
    conn.release();
  }
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

module.exports = { query, queryLong, withTransaction, getConnection, checkConnection, getPoolStats, pool };

const mysql = require('mysql2/promise');
const logger = require('../utils/logger');

const QUERY_TIMEOUT_MS = 30_000;
const LONG_QUERY_TIMEOUT_MS = 5 * 60 * 1000;
const CONNECTION_CHECK_TIMEOUT_MS = 5_000;
const POOL_SIZE = 20;
const QUEUE_LIMIT = 100;

// Transient errors where the statement may or may not have executed on the
// server (connection torn down mid-flight). Retrying these is only safe for
// reads — a retried INSERT/UPDATE can apply twice (#97).
const TRANSIENT_ERRORS = new Set([
  'PROTOCOL_CONNECTION_LOST',
  'ECONNRESET',
  'ETIMEDOUT',
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

// Session defaults, once per PHYSICAL connection instead of once per query
// (#98). The core pool emits 'connection' exactly once, when a new physical
// connection is established, synchronously before handing it to the waiting
// caller — and the connection's command queue serialises, so this SET always
// runs before the caller's first statement. The handler receives the core
// (callback-style) connection.
//
// The default is the SHORT timeout. Anything that needs longer must raise it
// for its own statement and put the short value back before the connection
// returns to the pool (see executeQueryLong).
pool.on('connection', (connection) => {
  connection.query(`SET SESSION MAX_EXECUTION_TIME=${QUERY_TIMEOUT_MS}`, (err) => {
    if (err) {
      // The pool tears down connections that fail; nothing to do but record it.
      logger.warn(`[db] failed to set session timeout on new connection: ${err.code || err.message}`);
    }
  });
});

function isDeadlockError(err) {
  // MySQL guarantees the deadlocked statement's transaction was rolled back,
  // so a single retry is always safe — even for writes (#97).
  return err.code === 'ER_LOCK_DEADLOCK' || err.errno === 1213;
}

function isTransientError(err) {
  return (
    TRANSIENT_ERRORS.has(err.code) ||
    TRANSIENT_ERRORS.has(err.errno)
  );
}

// Leading whitespace and SQL comments (/* */, -- , #) before the first keyword.
const LEADING_SQL_NOISE = /^(?:\s+|\/\*[\s\S]*?\*\/|--[^\n]*(?:\n|$)|#[^\n]*(?:\n|$))+/;

/**
 * Mechanical read classification: the statement begins with SELECT after
 * trimming whitespace/comments. Deliberately no per-call idempotency flags —
 * anything not provably a read is treated as a write and never retried on a
 * transient error.
 */
function isReadStatement(sql) {
  const text = typeof sql === 'string' ? sql : (sql && sql.sql) || '';
  return /^select\b/i.test(text.replace(LEADING_SQL_NOISE, ''));
}

function shouldRetry(err, sql) {
  if (isDeadlockError(err)) return true;
  return isTransientError(err) && isReadStatement(sql);
}

async function executeQuery(sql, params) {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(sql, params);
    return rows;
  } finally {
    conn.release();
  }
}

/**
 * Long-timeout variant. Raises MAX_EXECUTION_TIME for this statement only and
 * restores the pool-wide short default before releasing. If the restore cannot
 * be confirmed (connection died, SET failed) the connection is DESTROYED, not
 * released — a pooled connection must never carry the long timeout into an
 * unrelated caller's query.
 *
 * (Chosen over the per-statement optimizer hint form because the hint must be
 * spliced immediately after the top-level SELECT keyword of arbitrary SQL —
 * fragile — while SET+restore-or-destroy is statement-shape-agnostic and
 * structurally cannot leak.)
 */
async function executeQueryLong(sql, params) {
  const conn = await pool.getConnection();
  try {
    await conn.query(`SET SESSION MAX_EXECUTION_TIME=${LONG_QUERY_TIMEOUT_MS}`);
    const [rows] = await conn.query(sql, params);
    return rows;
  } finally {
    try {
      await conn.query(`SET SESSION MAX_EXECUTION_TIME=${QUERY_TIMEOUT_MS}`);
      conn.release();
    } catch {
      conn.destroy();
    }
  }
}

/**
 * Single automatic retry (#97), narrowed:
 *  - deadlock (ER_LOCK_DEADLOCK): always — MySQL rolled the statement back;
 *  - other transient errors (connection lost/reset, ETIMEDOUT): reads only.
 * A write hitting a transient error surfaces to the caller, whose error
 * handling decides — the statement may already have applied.
 *
 * Applies ONLY to these pool-level helpers. `withTransaction` never retries.
 */
async function runWithRetry(exec, sql, params) {
  try {
    return await exec(sql, params);
  } catch (err) {
    if (!shouldRetry(err, sql)) throw err;
    const text = typeof sql === 'string' ? sql : (sql && sql.sql) || '';
    logger.warn(
      `[db] ${isDeadlockError(err) ? 'deadlock' : 'transient error'} (${err.code || err.errno}) — retrying once: ${text.slice(0, 80)}`
    );
    return exec(sql, params);
  }
}

async function query(sql, params) {
  return runWithRetry(executeQuery, sql, params);
}

async function queryLong(sql, params) {
  return runWithRetry(executeQueryLong, sql, params);
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
 * Note: automatic retry is intentionally NOT applied inside a transaction —
 * not even the deadlock retry, because ER_LOCK_DEADLOCK rolls back the WHOLE
 * transaction, so re-running one statement of it would be incorrect. The
 * error surfaces and the caller decides whether to re-run `fn` entirely.
 * Side effects that aren't transactional (e.g. MinIO object removal) should
 * be performed by the caller AFTER this resolves.
 *
 * The session timeout is the pool-wide per-connection default (#98) — no
 * per-transaction SET round trip.
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

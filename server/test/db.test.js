const test = require('node:test');
const assert = require('node:assert');

// db.js creates its pool at require time, so mysql2/promise (and the logger,
// to capture retry warns) are stubbed via require.cache BEFORE db.js loads —
// same spirit as the fakeDb pattern elsewhere, applied one layer down.

const state = {
  connectionHandlers: [], // pool.on('connection', ...) registrations
  script: null,           // (sqlText, params) => rows (or throws)
  calls: [],              // every conn.query issued: { sql, params }
  released: 0,
  destroyed: 0,
};

function makeConn() {
  return {
    async query(sql, params) {
      const text = typeof sql === 'string' ? sql : sql.sql;
      state.calls.push({ sql: text, params });
      return [await state.script(text, params), []];
    },
    async beginTransaction() { state.calls.push({ sql: 'BEGIN' }); },
    async commit() { state.calls.push({ sql: 'COMMIT' }); },
    async rollback() { state.calls.push({ sql: 'ROLLBACK' }); },
    release() { state.released += 1; },
    destroy() { state.destroyed += 1; },
  };
}

const fakePool = {
  on(event, handler) {
    if (event === 'connection') state.connectionHandlers.push(handler);
  },
  async getConnection() { return makeConn(); },
  pool: {},
};

const warns = [];

function stub(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

stub('mysql2/promise', { createPool: () => fakePool });
stub('../src/utils/logger', {
  warn: (msg) => warns.push(msg),
  info() {},
  error() {},
  debug() {},
});

const db = require('../src/infrastructure/db');

function reset(script) {
  state.script = script;
  state.calls = [];
  state.released = 0;
  state.destroyed = 0;
  warns.length = 0;
}

function mysqlError(code, errno) {
  const err = new Error(code);
  err.code = code;
  if (errno) err.errno = errno;
  return err;
}

// Statements the module issues itself, as opposed to caller SQL.
const isSessionSet = (c) => /^SET SESSION MAX_EXECUTION_TIME=/.test(c.sql);
const callerCalls = () => state.calls.filter((c) => !isSessionSet(c) &&
  !['BEGIN', 'COMMIT', 'ROLLBACK'].includes(c.sql));

// ── #97: deadlock retry is unconditional (writes included) ──────────────────

test('deadlock on INSERT is retried once and succeeds', async () => {
  let attempts = 0;
  reset((sql) => {
    if (/^INSERT/.test(sql)) {
      attempts += 1;
      if (attempts === 1) throw mysqlError('ER_LOCK_DEADLOCK', 1213);
      return { insertId: 7 };
    }
    return [];
  });
  const res = await db.query('INSERT INTO items (NAME) VALUES (?)', ['drill']);
  assert.equal(res.insertId, 7);
  assert.equal(attempts, 2, 'the INSERT ran exactly twice');
  assert.equal(warns.length, 1, 'the retry was logged');
  assert.match(warns[0], /deadlock/i);
});

// ── #97: transient errors retry ONLY reads ──────────────────────────────────

test('ETIMEDOUT on INSERT is NOT retried — the error surfaces', async () => {
  let attempts = 0;
  reset((sql) => {
    if (/^INSERT/.test(sql)) { attempts += 1; throw mysqlError('ETIMEDOUT'); }
    return [];
  });
  await assert.rejects(
    db.query('INSERT INTO items (NAME) VALUES (?)', ['drill']),
    (err) => err.code === 'ETIMEDOUT'
  );
  assert.equal(attempts, 1, 'a write never gets a transient-error retry');
  assert.equal(warns.length, 0, 'no retry, so nothing logged');
});

test('ETIMEDOUT on SELECT is retried once (comment/whitespace prefix included)', async () => {
  let attempts = 0;
  reset((sql) => {
    if (/SELECT \* FROM items/.test(sql)) {
      attempts += 1;
      if (attempts === 1) throw mysqlError('ETIMEDOUT');
      return [{ ID: 1 }];
    }
    return [];
  });
  const rows = await db.query('  /* recent */ -- items\n SELECT * FROM items WHERE ID = ?', [1]);
  assert.deepEqual(rows, [{ ID: 1 }]);
  assert.equal(attempts, 2, 'the SELECT ran exactly twice');
  assert.equal(warns.length, 1, 'the retry was logged');
});

test('a second transient failure surfaces — never more than one retry', async () => {
  let attempts = 0;
  reset((sql) => {
    if (/^SELECT/.test(sql)) { attempts += 1; throw mysqlError('ECONNRESET'); }
    return [];
  });
  await assert.rejects(
    db.query('SELECT * FROM items'),
    (err) => err.code === 'ECONNRESET'
  );
  assert.equal(attempts, 2, 'one retry, then the error surfaces');
});

test('non-transient errors are never retried, even on SELECT', async () => {
  let attempts = 0;
  reset(() => { attempts += 1; throw mysqlError('ER_NO_SUCH_TABLE', 1146); });
  await assert.rejects(db.query('SELECT * FROM nope'));
  assert.equal(attempts, 1);
});

// ── #97: no retry inside withTransaction ────────────────────────────────────

test('withTransaction does not retry — a deadlock rolls back and surfaces', async () => {
  let attempts = 0;
  reset((sql) => {
    if (/^INSERT/.test(sql)) { attempts += 1; throw mysqlError('ER_LOCK_DEADLOCK', 1213); }
    return [];
  });
  await assert.rejects(
    db.withTransaction((tx) => tx.query('INSERT INTO items (NAME) VALUES (?)', ['x'])),
    (err) => err.code === 'ER_LOCK_DEADLOCK'
  );
  assert.equal(attempts, 1, 'the statement ran once — the whole tx is the retry unit');
  assert.ok(state.calls.some((c) => c.sql === 'ROLLBACK'), 'the transaction rolled back');
  assert.equal(warns.length, 0, 'no pool-level retry logging inside a transaction');
});

// ── #98: session timeout is a per-connection default, not per-query ─────────

test("pool 'connection' handler sets the SHORT timeout, registered once", () => {
  assert.equal(state.connectionHandlers.length, 1, 'exactly one connection handler');
  const seen = [];
  // The event delivers the CORE (callback-style) connection.
  state.connectionHandlers[0]({ query: (sql, cb) => { seen.push(sql); if (cb) cb(null); } });
  assert.deepEqual(seen, ['SET SESSION MAX_EXECUTION_TIME=30000'],
    'one SET, and it is the short default — never the long timeout');
});

test('query() issues no per-query SET round trip', async () => {
  reset(() => [{ ID: 1 }]);
  await db.query('SELECT * FROM items');
  assert.equal(state.calls.filter(isSessionSet).length, 0, 'no SET SESSION alongside the query');
  assert.equal(state.calls.length, 1, 'exactly one round trip');
});

test('queryLong raises the timeout for its statement and RESTORES the short default before release', async () => {
  reset((sql) => (/^SELECT/.test(sql) ? [{ N: 1 }] : []));
  const rows = await db.queryLong('SELECT SLEEP(60)');
  assert.deepEqual(rows, [{ N: 1 }]);
  assert.deepEqual(state.calls.map((c) => c.sql), [
    'SET SESSION MAX_EXECUTION_TIME=300000',
    'SELECT SLEEP(60)',
    'SET SESSION MAX_EXECUTION_TIME=30000',
  ], 'long SET, statement, short SET — in that order, on the same connection');
  assert.equal(state.released, 1, 'released back to the pool only after the restore');
  assert.equal(state.destroyed, 0);
});

test('queryLong DESTROYS the connection if the restore cannot be confirmed — the long timeout cannot leak into the pool', async () => {
  reset((sql) => {
    if (sql === 'SET SESSION MAX_EXECUTION_TIME=30000') throw mysqlError('PROTOCOL_CONNECTION_LOST');
    if (/^SELECT/.test(sql)) return [{ N: 1 }];
    return [];
  });
  const rows = await db.queryLong('SELECT SLEEP(60)');
  assert.deepEqual(rows, [{ N: 1 }], 'the result still reaches the caller');
  assert.equal(state.destroyed, 1, 'connection destroyed, not released');
  assert.equal(state.released, 0, 'a connection with an unconfirmed timeout never re-enters the pool');
});

test('queryLong failures restore the short default too', async () => {
  reset((sql) => {
    if (/^SELECT/.test(sql)) throw mysqlError('ER_NO_SUCH_TABLE', 1146);
    return [];
  });
  await assert.rejects(db.queryLong('SELECT * FROM nope'));
  const sets = state.calls.filter(isSessionSet).map((c) => c.sql);
  assert.equal(sets[sets.length - 1], 'SET SESSION MAX_EXECUTION_TIME=30000',
    'the last thing on the connection is the restore');
  assert.equal(state.released, 1);
  assert.equal(callerCalls().length, 1, 'the query itself ran once (not a read retry — it was a syntax-class error)');
});

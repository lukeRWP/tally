const test = require('node:test');
const assert = require('node:assert');
const Items = require('../src/modules/inventory/items.service');
const Audit = require('../src/modules/audit/audit.service');

const noop = { warn() {}, info() {}, error() {} };
// softDelete now runs its check+delete in a transaction under a row lock, so
// the mock db must expose withTransaction (like lending.test.js's fakeDb).
function txDb(handler) {
  const db = { query: async (sql, params) => handler(sql, params), withTransaction: async (fn) => fn({ query: db.query }) };
  return db;
}

// softDelete must refuse an item that is currently lent out, or the open loan
// record is orphaned and later destroyed by the 30-day purge.
test('softDelete refuses an item with an open loan (409)', async () => {
  Audit.init({ db: { query: async () => [] }, logger: noop });
  Items.init({
    db: txDb((sql) => {
      if (/SELECT a\.PROPERTY_ID|PROPERTY_ID FROM/i.test(sql)) return [{ PROPERTY_ID: 1 }];
      if (/FROM TALLY\.items WHERE ID = \? FOR UPDATE/i.test(sql)) return [{ ID: 5 }];
      if (/FROM TALLY\.item_lending WHERE ITEM_ID = \? AND RETURNED_AT IS NULL/i.test(sql)) return [{ ID: 7 }]; // open loan
      return [];
    }),
    logger: noop,
  });
  await assert.rejects(() => Items.softDelete(5, 42), (e) => e.statusCode === 409);
});

test('softDelete locks the item, then deletes when there is no open loan', async () => {
  Audit.init({ db: { query: async () => [] }, logger: noop });
  let locked = false;
  let deleted = false;
  Items.init({
    db: txDb((sql) => {
      if (/PROPERTY_ID FROM|SELECT a\.PROPERTY_ID/i.test(sql)) return [{ PROPERTY_ID: 1 }];
      if (/FROM TALLY\.items WHERE ID = \? FOR UPDATE/i.test(sql)) { locked = true; return [{ ID: 5 }]; }
      if (/FROM TALLY\.item_lending WHERE ITEM_ID = \? AND RETURNED_AT IS NULL/i.test(sql)) return []; // no open loan
      if (/UPDATE TALLY\.items SET DELETED_AT = NOW\(\), STATUS = 'removed'/i.test(sql)) { deleted = true; return { affectedRows: 1 }; }
      return [];
    }),
    logger: noop,
  });
  await Items.softDelete(5, 42);
  assert.equal(locked, true, 'locks the item row FOR UPDATE first');
  assert.equal(deleted, true);
});

// ── #88: create/restore lock the container row they trust ──────────────────
// The routes' liveness checks (ContainersService.getActiveAreaId) are
// unlocked reads outside any transaction; a container recycled between that
// check and the write yields an active item under a deleted parent — phantom
// inventory. The authoritative check is a SELECT ... FOR UPDATE on the
// container row inside the SAME transaction as the INSERT/UPDATE.

const LOCK_CONTAINER = /SELECT c\.ID FROM TALLY\.containers c/i;

// Tagged tx mock (items.move.test.js idiom): records which calls ran ON the
// transaction handle vs. the plain pool connection.
function taggedTxDb(handler) {
  const calls = [];
  const db = { calls, lastTx: null, txCount: 0 };
  const route = async (sql, params, tx) => {
    calls.push({ sql: sql.replace(/\s+/g, ' '), tx: tx || null });
    return handler(sql, params);
  };
  db.query = (sql, params) => route(sql, params, null);
  db.withTransaction = async (fn) => {
    db.txCount++;
    const tx = {};
    tx.query = (sql, params) => route(sql, params, tx);
    db.lastTx = tx;
    return fn(tx);
  };
  return db;
}

test('create locks the live container FOR UPDATE inside the same tx as the INSERT', async () => {
  Audit.init({ db: { query: async () => [] }, logger: noop });
  const db = taggedTxDb((sql) => {
    if (LOCK_CONTAINER.test(sql)) return [{ ID: 7 }];
    if (/^\s*INSERT INTO TALLY\.items/i.test(sql)) return { insertId: 1 };
    if (/PROPERTY_ID/i.test(sql)) return [{ PROPERTY_ID: 1 }];
    return [{ ID: 1, NAME: 'x', CONTAINER_ID: 7 }];
  });
  Items.init({ db, logger: noop });

  await Items.create({ containerId: 7, name: 'Mug' }, 42);

  assert.equal(db.txCount, 1, 'the check+INSERT pair runs in one transaction');
  const lockIdx = db.calls.findIndex((c) => LOCK_CONTAINER.test(c.sql));
  const insertIdx = db.calls.findIndex((c) => /^\s*INSERT INTO TALLY\.items/i.test(c.sql));
  assert.ok(lockIdx >= 0, 'the container-liveness check ran');
  assert.match(db.calls[lockIdx].sql, /FOR UPDATE/i, 'the liveness check locks the container row');
  assert.match(db.calls[lockIdx].sql, /c\.DELETED_AT IS NULL AND a\.DELETED_AT IS NULL/i,
    'the locked check keeps the container+area liveness shape');
  assert.ok(lockIdx < insertIdx, 'the lock is taken BEFORE the INSERT that trusts it');
  assert.equal(db.calls[lockIdx].tx, db.lastTx, 'the lock runs ON the transaction');
  assert.equal(db.calls[insertIdx].tx, db.lastTx, 'the INSERT runs on the SAME transaction');
});

test('create 404s and never inserts when the container died after the route check', async () => {
  Audit.init({ db: { query: async () => [] }, logger: noop });
  const db = taggedTxDb((sql) => {
    if (LOCK_CONTAINER.test(sql)) return []; // recycled since the route's check
    return [];
  });
  Items.init({ db, logger: noop });

  await assert.rejects(() => Items.create({ containerId: 7, name: 'Mug' }, 42),
    (e) => e.statusCode === 404);
  assert.ok(!db.calls.some((c) => /INSERT INTO TALLY\.items/i.test(c.sql)),
    'no phantom item is ever inserted');
});

test('restore locks the live container FOR UPDATE inside the restoring tx, before the un-delete', async () => {
  Audit.init({ db: { query: async () => [] }, logger: noop });
  const db = taggedTxDb((sql) => {
    if (/SELECT DELETE_BATCH_ID, CONTAINER_ID FROM TALLY\.items/i.test(sql)) {
      return [{ DELETE_BATCH_ID: null, CONTAINER_ID: 9 }];
    }
    if (LOCK_CONTAINER.test(sql)) return [{ ID: 9 }];
    if (/PROPERTY_ID/i.test(sql)) return [{ PROPERTY_ID: 1 }];
    return [];
  });
  Items.init({ db, logger: noop });

  await Items.restore(5, 42);

  const lockIdx = db.calls.findIndex((c) => LOCK_CONTAINER.test(c.sql));
  const undeleteIdx = db.calls.findIndex((c) => /SET DELETED_AT = NULL/i.test(c.sql));
  assert.ok(lockIdx >= 0, 'the container-liveness check ran');
  assert.match(db.calls[lockIdx].sql, /FOR UPDATE/i, 'the liveness check locks the container row');
  assert.ok(undeleteIdx >= 0, 'the un-delete ran');
  assert.ok(lockIdx < undeleteIdx, 'the lock is taken BEFORE the un-delete that trusts it');
  assert.equal(db.calls[lockIdx].tx, db.lastTx, 'the lock runs ON the restoring transaction');
  assert.equal(db.calls[undeleteIdx].tx, db.lastTx, 'the un-delete runs on the SAME transaction');
});

test('restore refuses (409) and un-deletes nothing when the container died after the route check', async () => {
  Audit.init({ db: { query: async () => [] }, logger: noop });
  const db = taggedTxDb((sql) => {
    if (/SELECT DELETE_BATCH_ID, CONTAINER_ID FROM TALLY\.items/i.test(sql)) {
      return [{ DELETE_BATCH_ID: 3, CONTAINER_ID: 9 }];
    }
    if (LOCK_CONTAINER.test(sql)) return []; // recycled since the route's check
    return [];
  });
  Items.init({ db, logger: noop });

  await assert.rejects(() => Items.restore(5, 42),
    (e) => e.statusCode === 409 && /Restore the container/.test(e.message));
  assert.ok(!db.calls.some((c) => /SET DELETED_AT = NULL/i.test(c.sql)),
    'nothing is un-deleted into a dead container');
});

// purgeExpired must skip items with an open loan (defense in depth).
test('purgeExpired excludes open-loan items via NOT EXISTS', async () => {
  let selectSql = '';
  Items.init({
    db: {
      query: async (sql) => {
        if (/SELECT i\.ID FROM TALLY\.items i/i.test(sql)) { selectSql = sql.replace(/\s+/g, ' '); return []; }
        return [];
      },
    },
    logger: noop,
  });
  await Items.purgeExpired(42);
  assert.match(selectSql, /NOT EXISTS \( SELECT 1 FROM TALLY\.item_lending il WHERE il\.ITEM_ID = i\.ID AND il\.RETURNED_AT IS NULL \)/i,
    'the purge selection skips items that still have an open loan');
});

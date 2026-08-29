const test = require('node:test');
const assert = require('node:assert');
const Containers = require('../src/modules/inventory/containers.service');
const AreasService = require('../src/modules/inventory/areas.service');
const AuditService = require('../src/modules/audit/audit.service');

const noop = { warn() {}, info() {}, error() {} };
AuditService.init({ db: { query: async () => [] }, logger: noop });

// ── #251: container create joins the #88 lock discipline ────────────────────
// containers.routes.js used to validate the parent container with an unlocked
// pool read (getActiveAreaId) BEFORE the write's transaction — the same
// check-then-write TOCTOU #88 closed for item create/move/restore. The
// authoritative check now lives INSIDE create()'s transaction as a
// SELECT ... FOR UPDATE OF c on the parent row (live parent, live area,
// same-area rule), and the route-level pre-check is gone: one check,
// correctly placed. Idiom mirrors items.move.test.js (#88): SQL shape +
// tx identity.

// txDb idiom (items.move.test.js): query() routes by regex to a canned
// result; withTransaction() hands the callback ONE tagged tx whose .query()
// shares the router/call log, so a test can prove a call ran ON the
// transaction vs. on the plain pool connection. SQL is flattened for
// single-line regex matching.
function txDb(routes) {
  const calls = [];
  const route = async (sql, params, tx) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: flat, params, tx: tx || null });
    for (const [re, result] of routes) if (re.test(flat)) return typeof result === 'function' ? result(flat, params) : result;
    return [];
  };
  const db = { calls, txCount: 0, lastTx: null };
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

// The locked parent check: the only containers.service query selecting
// c.AREA_ID under FOR UPDATE OF c (move()'s parent-area read has the same
// SELECT list but no lock — the FOR UPDATE is what's being pinned here).
const PARENT_LOCK = /SELECT c\.AREA_ID FROM TALLY\.containers c JOIN TALLY\.areas a ON c\.AREA_ID = a\.ID WHERE c\.ID = \? AND c\.DELETED_AT IS NULL AND a\.DELETED_AT IS NULL FOR UPDATE OF c/;
const INSERT_CONTAINER = /INSERT INTO TALLY\.containers/;
const CLOSURE_INSERT = /INSERT INTO TALLY\.container_paths/;
const GET_BY_ID = /PROPERTY_ID AS PROPERTY_ID/;
const GET_PROPERTY_ID = /SELECT a\.PROPERTY_ID/;

test('create with a parent locks the live parent FOR UPDATE in the same tx as the INSERT, before it', async () => {
  const db = txDb([
    [PARENT_LOCK, [{ AREA_ID: 7 }]],
    [INSERT_CONTAINER, { insertId: 99 }],
    [GET_PROPERTY_ID, [{ PROPERTY_ID: 1 }]],
    [GET_BY_ID, [{ ID: 99, NAME: 'Bin', AREA_ID: 7 }]],
  ]);
  Containers.init({ db, logger: noop });

  await Containers.create({ areaId: 7, parentContainerId: 3, name: 'Bin', type: 'box' }, 42);

  assert.equal(db.txCount, 1, 'exactly one transaction for the check+write pair');

  const lockIdx = db.calls.findIndex((c) => PARENT_LOCK.test(c.sql));
  const insertIdx = db.calls.findIndex((c) => INSERT_CONTAINER.test(c.sql));
  const closureIdx = db.calls.findIndex((c) => CLOSURE_INSERT.test(c.sql));
  assert.ok(lockIdx >= 0, 'the locked parent check ran');
  assert.match(db.calls[lockIdx].sql, /FOR UPDATE OF c/, 'the check locks the parent container row (point lock, area row unlocked)');
  assert.match(db.calls[lockIdx].sql, /c\.DELETED_AT IS NULL AND a\.DELETED_AT IS NULL/,
    'the locked check keeps the container+area liveness shape (mirrors getActiveAreaId / _lockLiveContainer)');
  assert.deepEqual(db.calls[lockIdx].params, [3], 'a point lock on exactly the parent row');
  assert.ok(insertIdx >= 0 && closureIdx >= 0, 'the INSERT and the closure write ran');
  assert.ok(lockIdx < insertIdx, 'the lock is taken BEFORE the write that trusts it');
  assert.equal(db.calls[lockIdx].tx, db.lastTx, 'the lock runs ON the transaction');
  assert.equal(db.calls[insertIdx].tx, db.lastTx, 'the INSERT runs on the SAME transaction');
  assert.equal(db.calls[closureIdx].tx, db.lastTx, 'the closure write runs on the SAME transaction');

  const txSqls = db.calls.filter((c) => c.tx);
  assert.ok(PARENT_LOCK.test(txSqls[0].sql), 'the parent lock is the FIRST statement of the transaction');
});

test('create 404s and writes nothing when the parent died between request and transaction', async () => {
  const audits = [];
  const origLog = AuditService.logChange;
  AuditService.logChange = async (...args) => { audits.push(args); };
  const db = txDb([
    [PARENT_LOCK, []], // parent recycled (or its area) — the window #251 closes
  ]);
  Containers.init({ db, logger: noop });
  try {
    await assert.rejects(
      () => Containers.create({ areaId: 7, parentContainerId: 3, name: 'Bin', type: 'box' }, 42),
      (e) => e.statusCode === 404 && /Parent container not found/.test(e.message)
    );
    assert.ok(!db.calls.some((c) => INSERT_CONTAINER.test(c.sql)),
      'no container row is created under a dead parent (no phantom inventory)');
    assert.ok(!db.calls.some((c) => CLOSURE_INSERT.test(c.sql)), 'no closure paths are written');
    assert.equal(audits.length, 0, 'a refused create is not audited');
  } finally {
    AuditService.logChange = origLog;
  }
});

test('create 400s and writes nothing when the locked parent turns out to be in another area', async () => {
  // The same-area rule is decided against the LOCKED row — a parent moved to
  // another area between the request and our lock is caught here, where the
  // old route-level pre-check would have already waved it through.
  const db = txDb([
    [PARENT_LOCK, [{ AREA_ID: 9 }]], // live, but not in areaId 7
  ]);
  Containers.init({ db, logger: noop });
  await assert.rejects(
    () => Containers.create({ areaId: 7, parentContainerId: 3, name: 'Bin', type: 'box' }, 42),
    (e) => e.statusCode === 400 && /same area/.test(e.message)
  );
  assert.ok(!db.calls.some((c) => INSERT_CONTAINER.test(c.sql)), 'nothing is inserted cross-area');
});

test('a parentless create takes no container lock at all', async () => {
  const db = txDb([
    [INSERT_CONTAINER, { insertId: 99 }],
    [GET_PROPERTY_ID, [{ PROPERTY_ID: 1 }]],
    [GET_BY_ID, [{ ID: 99, NAME: 'Bin', AREA_ID: 7 }]],
  ]);
  Containers.init({ db, logger: noop });
  await Containers.create({ areaId: 7, parentContainerId: null, name: 'Bin', type: 'box' }, 42);
  assert.ok(!db.calls.some((c) => /FOR UPDATE/.test(c.sql)),
    'no FOR UPDATE anywhere — a root container trusts no parent row');
  const insertIdx = db.calls.findIndex((c) => INSERT_CONTAINER.test(c.sql));
  assert.equal(db.calls[insertIdx].tx, db.lastTx, 'the INSERT still runs in the transaction');
});

test('the ER_DUP_ENTRY retry re-locks the parent in its fresh transaction', async () => {
  // The retry is a NEW transaction, so the locked check must run again —
  // the parent could have died while the first attempt was rolling back.
  let inserts = 0;
  const db = txDb([
    [PARENT_LOCK, [{ AREA_ID: 7 }]],
    [INSERT_CONTAINER, () => {
      inserts++;
      if (inserts === 1) {
        const err = new Error('dup qr_code');
        err.code = 'ER_DUP_ENTRY';
        err.message = "Duplicate entry for key 'qr_code'";
        throw err;
      }
      return { insertId: 99 };
    }],
    [GET_PROPERTY_ID, [{ PROPERTY_ID: 1 }]],
    [GET_BY_ID, [{ ID: 99, NAME: 'Bin', AREA_ID: 7 }]],
  ]);
  Containers.init({ db, logger: noop });
  await Containers.create({ areaId: 7, parentContainerId: 3, name: 'Bin', type: 'box' }, 42);
  assert.equal(db.txCount, 2, 'two transactions: the failed insert and the retry');
  const locks = db.calls.filter((c) => PARENT_LOCK.test(c.sql));
  assert.equal(locks.length, 2, 'the parent is re-locked on the retry');
  assert.equal(locks[1].tx, db.lastTx, "the retry's lock runs on the retry's own transaction");
});

// ── Route: the unlocked pre-check is GONE ───────────────────────────────────
// The route middleware now only validates the body and resolves the property
// from the area — it must not read the parent container on the pool. (That
// read also ran BEFORE the role gate, leaking parent liveness to callers
// with no access to the parent's property.) Harness idiom mirrors
// items.move.test.js's route registration tests.

function registerContainerRoutes(db) {
  const routes = [];
  const record = (m) => (p, ...handlers) => routes.push({ method: m, path: p, handlers });
  const app = {
    locals: {
      requireAuth: (req, res, next) => next(),
      resolvePropertyRole: (req, res, next) => next(),
      requireRole: () => (req, res, next) => next(),
    },
    get: record('GET'), post: record('POST'), put: record('PUT'),
    patch: record('PATCH'), delete: record('DELETE'),
  };
  require('../src/modules/inventory/containers.routes')({ app, db, logger: noop });
  return routes;
}

test('route: the create middleware resolves the property but never pre-reads the parent container', async () => {
  const db = txDb([
    [/SELECT PROPERTY_ID FROM TALLY\.areas WHERE ID = \?/, [{ PROPERTY_ID: 1 }]],
  ]);
  AreasService.init({ db, logger: noop });
  Containers.init({ db, logger: noop });

  const routes = registerContainerRoutes(db);
  const r = routes.find((x) => x.method === 'POST' && x.path === '/api/containers/_y_/create');
  // handlers: [requireAuth, validate+resolve middleware, resolvePropertyRole, requireRole, handler]
  const middleware = r.handlers[1];

  let nexted = false;
  const req = { body: { areaId: 7, parentContainerId: 3, name: 'Bin', type: 'box' }, params: {} };
  const res = { status() { return this; }, json() { return this; } };
  await middleware(req, res, () => { nexted = true; });

  assert.ok(nexted, 'the middleware passed the request on');
  assert.equal(req.params.propertyId, 1, 'the property is still resolved from the area');
  assert.ok(!db.calls.some((c) => /FROM TALLY\.containers/.test(c.sql)),
    'no containers-table read at the route layer — the parent check belongs to the locked service tx (#251)');
});

const test = require('node:test');
const assert = require('node:assert');
const Items = require('../src/modules/inventory/items.service');
const Reconcile = require('../src/modules/inventory/move-reconcile.service');
const AuditService = require('../src/modules/audit/audit.service');

const noop = { warn() {}, info() {}, error() {} };
AuditService.init({ db: { query: async () => [] }, logger: noop });

// Scriptable db: query() routes by regex to a canned result (same idiom as
// move-reconcile.test.js's fakeTx and items.integrity.test.js's txDb).
// withTransaction() hands the callback ONE tagged tx object whose .query()
// shares the same router/call log, tagged with `tx` so a test can prove a
// call ran ON THE TRANSACTION vs. on the plain pool connection.
function txDb(routes) {
  const calls = [];
  const route = async (sql, params, tx) => {
    calls.push({ sql, params, tx: tx || null });
    for (const [re, result] of routes) if (re.test(sql)) return typeof result === 'function' ? result(sql, params) : result;
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

// getById's SELECT is uniquely identifiable by this alias (it JOINs
// containers/areas/properties, unlike any other items.service query).
const GET_BY_ID = /PROPERTY_ID AS PROPERTY_ID/;
// getPropertyIdForItem's SELECT is the only query starting with this prefix.
const GET_PROPERTY_ID_FOR_ITEM = /SELECT a\.PROPERTY_ID/;
// _lockLiveContainer's locked liveness re-check (#88): the only items.service
// query that selects c.ID from containers.
const LOCK_CONTAINER = /SELECT c\.ID FROM TALLY\.containers c/;
// Routed as [{ ID: 30 }] when the destination is live; [] when recycled.
const LIVE_DEST = [LOCK_CONTAINER, [{ ID: 30 }]];

// ── Same-property move: check and write share ONE transaction (#88) ─────────
// The destination-liveness SELECT must carry FOR UPDATE and run on the SAME
// tx as the UPDATE, before it — an unlocked route-level check leaves a window
// for the container to be recycled between check and write (phantom item).

test('same-property move locks the live destination FOR UPDATE in the same tx as the UPDATE', async () => {
  const audits = [];
  const origLog = AuditService.logChange;
  AuditService.logChange = async (...args) => { audits.push(args); };
  const db = txDb([
    LIVE_DEST,
    [GET_BY_ID, [{ ID: 5, NAME: 'Widget', CONTAINER_ID: 30 }]],
    [GET_PROPERTY_ID_FOR_ITEM, [{ PROPERTY_ID: 1 }]],
  ]);
  Items.init({ db, logger: noop });
  try {
    const out = await Items.move(5, 30, 42); // no opts — the pre-existing call shape
    assert.equal(db.txCount, 1, 'exactly one transaction for the check+write pair');

    const lockIdx = db.calls.findIndex((c) => LOCK_CONTAINER.test(c.sql));
    const updateIdx = db.calls.findIndex((c) => /UPDATE TALLY\.items SET CONTAINER_ID/.test(c.sql));
    assert.ok(lockIdx >= 0, 'the destination-liveness check ran');
    assert.match(db.calls[lockIdx].sql, /FOR UPDATE/, 'the liveness check locks the container row');
    assert.match(db.calls[lockIdx].sql, /c\.DELETED_AT IS NULL AND a\.DELETED_AT IS NULL/,
      'the locked check keeps the container+area liveness shape');
    assert.ok(updateIdx >= 0, 'the UPDATE ran');
    assert.ok(lockIdx < updateIdx, 'the lock is taken BEFORE the write that trusts it');
    assert.equal(db.calls[lockIdx].tx, db.lastTx, 'the lock runs ON the transaction');
    assert.equal(db.calls[updateIdx].tx, db.lastTx, 'the UPDATE runs on the SAME transaction');

    const updates = db.calls.filter((c) => /UPDATE TALLY\.items SET CONTAINER_ID/.test(c.sql));
    assert.equal(updates.length, 1, 'exactly one UPDATE TALLY.items');

    assert.ok(
      !db.calls.some((c) => /TALLY\.(entity_tags|item_accessories|container_paths|tags)\b/.test(c.sql)),
      'no reconciliation table (entity_tags, item_accessories, container_paths, tags) is touched'
    );

    assert.equal(audits.length, 1, 'audited exactly once');
    assert.equal(audits[0][3], 'moved', 'the audit action is the plain "moved" event');

    assert.equal(out.consequences, null, 'no consequences for a same-property move');
  } finally {
    AuditService.logChange = origLog;
  }
});

test('same-property move 404s and never writes when the destination died after the route check', async () => {
  const audits = [];
  const origLog = AuditService.logChange;
  AuditService.logChange = async (...args) => { audits.push(args); };
  const db = txDb([
    [LOCK_CONTAINER, []], // recycled between the route's check and the write
    [GET_PROPERTY_ID_FOR_ITEM, [{ PROPERTY_ID: 1 }]],
  ]);
  Items.init({ db, logger: noop });
  try {
    await assert.rejects(() => Items.move(5, 30, 42),
      (e) => e.statusCode === 404 && /Destination container/.test(e.message));
    assert.ok(!db.calls.some((c) => /UPDATE TALLY\.items/.test(c.sql)),
      'the item is never moved into a dead container');
    assert.equal(audits.length, 0, 'a refused move is not audited');
  } finally {
    AuditService.logChange = origLog;
  }
});

// ── Cross-property: one transaction, same tx handle throughout ─────────────

test('cross-property move runs the UPDATE and reconciliation inside ONE transaction, on the same tx handle', async () => {
  const db = txDb([
    LIVE_DEST,
    [GET_BY_ID, [{ ID: 5, NAME: 'Widget', CONTAINER_ID: 30 }]],
  ]);
  Items.init({ db, logger: noop });

  const origMovingSet = Reconcile.movingSet;
  const origReconcile = Reconcile.reconcile;
  const seenTxs = [];
  let reconcileOpts = null;
  Reconcile.movingSet = async (tx, entityType, entityId) => {
    seenTxs.push(tx);
    assert.equal(entityType, 'item');
    return { containerIds: [], itemIds: [Number(entityId)] };
  };
  Reconcile.reconcile = async (tx, set, opts) => {
    seenTxs.push(tx);
    reconcileOpts = opts;
    return { unlinked: [], tagsCarried: 0, tagsCreated: 0 };
  };

  try {
    const out = await Items.move(5, 30, 42, { crossProperty: { srcPropertyId: 1, destPropertyId: 2 } });

    assert.equal(db.txCount, 1, 'exactly one transaction opened');

    // #88: the locked destination-liveness check rides the same tx, first.
    const lockIdx = db.calls.findIndex((c) => LOCK_CONTAINER.test(c.sql));
    const updateIdx = db.calls.findIndex((c) => /UPDATE TALLY\.items SET CONTAINER_ID/.test(c.sql));
    assert.ok(lockIdx >= 0, 'the destination-liveness check ran');
    assert.match(db.calls[lockIdx].sql, /FOR UPDATE/, 'the liveness check locks the container row');
    assert.equal(db.calls[lockIdx].tx, db.lastTx, 'the lock runs ON the transaction');
    assert.ok(lockIdx < updateIdx, 'the lock is taken BEFORE the UPDATE that trusts it');

    const updateCall = db.calls[updateIdx];
    assert.ok(updateCall, 'the UPDATE ran');
    assert.equal(updateCall.tx, db.lastTx, 'the UPDATE ran on the transaction handle');

    assert.equal(seenTxs.length, 2, 'both movingSet and reconcile were called');
    assert.ok(seenTxs.every((t) => t === db.lastTx), 'movingSet and reconcile received the SAME tx as the UPDATE');

    assert.deepEqual(reconcileOpts, {
      srcPropertyId: 1, destPropertyId: 2, userId: 42,
      rootType: 'item', rootId: 5, moveChanges: { containerId: 30 },
    }, 'reconcile is called with the right root/property/change bookkeeping');

    assert.deepEqual(out.consequences, { unlinked: [], tagsCarried: 0, tagsCreated: 0 });
  } finally {
    Reconcile.movingSet = origMovingSet;
    Reconcile.reconcile = origReconcile;
  }
});

test('cross-property move rolls up as 404 with no write when the destination died after the route check', async () => {
  const db = txDb([
    [LOCK_CONTAINER, []], // recycled between the route's check and the tx
  ]);
  Items.init({ db, logger: noop });

  const origMovingSet = Reconcile.movingSet;
  const origReconcile = Reconcile.reconcile;
  Reconcile.movingSet = async () => { throw new Error('reconciliation must not start against a dead destination'); };
  Reconcile.reconcile = async () => { throw new Error('reconciliation must not start against a dead destination'); };
  try {
    await assert.rejects(
      () => Items.move(5, 30, 42, { crossProperty: { srcPropertyId: 1, destPropertyId: 2 } }),
      (e) => e.statusCode === 404 && /Destination container/.test(e.message)
    );
    assert.ok(!db.calls.some((c) => /UPDATE TALLY\.items/.test(c.sql)),
      'the item is never moved into a dead container');
  } finally {
    Reconcile.movingSet = origMovingSet;
    Reconcile.reconcile = origReconcile;
  }
});

// ── Cross-property audit: moved-out + moved-in, never plain "moved" ────────

test('cross-property move logs exactly moved-out and moved-in — never a plain "moved"', async () => {
  const db = txDb([
    LIVE_DEST,
    [GET_BY_ID, [{ ID: 5, NAME: 'Widget', CONTAINER_ID: 30 }]],
  ]);
  Items.init({ db, logger: noop });

  const audits = [];
  const origLog = AuditService.logChange;
  AuditService.logChange = async (...args) => { audits.push(args); };

  const origMovingSet = Reconcile.movingSet;
  const origReconcile = Reconcile.reconcile;
  Reconcile.movingSet = async (tx, entityType, entityId) => ({ containerIds: [], itemIds: [Number(entityId)] });
  // reconcile() is data-only (tags/accessories) — it never audits (pinned in
  // move-reconcile.test.js). Left unmocked here would still be fine since it
  // no longer touches AuditService at all; canned to skip its own DB queries.
  Reconcile.reconcile = async () => ({ unlinked: [], tagsCarried: 0, tagsCreated: 0 });

  try {
    // Reconcile.auditMove itself is REAL here — this exercises the actual
    // call items.service.js makes, not a stand-in for it.
    await Items.move(5, 30, 42, { crossProperty: { srcPropertyId: 1, destPropertyId: 2 } });
    assert.equal(audits.length, 2, 'exactly two audit entries');
    assert.equal(audits[0][3], 'moved-out');
    assert.equal(audits[1][3], 'moved-in');
    assert.ok(!audits.some((a) => a[3] === 'moved'), 'no plain "moved" audit fires on the cross-property path');
  } finally {
    AuditService.logChange = origLog;
    Reconcile.movingSet = origMovingSet;
    Reconcile.reconcile = origReconcile;
  }
});

// ── Fix round 1: audit must happen AFTER the transaction resolves ──────────
// logChange writes through AuditService's module-global _db.query — a plain
// pool connection, not the transaction's tx handle — so calling it from
// INSIDE the transaction would let an audit row commit durably even if the
// transaction later rolled back. auditMove must only be invoked once
// _db.withTransaction has already resolved.

test('cross-property move calls Reconcile.auditMove only AFTER the transaction has resolved', async () => {
  const order = [];
  const db = txDb([
    LIVE_DEST,
    [GET_BY_ID, [{ ID: 5, NAME: 'Widget', CONTAINER_ID: 30 }]],
  ]);
  const origWithTransaction = db.withTransaction;
  db.withTransaction = async (fn) => {
    const result = await origWithTransaction(fn);
    order.push('tx-resolved');
    return result;
  };
  Items.init({ db, logger: noop });

  const origMovingSet = Reconcile.movingSet;
  const origReconcile = Reconcile.reconcile;
  const origAuditMove = Reconcile.auditMove;
  Reconcile.movingSet = async (tx, entityType, entityId) => ({ containerIds: [], itemIds: [Number(entityId)] });
  Reconcile.reconcile = async () => ({ unlinked: [], tagsCarried: 0, tagsCreated: 0 });
  Reconcile.auditMove = async () => { order.push('auditMove-called'); };

  try {
    await Items.move(5, 30, 42, { crossProperty: { srcPropertyId: 1, destPropertyId: 2 } });
    assert.deepEqual(order, ['tx-resolved', 'auditMove-called'],
      'auditMove is called strictly after withTransaction resolves, never from inside it');
  } finally {
    Reconcile.movingSet = origMovingSet;
    Reconcile.reconcile = origReconcile;
    Reconcile.auditMove = origAuditMove;
  }
});

// ── Cross-property return shape: {item, consequences} passes through ───────

test('move() with crossProperty returns {item, consequences}, with the reconcile result passed through untouched', async () => {
  const db = txDb([
    LIVE_DEST,
    [GET_BY_ID, [{ ID: 5, NAME: 'Widget', CONTAINER_ID: 30 }]],
  ]);
  Items.init({ db, logger: noop });

  const origMovingSet = Reconcile.movingSet;
  const origReconcile = Reconcile.reconcile;
  const canned = { unlinked: [{ itemId: 9, name: 'Charger' }], tagsCarried: 2, tagsCreated: 1 };
  Reconcile.movingSet = async (tx, entityType, entityId) => ({ containerIds: [], itemIds: [Number(entityId)] });
  Reconcile.reconcile = async () => canned;

  try {
    const out = await Items.move(5, 30, 42, { crossProperty: { srcPropertyId: 1, destPropertyId: 2 } });
    assert.ok(out.item, 'the moved item is returned');
    assert.equal(out.item.id, 5);
    assert.deepEqual(out.consequences, canned, 'consequences is exactly what reconcile returned, untouched');
  } finally {
    Reconcile.movingSet = origMovingSet;
    Reconcile.reconcile = origReconcile;
  }
});

// ── Route-ordering pins (mirrors containers.move-cross.test.js) ────────────
// items.routes.js's move handler has the identical 403 → liveness → preview/
// confirm structure as the container route, but lacked route-level coverage
// for it — only the service-level tests above existed. Same idiom: a fake
// app records route registrations, the final handler (past requireAuth/
// resolveProperty*/requireRole) is extracted and invoked directly.

const ContainersServiceForRoutes = require('../src/modules/inventory/containers.service');

function registerItemRoutes(db) {
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
  require('../src/modules/inventory/items.routes')({ app, db, logger: noop });
  return routes;
}

function moveRouteHandler(routes) {
  const r = routes.find((r) => r.method === 'PATCH' && r.path === '/api/items/_p_/:itemId/move');
  const handlers = r.handlers;
  return handlers[handlers.length - 1]; // the route's own async (req, res) => {...}
}

function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

// getPropertyIdForContainer's and getActiveAreaId's SELECTs, distinguishable
// by their leading column list — same markers containers.move-cross.test.js
// uses for the container-side equivalents.
const DEST_PROPERTY_ID = /SELECT a\.PROPERTY_ID/;
const DEST_LIVE = /SELECT c\.AREA_ID FROM TALLY\.containers c/;

test('route: destination container in another property — 403 without destination membership, proceeds with editor membership', async () => {
  let memberRows = [];
  const db = {
    query: async (sql) => {
      if (DEST_PROPERTY_ID.test(sql)) return [{ PROPERTY_ID: 2 }];
      if (/SELECT ROLE FROM TALLY\.property_members/.test(sql)) return memberRows;
      if (DEST_LIVE.test(sql)) return [{ AREA_ID: 7 }]; // destination container is live
      return [];
    },
    withTransaction: async (fn) => fn({ query: async () => [] }),
  };
  ContainersServiceForRoutes.init({ db, logger: noop });

  const handler = moveRouteHandler(registerItemRoutes(db));
  const baseReq = {
    params: { itemId: 5, propertyId: 1 }, // srcPropertyId as resolved by the (bypassed) middleware
    user: { id: 42 },
  };

  // No membership at the destination property → 403, and the preview must
  // never run first (it would leak the destination's shape to a non-member).
  memberRows = [];
  const origMovingSet = Reconcile.movingSet;
  Reconcile.movingSet = async () => { throw new Error('preview must not run before the 403 gate'); };
  try {
    const res = mockRes();
    await handler({ ...baseReq, body: { containerId: 30 } }, res);
    assert.equal(res.statusCode, 403);
    assert.match(res.body.message, /editor access to the destination property/);
  } finally {
    Reconcile.movingSet = origMovingSet;
  }

  // Editor membership at the destination → past the gate, move is reached.
  memberRows = [{ ROLE: 'editor' }];
  const origMove = Items.move;
  let moveArgs = null;
  Items.move = async (...args) => { moveArgs = args; return { item: { id: 5 }, consequences: null }; };
  try {
    const res = mockRes();
    // confirm:true sidesteps the preview branch — that gate is covered separately below.
    await handler({ ...baseReq, body: { containerId: 30, confirm: true } }, res);
    assert.equal(res.statusCode, 200);
    assert.ok(moveArgs, 'ItemsService.move was reached');
    assert.deepEqual(moveArgs[3], { crossProperty: { srcPropertyId: 1, destPropertyId: 2 } });
  } finally {
    Items.move = origMove;
  }
});

test('route: unconfirmed lossy cross-property move is 409 with the consequence payload; confirm:true proceeds to 200', async () => {
  const db = {
    query: async (sql) => {
      if (DEST_PROPERTY_ID.test(sql)) return [{ PROPERTY_ID: 2 }];
      if (/SELECT ROLE FROM TALLY\.property_members/.test(sql)) return [{ ROLE: 'editor' }];
      if (DEST_LIVE.test(sql)) return [{ AREA_ID: 7 }];
      return [];
    },
    withTransaction: async (fn) => fn({ query: async () => [] }),
  };
  ContainersServiceForRoutes.init({ db, logger: noop });

  const handler = moveRouteHandler(registerItemRoutes(db));
  const req = {
    params: { itemId: 5, propertyId: 1 },
    body: { containerId: 30 },
    user: { id: 42 },
  };

  const canned = { unlinked: [{ itemId: 9, name: 'Charger' }], tagsCarried: 1, tagsCreated: 0 };
  const origMovingSet = Reconcile.movingSet;
  const origPreview = Reconcile.previewConsequences;
  Reconcile.movingSet = async () => ({ containerIds: [], itemIds: [5] });
  Reconcile.previewConsequences = async () => canned;

  const origMove = Items.move;
  let moveCalled = false;
  Items.move = async () => { moveCalled = true; return { item: { id: 5 }, consequences: canned }; };

  try {
    // Unconfirmed → 409, move never runs.
    const res1 = mockRes();
    await handler(req, res1);
    assert.equal(res1.statusCode, 409);
    assert.deepEqual(res1.body.errors, canned, 'the 409 payload is exactly the preview');
    assert.equal(moveCalled, false, 'the move never runs when confirmation is needed');

    // confirm:true → 200, move runs.
    const res2 = mockRes();
    await handler({ ...req, body: { ...req.body, confirm: true } }, res2);
    assert.equal(res2.statusCode, 200);
    assert.ok(moveCalled, 'the move runs once confirmed');
  } finally {
    Reconcile.movingSet = origMovingSet;
    Reconcile.previewConsequences = origPreview;
    Items.move = origMove;
  }
});

// ── Route: destination liveness is checked BEFORE the preview/confirm gate ─
// Mirrors the container route's equivalent pin: confirming a lossy move must
// never dead-end in a 404 the caller had no way to see coming.

test('route: a recycled destination container 404s before the preview ever runs', async () => {
  const db = {
    query: async (sql) => {
      if (DEST_PROPERTY_ID.test(sql)) return [{ PROPERTY_ID: 2 }];
      if (/SELECT ROLE FROM TALLY\.property_members/.test(sql)) return [{ ROLE: 'editor' }];
      // No row: the destination container is gone (soft-deleted or never existed).
      if (DEST_LIVE.test(sql)) return [];
      return [];
    },
    withTransaction: async (fn) => fn({ query: async () => [] }),
  };
  ContainersServiceForRoutes.init({ db, logger: noop });

  const handler = moveRouteHandler(registerItemRoutes(db));
  const req = {
    params: { itemId: 5, propertyId: 1 },
    body: { containerId: 30 },
    user: { id: 42 },
  };

  const origMovingSet = Reconcile.movingSet;
  Reconcile.movingSet = async () => { throw new Error('preview must not run once the destination is known dead'); };
  try {
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 404);
  } finally {
    Reconcile.movingSet = origMovingSet;
  }
});

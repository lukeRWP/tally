const test = require('node:test');
const assert = require('node:assert');
const Containers = require('../src/modules/inventory/containers.service');
const AreasService = require('../src/modules/inventory/areas.service');
const Reconcile = require('../src/modules/inventory/move-reconcile.service');
const AuditService = require('../src/modules/audit/audit.service');

const noop = { warn() {}, info() {}, error() {} };
AuditService.init({ db: { query: async () => [] }, logger: noop });

// ── txDb idiom (copied from items.move.test.js — self-contained per repo
// convention). Scriptable db: query() routes by regex to a canned result.
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

// Query fragments reused from containers.integrity.test.js's move() coverage.
const LOCK = /FROM TALLY\.containers WHERE ID IN .* FOR UPDATE/i;
const CYCLE = /container_paths WHERE ANCESTOR_ID = \? AND DESCENDANT_ID = \?/i;
const PARENT_AREA = /SELECT c\.AREA_ID FROM TALLY\.containers c/i;
const CASCADE = /UPDATE TALLY\.containers SET AREA_ID = \? WHERE ID IN/i;
// getById's SELECT is uniquely identifiable by this alias, same marker
// items.move.test.js uses for items.service.js's getById.
const GET_BY_ID = /PROPERTY_ID AS PROPERTY_ID/;
// getPropertyIdForContainer's SELECT is the only query starting with this prefix.
const GET_PROPERTY_ID_FOR_CONTAINER = /SELECT a\.PROPERTY_ID/;

// ── REGRESSION PIN — same-property container move is untouched ─────────────

test('REGRESSION PIN: same-property container move keeps its statement sequence and never reconciles', async () => {
  const audits = [];
  const origLog = AuditService.logChange;
  AuditService.logChange = async (...args) => { audits.push(args); };

  // If reconcile ran at all for a same-property move, these would throw —
  // a stronger pin than scanning the SQL text for table names, since it
  // proves the code path never even reaches the reconciliation branch.
  const origMovingSet = Reconcile.movingSet;
  const origReconcile = Reconcile.reconcile;
  Reconcile.movingSet = async () => { throw new Error('movingSet must not run for a same-property move'); };
  Reconcile.reconcile = async () => { throw new Error('reconcile must not run for a same-property move'); };

  const db = txDb([
    [LOCK, (sql, params) => params.map((id) => ({ ID: id }))],
    [CYCLE, []], // no cycle
    [PARENT_AREA, [{ AREA_ID: 7 }]],
    [GET_PROPERTY_ID_FOR_CONTAINER, [{ PROPERTY_ID: 1 }]],
    [GET_BY_ID, [{ ID: 5, NAME: 'Bin', AREA_ID: 7 }]],
  ]);
  Containers.init({ db, logger: noop });

  try {
    const out = await Containers.move(5, 3, undefined, 42); // no opts — the pre-existing call shape
    assert.equal(db.txCount, 1, 'exactly one transaction, as before');

    const seq = db.calls.filter((c) => c.tx).map((c) => c.sql.replace(/\s+/g, ' ').trim());
    const idx = (re) => seq.findIndex((s) => re.test(s));
    const lockIdx = idx(LOCK), cycleIdx = idx(CYCLE), areaIdx = idx(PARENT_AREA), cascadeIdx = idx(CASCADE);
    assert.equal(lockIdx, 0, 'first statement locks the rows FOR UPDATE');
    assert.ok(cycleIdx > lockIdx, 'cycle check follows the lock');
    assert.ok(areaIdx > cycleIdx, 'area derivation follows the cycle check');
    assert.ok(cascadeIdx > areaIdx, 'AREA_ID cascade is last');

    assert.ok(
      !db.calls.some((c) => /TALLY\.(entity_tags|item_accessories|tags)\b/i.test(c.sql)),
      'nothing touching entity_tags/item_accessories/tags for a same-property move'
    );

    assert.equal(audits.length, 1, 'audited exactly once');
    assert.equal(audits[0][3], 'moved', 'the audit action is the plain "moved" event, unchanged');

    assert.equal(out.consequences, null, 'no consequences for a same-property move');
    assert.equal(out.container.id, 5, 'container returned, wrapped in the new {container, consequences} shape');
  } finally {
    AuditService.logChange = origLog;
    Reconcile.movingSet = origMovingSet;
    Reconcile.reconcile = origReconcile;
  }
});

// ── Cross-property: one transaction, same tx handle throughout ─────────────

test('cross-property move runs reconciliation INSIDE the existing transaction, on the same tx handle as the lock/cascade queries', async () => {
  const db = txDb([
    [LOCK, (sql, params) => params.map((id) => ({ ID: id }))],
    [CYCLE, []],
    [PARENT_AREA, [{ AREA_ID: 7 }]],
    [GET_BY_ID, [{ ID: 5, NAME: 'Bin', AREA_ID: 7 }]],
  ]);
  Containers.init({ db, logger: noop });

  const origMovingSet = Reconcile.movingSet;
  const origReconcile = Reconcile.reconcile;
  const seenTxs = [];
  let reconcileOpts = null;
  Reconcile.movingSet = async (tx, entityType, entityId) => {
    seenTxs.push(tx);
    assert.equal(entityType, 'container');
    assert.equal(Number(entityId), 5);
    return { containerIds: [5, 9], itemIds: [101, 102] };
  };
  Reconcile.reconcile = async (tx, set, opts) => {
    seenTxs.push(tx);
    reconcileOpts = opts;
    return { unlinked: [], tagsCarried: 0, tagsCreated: 0 };
  };

  try {
    const out = await Containers.move(5, 3, undefined, 42, { crossProperty: { srcPropertyId: 1, destPropertyId: 2 } });

    assert.equal(db.txCount, 1, 'exactly one transaction opened for the whole move');

    // Collapse whitespace before matching — the real query strings are
    // multi-line template literals, and CASCADE (like the other markers) is
    // written against a single-spaced form.
    const cascadeCall = db.calls.find((c) => CASCADE.test(c.sql.replace(/\s+/g, ' ').trim()));
    assert.ok(cascadeCall, 'the cascade ran');
    assert.equal(cascadeCall.tx, db.lastTx, 'the cascade ran on the transaction handle');

    assert.equal(seenTxs.length, 2, 'both movingSet and reconcile were called');
    assert.ok(seenTxs.every((t) => t === db.lastTx), 'movingSet and reconcile received the SAME tx handle as the lock/cascade queries');

    assert.deepEqual(reconcileOpts, {
      srcPropertyId: 1, destPropertyId: 2, userId: 42,
      rootType: 'container', rootId: 5, moveChanges: { parentContainerId: 3, areaId: undefined },
    }, 'reconcile is called with the right root/property/change bookkeeping');

    assert.deepEqual(out.consequences, { unlinked: [], tagsCarried: 0, tagsCreated: 0 });
  } finally {
    Reconcile.movingSet = origMovingSet;
    Reconcile.reconcile = origReconcile;
  }
});

// ── Fix round 1: audit must happen AFTER the transaction resolves ──────────
// logChange writes through AuditService's module-global _db.query — a plain
// pool connection, not the transaction's tx handle — so calling it from
// INSIDE the transaction would let an audit row commit durably even if the
// transaction later rolled back. auditMove must only be invoked once
// _db.withTransaction has already resolved (mirrors items.move.test.js's
// equivalent test for the item path).

test('cross-property move calls Reconcile.auditMove only AFTER the transaction has resolved', async () => {
  const order = [];
  const db = txDb([
    [LOCK, (sql, params) => params.map((id) => ({ ID: id }))],
    [CYCLE, []],
    [PARENT_AREA, [{ AREA_ID: 7 }]],
    [GET_BY_ID, [{ ID: 5, NAME: 'Bin', AREA_ID: 7 }]],
  ]);
  const origWithTransaction = db.withTransaction;
  db.withTransaction = async (fn) => {
    const result = await origWithTransaction(fn);
    order.push('tx-resolved');
    return result;
  };
  Containers.init({ db, logger: noop });

  const origMovingSet = Reconcile.movingSet;
  const origReconcile = Reconcile.reconcile;
  const origAuditMove = Reconcile.auditMove;
  Reconcile.movingSet = async () => ({ containerIds: [5], itemIds: [] });
  Reconcile.reconcile = async () => ({ unlinked: [], tagsCarried: 0, tagsCreated: 0 });
  Reconcile.auditMove = async () => { order.push('auditMove-called'); };

  try {
    await Containers.move(5, 3, undefined, 42, { crossProperty: { srcPropertyId: 1, destPropertyId: 2 } });
    assert.deepEqual(order, ['tx-resolved', 'auditMove-called'],
      'auditMove is called strictly after withTransaction resolves, never from inside it');
  } finally {
    Reconcile.movingSet = origMovingSet;
    Reconcile.reconcile = origReconcile;
    Reconcile.auditMove = origAuditMove;
  }
});

// ── Cross-property: movingSet walks the closure table; payload covers the
//    whole subtree, not just the root ────────────────────────────────────

test('cross-property move: movingSet is computed from the closure table and the consequence payload covers subtree items, not just the root', async () => {
  const db = txDb([
    // moveNode's own subtree read AND movingSet's closure walk share this
    // exact query shape — both legitimately ask "what's in this subtree?"
    [/SELECT DESCENDANT_ID FROM TALLY\.container_paths WHERE ANCESTOR_ID = \?/, [{ DESCENDANT_ID: 5 }, { DESCENDANT_ID: 9 }]],
    // item 101 lives in the root container (5), item 201 in the CHILD
    // container (9) — proving the subtree, not just the root, is collected.
    [/FROM TALLY\.items\s+WHERE CONTAINER_ID IN/, [{ ID: 101 }, { ID: 201 }]],
    [/FROM TALLY\.tags t[\s\S]*entity_tags/, []],
    [/SELECT.*FROM TALLY\.item_accessories/, [{ ID: 900, ITEM_ID: 201, ACCESSORY_ID: 555 }]],
    [/FROM TALLY\.items WHERE ID IN/, [{ ID: 555, NAME: 'Spare cable' }]],
    [/DELETE FROM TALLY\.item_accessories/, { affectedRows: 1 }],
    [GET_BY_ID, [{ ID: 5, NAME: 'Bin', AREA_ID: 7 }]],
  ]);
  Containers.init({ db, logger: noop });

  const out = await Containers.move(5, null, undefined, 42, {
    crossProperty: { srcPropertyId: 1, destPropertyId: 2 },
  });

  assert.deepEqual(
    out.consequences.unlinked,
    [{ itemId: 555, name: 'Spare cable' }],
    "the half-out accessory belongs to item 201 (in child container 9), not the root's own item — the whole subtree was reconciled"
  );
  assert.equal(out.consequences.tagsCarried, 0);
});

// ── #214: a recycled item inside the moved tote reconciles tags too ─────────
// Soft-deleted items physically travel with the container. Before this fix,
// movingSet dropped them entirely, so their entity_tags rows kept pointing at
// SOURCE-property tags — and restoring one later produced an item in property
// B wearing property-A tags, the state the tags routes forbid at attach time.
// The traveller's tags now get the live-item treatment (find-or-create in the
// destination, repoint the row) INSIDE the move's own transaction, while the
// visible consequence numbers stay live-only, exactly what the preview showed.

test('#214: a soft-deleted item in a moved tote gets its entity_tags repointed to destination tags, inside the move transaction, without touching the visible counts', async () => {
  const db = txDb([
    [/SELECT DESCENDANT_ID FROM TALLY\.container_paths WHERE ANCESTOR_ID = \?/, [{ DESCENDANT_ID: 5 }]],
    // One LIVE item (101, untagged) and one RECYCLED item (103) in the tote.
    [/FROM TALLY\.items\s+WHERE CONTAINER_ID IN/, [
      { ID: 101 },
      { ID: 103, DELETED_AT: '2026-08-01 00:00:00' },
    ]],
    // The only attachment in the subtree belongs to the RECYCLED item.
    [/FROM TALLY\.tags t[\s\S]*entity_tags/, [
      { TAG_ID: 7, NAME: 'Xmas', ENTITY_TYPE: 'item', ENTITY_ID: 103 },
    ]],
    [/FROM TALLY\.tags WHERE PROPERTY_ID/, []], // destination has no such tag
    [/INSERT INTO TALLY\.tags/, { insertId: 41 }],
    [/UPDATE TALLY\.entity_tags/, { affectedRows: 1 }],
    [/SELECT.*FROM TALLY\.item_accessories/, []],
    [GET_BY_ID, [{ ID: 5, NAME: 'Tote', AREA_ID: 7 }]],
  ]);
  Containers.init({ db, logger: noop });

  const out = await Containers.move(5, null, undefined, 42, {
    crossProperty: { srcPropertyId: 1, destPropertyId: 2 },
  });

  const created = db.calls.find((c) => /INSERT INTO TALLY\.tags/.test(c.sql));
  assert.ok(created, "the recycled traveller's tag name is find-or-created in the destination");
  assert.equal(created.tx, db.lastTx, 'created INSIDE the move transaction, not on the pool');
  assert.ok(created.params.includes('Xmas') && created.params.includes(2),
    'created by name, in the DESTINATION property');

  const repointed = db.calls.find((c) => /UPDATE TALLY\.entity_tags/.test(c.sql));
  assert.ok(repointed, "the recycled traveller's attachment row is repointed — the live-item treatment");
  assert.equal(repointed.tx, db.lastTx, 'repointed INSIDE the move transaction, not on the pool');
  assert.deepEqual(repointed.params, [41, 7, 'item', 103],
    'source tag 7 on recycled item 103 now points at destination tag 41');

  assert.deepEqual(out.consequences, { unlinked: [], tagsCarried: 0, tagsCreated: 0 },
    'the visible numbers stay live-only — a recycled traveller reconciles silently');
});

// ── Route: destination-property membership gate fires BEFORE any preview ───

// Fake app that records route registrations, extracts the final handler for
// the /move route, and calls it directly with a crafted req/res — same idiom
// as containers.tree.test.js's "tree route is registered before :containerId"
// test, extended to actually invoke the handler.
function registerRoutes(db) {
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

function moveHandler(routes) {
  const r = routes.find((r) => r.method === 'PATCH' && r.path === '/api/containers/_p_/:containerId/move');
  const handlers = r.handlers;
  return handlers[handlers.length - 1]; // the route's own async (req, res) => {...}, past requireAuth/resolveProperty*/requireRole
}

function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('route: destination area in another property — 403 without destination membership, proceeds with editor membership', async () => {
  let memberRows = [];
  const db = {
    query: async (sql) => {
      if (/SELECT PROPERTY_ID FROM TALLY\.areas WHERE ID = \?/.test(sql)) return [{ PROPERTY_ID: 2 }];
      if (/SELECT ROLE FROM TALLY\.property_members/.test(sql)) return memberRows;
      // The route's own liveness pre-check (destination area still live),
      // now run BEFORE the preview/confirm gate — see the "editor
      // membership" branch below, which reaches it.
      if (/SELECT ID FROM TALLY\.areas WHERE ID = \? AND DELETED_AT IS NULL/.test(sql)) return [{ ID: 99 }];
      return [];
    },
    withTransaction: async (fn) => fn({ query: async () => [] }),
  };
  AreasService.init({ db, logger: noop });

  const handler = moveHandler(registerRoutes(db));
  const baseReq = {
    params: { containerId: 5, propertyId: 1 }, // srcPropertyId as resolved by the (bypassed) middleware
    user: { id: 42 },
  };

  // No membership at the destination property → 403, and the preview must
  // never run first (it would leak the destination's shape to a non-member).
  memberRows = [];
  const origMovingSet = Reconcile.movingSet;
  Reconcile.movingSet = async () => { throw new Error('preview must not run before the 403 gate'); };
  try {
    const res = mockRes();
    await handler({ ...baseReq, body: { parentContainerId: null, areaId: 99 } }, res);
    assert.equal(res.statusCode, 403);
    assert.match(res.body.message, /editor access to the destination property/);
  } finally {
    Reconcile.movingSet = origMovingSet;
  }

  // Editor membership at the destination → past the gate, move is reached.
  memberRows = [{ ROLE: 'editor' }];
  const origMove = Containers.move;
  let moveArgs = null;
  Containers.move = async (...args) => { moveArgs = args; return { container: { id: 5 }, consequences: null }; };
  try {
    const res = mockRes();
    // confirm:true sidesteps the preview branch — that gate is covered separately below.
    await handler({ ...baseReq, body: { parentContainerId: null, areaId: 99, confirm: true } }, res);
    assert.equal(res.statusCode, 200);
    assert.ok(moveArgs, 'ContainersService.move was reached');
    assert.deepEqual(moveArgs[4], { crossProperty: { srcPropertyId: 1, destPropertyId: 2 } });
  } finally {
    Containers.move = origMove;
  }
});

// ── Route: unconfirmed lossy move is 409; confirm:true proceeds ────────────

test('route: unconfirmed lossy cross-property move is 409 with the consequence payload; confirm:true proceeds to 200', async () => {
  const db = {
    query: async (sql) => {
      if (/SELECT PROPERTY_ID FROM TALLY\.areas WHERE ID = \?/.test(sql)) return [{ PROPERTY_ID: 2 }];
      if (/SELECT ROLE FROM TALLY\.property_members/.test(sql)) return [{ ROLE: 'editor' }];
      // The route's liveness pre-check — must pass so the test actually
      // exercises the preview/confirm gate that follows it, not a 404.
      if (/SELECT ID FROM TALLY\.areas WHERE ID = \? AND DELETED_AT IS NULL/.test(sql)) return [{ ID: 99 }];
      return [];
    },
    withTransaction: async (fn) => fn({ query: async () => [] }),
  };
  AreasService.init({ db, logger: noop });

  const handler = moveHandler(registerRoutes(db));
  const req = {
    params: { containerId: 5, propertyId: 1 },
    body: { parentContainerId: null, areaId: 99 },
    user: { id: 42 },
  };

  const canned = { unlinked: [{ itemId: 9, name: 'Charger' }], tagsCarried: 1, tagsCreated: 0 };
  const origMovingSet = Reconcile.movingSet;
  const origPreview = Reconcile.previewConsequences;
  Reconcile.movingSet = async () => ({ containerIds: [5], itemIds: [9] });
  Reconcile.previewConsequences = async () => canned;

  const origMove = Containers.move;
  let moveCalled = false;
  Containers.move = async () => { moveCalled = true; return { container: { id: 5 }, consequences: canned }; };

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
    Containers.move = origMove;
  }
});

// ── Route: destination liveness is checked BEFORE the preview/confirm gate ─
// Fix round 2 finding: the preview used to run (and could 409) before the
// destination's liveness was checked, so confirming a lossy move could still
// dead-end in a 404 the caller had no way to see coming. Liveness now runs
// right after the 403 gate, before the preview ever fires.

test('route: a recycled destination area 404s before the preview ever runs', async () => {
  const db = {
    query: async (sql) => {
      if (/SELECT PROPERTY_ID FROM TALLY\.areas WHERE ID = \?/.test(sql)) return [{ PROPERTY_ID: 2 }];
      if (/SELECT ROLE FROM TALLY\.property_members/.test(sql)) return [{ ROLE: 'editor' }];
      // No row: the destination area is gone (soft-deleted or never existed).
      if (/SELECT ID FROM TALLY\.areas WHERE ID = \? AND DELETED_AT IS NULL/.test(sql)) return [];
      return [];
    },
    withTransaction: async (fn) => fn({ query: async () => [] }),
  };
  AreasService.init({ db, logger: noop });

  const handler = moveHandler(registerRoutes(db));
  const req = {
    params: { containerId: 5, propertyId: 1 },
    body: { parentContainerId: null, areaId: 99 },
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

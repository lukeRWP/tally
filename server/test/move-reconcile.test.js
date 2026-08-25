const test = require('node:test');
const assert = require('node:assert');
const Reconcile = require('../src/modules/inventory/move-reconcile.service');
const AuditService = require('../src/modules/audit/audit.service');

// Initialize AuditService with no-op logger to prevent errors in tests that don't explicitly mock it
const noop = { warn() {}, info() {}, error() {} };
AuditService.init({ db: { query: async () => [] }, logger: noop });

// Scriptable tx: routes each query by regex to a canned result and records all.
function fakeTx(routes) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      for (const [re, result] of routes) if (re.test(sql)) return typeof result === 'function' ? result(sql, params) : result;
      return [];
    },
  };
}

test('movingSet for an item is just that item', async () => {
  const tx = fakeTx([]);
  const set = await Reconcile.movingSet(tx, 'item', 7);
  assert.deepEqual(set, { containerIds: [], itemIds: [7] });
  assert.equal(tx.calls.length, 0, 'no queries needed for a single item');
});

test('movingSet for a container walks the closure table and collects items', async () => {
  const tx = fakeTx([
    [/container_paths/, [{ DESCENDANT_ID: 3 }, { DESCENDANT_ID: 9 }, { DESCENDANT_ID: 12 }]],
    [/FROM TALLY\.items/, [{ ID: 101 }, { ID: 102 }]],
  ]);
  const set = await Reconcile.movingSet(tx, 'container', 3);
  assert.deepEqual(set.containerIds, [3, 9, 12], 'root included via closure DEPTH 0 row');
  assert.deepEqual(set.itemIds, [101, 102]);
  const itemsQ = tx.calls.find((c) => /FROM TALLY\.items/.test(c.sql));
  assert.match(itemsQ.sql, /CONTAINER_ID IN/, 'items looked up across the whole subtree');
  assert.match(itemsQ.sql, /DELETED_AT IS NULL/, 'recycled items do not travel');
});

test('carrying tags matches by name case-insensitively and creates the rest', async () => {
  const writes = [];
  const tx = fakeTx([
    // Tags attached to the moving set (two entities share "Fragile")
    [/FROM TALLY\.tags t[\s\S]*entity_tags/, [
      { TAG_ID: 1, NAME: 'Fragile', ENTITY_TYPE: 'item', ENTITY_ID: 101 },
      { TAG_ID: 1, NAME: 'Fragile', ENTITY_TYPE: 'item', ENTITY_ID: 102 },
      { TAG_ID: 2, NAME: 'Tools',   ENTITY_TYPE: 'container', ENTITY_ID: 3 },
    ]],
    // Destination property already has a "fragile" (different case)
    [/FROM TALLY\.tags WHERE PROPERTY_ID/, [{ ID: 40, NAME: 'fragile' }]],
    [/INSERT INTO TALLY\.tags/, (sql, params) => { writes.push({ sql, params }); return { insertId: 41 }; }],
    [/UPDATE TALLY\.entity_tags/, (sql, params) => { writes.push({ sql, params }); return { affectedRows: 1 }; }],
  ]);
  const out = await Reconcile.reconcile(tx,
    { containerIds: [3], itemIds: [101, 102] },
    { srcPropertyId: 1, destPropertyId: 2, userId: 42, rootType: 'container', rootId: 3, moveChanges: {} });
  assert.equal(out.tagsCarried, 2, 'DISTINCT tags carried (Fragile + Tools), not the 3 attachment rows repointed');
  assert.equal(out.tagsCreated, 1, 'only Tools is created; fragile matched case-insensitively');
  const created = writes.find((w) => /INSERT INTO TALLY\.tags/.test(w.sql));
  assert.ok(created.params.includes('Tools'));
  assert.ok(created.params.includes(2), 'created in the DESTINATION property');
});

test('accessory links survive intra-set and break half-out, reported by name', async () => {
  const writes = [];
  const tx = fakeTx([
    [/FROM TALLY\.tags t[\s\S]*entity_tags/, []],
    [/SELECT.*FROM TALLY\.item_accessories/, [
      { ID: 900, ITEM_ID: 101, ACCESSORY_ID: 102 },   // both moving → survives
      { ID: 901, ITEM_ID: 101, ACCESSORY_ID: 555 },   // 555 stays → breaks
      { ID: 902, ITEM_ID: 777, ACCESSORY_ID: 102 },   // 777 stays → breaks
    ]],
    [/FROM TALLY\.items WHERE ID IN/, [{ ID: 555, NAME: 'Battery pack' }, { ID: 777, NAME: 'Charger' }]],
    [/DELETE FROM TALLY\.item_accessories/, (sql, params) => { writes.push({ sql, params }); return { affectedRows: 2 }; }],
  ]);
  const out = await Reconcile.reconcile(tx,
    { containerIds: [], itemIds: [101, 102] },
    { srcPropertyId: 1, destPropertyId: 2, userId: 42, rootType: 'item', rootId: 101, moveChanges: {} });
  assert.equal(out.unlinked.length, 2);
  assert.deepEqual(out.unlinked.map((u) => u.name).sort(), ['Battery pack', 'Charger']);
  const del = writes.find((w) => /DELETE FROM TALLY\.item_accessories/.test(w.sql));
  assert.deepEqual(del.params.sort(), [901, 902], 'deletes exactly the half-out links by ID');
});

// ── Fix round 2: `staying()` dedupes by outside item, not by link row ──────

test('two moving items linked to the same outside item report it ONCE, not twice', async () => {
  const tx = fakeTx([
    [/FROM TALLY\.tags t[\s\S]*entity_tags/, []],
    [/SELECT.*FROM TALLY\.item_accessories/, [
      { ID: 900, ITEM_ID: 101, ACCESSORY_ID: 555 },   // both link to the same
      { ID: 901, ITEM_ID: 102, ACCESSORY_ID: 555 },   // outside item, 555
    ]],
    [/FROM TALLY\.items WHERE ID IN/, [{ ID: 555, NAME: 'Shared charger' }]],
    [/DELETE FROM TALLY\.item_accessories/, () => ({ affectedRows: 2 })],
  ]);
  const out = await Reconcile.reconcile(tx,
    { containerIds: [], itemIds: [101, 102] },
    { srcPropertyId: 1, destPropertyId: 2, userId: 42, rootType: 'item', rootId: 101, moveChanges: {} });
  assert.deepEqual(out.unlinked, [{ itemId: 555, name: 'Shared charger' }],
    'one row for the outside item, not one per link that broke');
});

// ── Fix round 2: movingSet guards the items IN () query on an empty subtree ─

test('movingSet returns an empty item set without querying IN () when the closure walk finds no containers', async () => {
  const tx = fakeTx([
    [/container_paths/, []],
    // If the guard were missing, this would run as `IN ()` — invalid SQL.
    // Routed to throw so the test fails loudly if that query ever fires.
    [/FROM TALLY\.items/, () => { throw new Error('items IN () must not be queried for an empty container set'); }],
  ]);
  const set = await Reconcile.movingSet(tx, 'container', 3);
  assert.deepEqual(set, { containerIds: [], itemIds: [] });
});

// ── reconcile() is data-only — no audit rides the transaction ──────────────
// Fix round 1 finding: logChange writes through AuditService's module-global
// _db.query, a plain pool connection, NOT the caller's tx. Writing it inside
// reconcile() let an audit row commit durably mid-transaction, so a rollback
// left audit rows describing a move that never happened. reconcile() now
// only touches tags/accessories; auditing moved to the auditMove() export
// below, for callers to invoke themselves once their transaction resolves.

test('reconcile touches only tags/accessories — it never calls logChange itself', async () => {
  const AuditService = require('../src/modules/audit/audit.service');
  const orig = AuditService.logChange;
  let called = false;
  AuditService.logChange = async () => { called = true; };
  try {
    const tx = fakeTx([[/entity_tags/, []], [/item_accessories/, []]]);
    const out = await Reconcile.reconcile(tx, { containerIds: [], itemIds: [7] },
      { srcPropertyId: 1, destPropertyId: 2, userId: 42, rootType: 'item', rootId: 7,
        moveChanges: { containerId: 30 } });
    assert.equal(called, false, 'reconcile() must not audit — that would write outside the caller\'s tx');
    assert.ok(out, 'the consequence payload is still returned');
  } finally { AuditService.logChange = orig; }
});

// ── auditMove — the two audit rows a cross-property move writes ────────────

test('auditMove writes to BOTH properties, once per root', async () => {
  const audits = [];
  const AuditService = require('../src/modules/audit/audit.service');
  const orig = AuditService.logChange;
  AuditService.logChange = async (...args) => { audits.push(args); };
  try {
    await Reconcile.auditMove({
      srcPropertyId: 1, destPropertyId: 2, userId: 42, rootType: 'item', rootId: 7,
      moveChanges: { containerId: 30 },
    });
    assert.equal(audits.length, 2);
    const [out_, in_] = audits;
    assert.equal(out_[3], 'moved-out'); assert.equal(out_[5], 1);
    assert.equal(in_[3], 'moved-in');   assert.equal(in_[5], 2);
  } finally { AuditService.logChange = orig; }
});

// ── needsConfirm — pure function, unit-tested directly ──────────────────────
// Moved from items.move.test.js when needsConfirm moved into this module
// (Task 3): it is shared by both the item and container move routes now, so
// it belongs beside reconcile/previewConsequences rather than in one route file.

test('needsConfirm requires explicit confirm only when accessories would be unlinked', () => {
  assert.equal(typeof Reconcile.needsConfirm, 'function', 'move-reconcile.service.js exports needsConfirm');
  assert.equal(Reconcile.needsConfirm({ unlinked: [{ itemId: 1, name: 'Charger' }] }, false), true,
    'a lossy move without confirm needs one');
  assert.equal(Reconcile.needsConfirm({ unlinked: [{ itemId: 1, name: 'Charger' }] }, true), false,
    'confirm:true clears the gate even when lossy');
  assert.equal(Reconcile.needsConfirm({ unlinked: [] }, false), false,
    'a clean move never needs confirm');
});

test('previewConsequences issues no writes', async () => {
  const tx = fakeTx([
    [/entity_tags/, [{ TAG_ID: 2, NAME: 'Tools', ENTITY_TYPE: 'item', ENTITY_ID: 7 }]],
    [/FROM TALLY\.tags WHERE PROPERTY_ID/, []],
    [/item_accessories/, []],
  ]);
  const out = await Reconcile.previewConsequences(tx, { containerIds: [], itemIds: [7] }, 2);
  assert.equal(out.tagsCreated, 1, 'reports what WOULD be created');
  assert.ok(!tx.calls.some((c) => /INSERT|UPDATE|DELETE/i.test(c.sql)), 'read-only');
});

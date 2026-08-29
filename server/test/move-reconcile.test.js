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
  assert.deepEqual(set, { containerIds: [], itemIds: [7], deletedItemIds: [] });
  assert.equal(tx.calls.length, 0, 'no queries needed for a single item');
});

test('movingSet for a container walks the closure table and collects items, partitioning recycled travellers out of the live set', async () => {
  const tx = fakeTx([
    [/container_paths/, [{ DESCENDANT_ID: 3 }, { DESCENDANT_ID: 9 }, { DESCENDANT_ID: 12 }]],
    [/FROM TALLY\.items/, [{ ID: 101 }, { ID: 102 }, { ID: 103, DELETED_AT: '2026-08-01 00:00:00' }]],
  ]);
  const set = await Reconcile.movingSet(tx, 'container', 3);
  assert.deepEqual(set.containerIds, [3, 9, 12], 'root included via closure DEPTH 0 row');
  assert.deepEqual(set.itemIds, [101, 102], 'the LIVE set — counts/consequences/link-breakage read only this');
  assert.deepEqual(set.deletedItemIds, [103],
    'recycled items travel with the subtree, but only as deletedItemIds — never in the live set');
  const itemsQ = tx.calls.find((c) => /FROM TALLY\.items/.test(c.sql));
  assert.match(itemsQ.sql, /CONTAINER_ID IN/, 'items looked up across the whole subtree');
  assert.ok(!/DELETED_AT IS NULL/.test(itemsQ.sql),
    'the lookup no longer drops recycled rows in SQL — they are partitioned, not ignored (#214)');
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

// ── #244: destination tag find-or-create converges on ER_DUP_ENTRY ─────────
// Two concurrent moves carrying the same new tag name race
// uq_tags_name_property; the loser's bare INSERT used to 500 the whole move.
// It must instead adopt the winner's row — via a LOCKING re-select, because
// under REPEATABLE READ a plain SELECT inside this tx would replay the
// pre-collision snapshot and still see no row.

test('a tag INSERT losing the unique-key race re-selects the winner and the move completes', async () => {
  const dup = () => { const e = new Error('Duplicate entry'); e.code = 'ER_DUP_ENTRY'; throw e; };
  const repoints = [];
  const tx = fakeTx([
    [/FROM TALLY\.tags t[\s\S]*entity_tags/, [
      { TAG_ID: 2, NAME: 'Tools', ENTITY_TYPE: 'item', ENTITY_ID: 101 },
    ]],
    [/FROM TALLY\.tags WHERE PROPERTY_ID/, []],           // dest had no tags at plan time
    [/INSERT INTO TALLY\.tags/, dup],                     // ...but a concurrent move won the INSERT
    [/SELECT ID FROM TALLY\.tags WHERE NAME/, [{ ID: 77 }]],
    [/UPDATE TALLY\.entity_tags/, (sql, params) => { repoints.push(params); return { affectedRows: 1 }; }],
    [/item_accessories/, []],
  ]);
  const out = await Reconcile.reconcile(tx,
    { containerIds: [], itemIds: [101] },
    { srcPropertyId: 1, destPropertyId: 2, userId: 42, rootType: 'item', rootId: 101, moveChanges: {} });

  const reselect = tx.calls.find((c) => /SELECT ID FROM TALLY\.tags WHERE NAME/.test(c.sql));
  assert.ok(reselect, 'the loser re-selects the winner instead of throwing');
  assert.match(reselect.sql, /FOR SHARE/,
    'the re-select is a locking read — a snapshot read cannot see the winner under REPEATABLE READ');
  assert.deepEqual(reselect.params, ['Tools', 2], 'looked up by name in the DESTINATION property');
  assert.equal(repoints[0][0], 77, 'the attachment is repointed to the WINNER\'S tag id');
  assert.deepEqual(out, { unlinked: [], tagsCarried: 1, tagsCreated: 1 }, 'the move completes — no throw');
});

test('a non-duplicate tag INSERT failure still fails the move', async () => {
  const tx = fakeTx([
    [/FROM TALLY\.tags t[\s\S]*entity_tags/, [
      { TAG_ID: 2, NAME: 'Tools', ENTITY_TYPE: 'item', ENTITY_ID: 101 },
    ]],
    [/FROM TALLY\.tags WHERE PROPERTY_ID/, []],
    [/INSERT INTO TALLY\.tags/, () => { const e = new Error('deadlock'); e.code = 'ER_LOCK_DEADLOCK'; throw e; }],
    [/SELECT ID FROM TALLY\.tags WHERE NAME/, () => { throw new Error('must not re-select on a non-duplicate error'); }],
  ]);
  await assert.rejects(
    () => Reconcile.reconcile(tx, { containerIds: [], itemIds: [101] },
      { srcPropertyId: 1, destPropertyId: 2, userId: 42, rootType: 'item', rootId: 101, moveChanges: {} }),
    (e) => e.code === 'ER_LOCK_DEADLOCK'
  );
});

test('ER_DUP_ENTRY with no row on re-select surfaces the original error', async () => {
  const tx = fakeTx([
    [/FROM TALLY\.tags t[\s\S]*entity_tags/, [
      { TAG_ID: 2, NAME: 'Tools', ENTITY_TYPE: 'item', ENTITY_ID: 101 },
    ]],
    [/FROM TALLY\.tags WHERE PROPERTY_ID/, []],
    [/INSERT INTO TALLY\.tags/, () => { const e = new Error('Duplicate entry'); e.code = 'ER_DUP_ENTRY'; throw e; }],
    [/SELECT ID FROM TALLY\.tags WHERE NAME/, []], // collided yet absent — should be impossible
  ]);
  await assert.rejects(
    () => Reconcile.reconcile(tx, { containerIds: [], itemIds: [101] },
      { srcPropertyId: 1, destPropertyId: 2, userId: 42, rootType: 'item', rootId: 101, moveChanges: {} }),
    (e) => e.code === 'ER_DUP_ENTRY'
  );
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

// ── #214: soft-deleted travellers reconcile tags with the live treatment ────
// A recycled item physically rides the moved subtree. Its entity_tags rows
// must be remapped exactly like a live item's (find-or-create in the
// destination, repoint the attachment) or a later restore resurrects an item
// in property B wearing property-A tags — the state the tags routes forbid at
// attach time. The REPORTED counts stay live-only: recycled items appear in
// no consequence surface, so their carry (even a created tag) is silent.

test('#214: a recycled traveller\'s tags are remapped like a live item\'s, but stay out of the reported counts', async () => {
  const inserts = [];
  const updates = [];
  let attachedParams = null;
  let nextTagId = 41;
  const tx = fakeTx([
    [/FROM TALLY\.tags t[\s\S]*entity_tags/, (sql, params) => {
      attachedParams = params;
      return [
        { TAG_ID: 1, NAME: 'Fragile', ENTITY_TYPE: 'item', ENTITY_ID: 101 }, // live traveller
        { TAG_ID: 7, NAME: 'Xmas',    ENTITY_TYPE: 'item', ENTITY_ID: 103 }, // RECYCLED traveller
      ];
    }],
    [/FROM TALLY\.tags WHERE PROPERTY_ID/, []], // destination has neither tag
    [/INSERT INTO TALLY\.tags/, (sql, params) => { inserts.push(params); return { insertId: nextTagId++ }; }],
    [/UPDATE TALLY\.entity_tags/, (sql, params) => { updates.push(params); return { affectedRows: 1 }; }],
    [/item_accessories/, []],
  ]);

  const out = await Reconcile.reconcile(tx,
    { containerIds: [3], itemIds: [101], deletedItemIds: [103] },
    { srcPropertyId: 1, destPropertyId: 2, userId: 42, rootType: 'container', rootId: 3, moveChanges: {} });

  assert.ok(attachedParams.includes(103),
    'the attachment read covers the recycled traveller — its rows are part of the remap');

  assert.equal(inserts.length, 2, 'both missing names are created in the destination');
  assert.ok(inserts.every((p) => p.includes(2)), 'created in the DESTINATION property');
  const xmasDestId = 41 + inserts.findIndex((p) => p.includes('Xmas'));
  const repointed = updates.find((p) => p[3] === 103);
  assert.deepEqual(repointed, [xmasDestId, 7, 'item', 103],
    'the recycled traveller\'s attachment row is repointed to the destination tag — the live treatment');

  assert.equal(out.tagsCarried, 1, 'reported carry counts the LIVE attachment only (Fragile)');
  assert.equal(out.tagsCreated, 1,
    'Xmas (recycled-only) was created for the remap but reconciles silently — the visible number matches the preview');
});

// ── #214 sibling (cosmetic): recycled items never render in the sheet ───────
// The link to a recycled staying-end still BREAKS — leaving it would strand a
// cross-property accessory link for a later restore to reactivate — but its
// name never renders as a consequence, and a move whose only breakage points
// at recycled items no longer demands a confirm.

test('#214: a recycled staying-end is out of the consequence sheet, but its half-out link still breaks', async () => {
  const deletes = [];
  const routes = [
    [/FROM TALLY\.tags t[\s\S]*entity_tags/, []],
    [/SELECT.*FROM TALLY\.item_accessories/, [
      { ID: 901, ITEM_ID: 101, ACCESSORY_ID: 555 },   // 555 stays and is RECYCLED
      { ID: 902, ITEM_ID: 102, ACCESSORY_ID: 777 },   // 777 stays and is live
    ]],
    [/FROM TALLY\.items WHERE ID IN/, [
      { ID: 555, NAME: 'Binned charger', DELETED_AT: '2026-08-01 00:00:00' },
      { ID: 777, NAME: 'Charger' },
    ]],
    [/DELETE FROM TALLY\.item_accessories/, (sql, params) => { deletes.push(params); return { affectedRows: 2 }; }],
  ];

  // No deletedItemIds field at all — older stub/caller shapes must keep working.
  const out = await Reconcile.reconcile(fakeTx(routes),
    { containerIds: [], itemIds: [101, 102] },
    { srcPropertyId: 1, destPropertyId: 2, userId: 42, rootType: 'item', rootId: 101, moveChanges: {} });

  assert.deepEqual(out.unlinked, [{ itemId: 777, name: 'Charger' }],
    'only the LIVE staying-end renders — the recycled one never appears in the sheet');
  assert.deepEqual(deletes[0].sort(), [901, 902],
    'BOTH half-out links still break — the filter is cosmetic, not a change to breakage');

  // And the preview agrees, so a recycled-only breakage no longer trips the 409 gate.
  const preview = await Reconcile.previewConsequences(
    fakeTx([
      [/FROM TALLY\.tags t[\s\S]*entity_tags/, []],
      [/SELECT.*FROM TALLY\.item_accessories/, [{ ID: 901, ITEM_ID: 101, ACCESSORY_ID: 555 }]],
      [/FROM TALLY\.items WHERE ID IN/, [{ ID: 555, NAME: 'Binned charger', DELETED_AT: '2026-08-01 00:00:00' }]],
    ]),
    { containerIds: [], itemIds: [101, 102] }, 2);
  assert.deepEqual(preview.unlinked, []);
  assert.equal(Reconcile.needsConfirm(preview, false), false,
    'no confirm demanded when the only broken links point at recycled items');
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
  assert.deepEqual(set, { containerIds: [], itemIds: [], deletedItemIds: [] });
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

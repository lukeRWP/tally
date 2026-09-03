const test = require('node:test');
const assert = require('node:assert');
const Recycle = require('../src/modules/recycle/recycle.service');
const Audit = require('../src/modules/audit/audit.service');

const noop = { warn() {}, info() {}, error() {} };

function harness(handlers = {}) {
  const sqls = [];
  const params = [];
  const query = async (sql, args) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    sqls.push(flat);
    params.push(args);
    for (const [pattern, value] of Object.entries(handlers)) {
      // A function handler sees the bind params and may vary per call.
      if (new RegExp(pattern, 'i').test(flat)) return typeof value === 'function' ? value(args) : value;
    }
    return [];
  };
  const db = { query, withTransaction: async (fn) => fn({ query }) };
  Audit.init({ db: { query: async () => [] }, logger: noop });
  Recycle.init({ db, logger: noop });
  return { sqls, params, db };
}

/**
 * THE property this whole design exists for. The cascades guard with
 * `DELETED_AT IS NULL`, so a deleted subtree mixes rows from different delete
 * operations. Restore must therefore be scoped by batch id and nothing else —
 * never by "everything under this root", which would resurrect a child bin the
 * user deleted separately weeks earlier.
 */
test('restore is scoped strictly by batch id, never by subtree', async () => {
  const { sqls, params } = harness({
    'FROM TALLY\\.delete_batches b': [
      { ID: 7, PROPERTY_ID: 3, ROOT_TYPE: 'container', ROOT_ID: 55, ROOT_NAME: 'Bin A', ROLE: 'owner' },
    ],
    'FROM TALLY\\.containers c JOIN TALLY\\.areas a': [
      { PARENT_CONTAINER_ID: null, AREA_DELETED: null, PROP_DELETED: null, PARENT_DELETED: null },
    ],
  });

  await Recycle.restore(7, 42);

  const undeletes = sqls.filter((s) => /SET DELETED_AT = NULL|DELETED_AT = NULL, STATUS/i.test(s));
  assert.equal(undeletes.length, 3, 'areas, containers and items are each un-deleted');
  for (const sql of undeletes) {
    assert.match(sql, /WHERE DELETE_BATCH_ID = \?/i,
      'every un-delete is scoped by batch id, not by closure/subtree');
    assert.ok(!/container_paths|ANCESTOR_ID/i.test(sql),
      'restore must not walk the subtree — that would over-restore');
  }
  // Every un-delete also clears the stamp, or a row could be restored twice.
  for (const sql of undeletes) {
    assert.match(sql, /DELETE_BATCH_ID = NULL/i, 'the stamp is cleared on restore');
  }
  assert.ok(
    sqls.some((s) => /DELETE FROM TALLY\.delete_batches WHERE ID = \?/i.test(s)),
    'the header is dropped once its members are back',
  );
  assert.ok(params.every((a) => !a || a.every((v) => v !== undefined)),
    'no undefined bind parameters');
});

test('restore refuses a container whose area is still deleted', async () => {
  const { sqls } = harness({
    'FROM TALLY\\.delete_batches b': [
      { ID: 8, PROPERTY_ID: 3, ROOT_TYPE: 'container', ROOT_ID: 55, ROOT_NAME: 'Bin A', ROLE: 'owner' },
    ],
    'FROM TALLY\\.containers c JOIN TALLY\\.areas a': [
      { PARENT_CONTAINER_ID: null, AREA_DELETED: '2026-08-01', PROP_DELETED: null, PARENT_DELETED: null },
    ],
  });

  await assert.rejects(
    () => Recycle.restore(8, 42),
    (err) => err.statusCode === 409 && /area/i.test(err.message),
    'refuses with 409 and names the ancestor to restore first',
  );
  assert.ok(!sqls.some((s) => /SET DELETED_AT = NULL/i.test(s)),
    'nothing is un-deleted when the restore is refused');
});

test('restore refuses a nested bin whose parent bin is still deleted', async () => {
  const { sqls } = harness({
    'FROM TALLY\\.delete_batches b': [
      { ID: 9, PROPERTY_ID: 3, ROOT_TYPE: 'container', ROOT_ID: 56, ROOT_NAME: 'Inner Box', ROLE: 'owner' },
    ],
    'FROM TALLY\\.containers c JOIN TALLY\\.areas a': [
      { PARENT_CONTAINER_ID: 55, AREA_DELETED: null, PROP_DELETED: null, PARENT_DELETED: '2026-08-01' },
    ],
  });

  await assert.rejects(
    () => Recycle.restore(9, 42),
    (err) => err.statusCode === 409 && /bin/i.test(err.message),
  );
  assert.ok(!sqls.some((s) => /SET DELETED_AT = NULL/i.test(s)));
});

// ── #88: the ancestor-liveness check locks the rows it trusts ───────────────
// _assertAncestorsLive runs inside the restore transaction, but a plain
// SELECT there is still a check-then-write: a concurrent soft-delete of an
// ancestor could commit between the read and the un-delete UPDATEs, bringing
// the batch back under a freshly deleted parent. The check must be a locking
// read (FOR UPDATE) so it serializes with the delete cascades that stamp the
// same rows.

test('restore reads ancestor liveness FOR UPDATE, before any un-delete', async () => {
  const { sqls } = harness({
    'FROM TALLY\\.delete_batches b': [
      { ID: 7, PROPERTY_ID: 3, ROOT_TYPE: 'container', ROOT_ID: 55, ROOT_NAME: 'Bin A', ROLE: 'owner' },
    ],
    'FROM TALLY\\.containers c JOIN TALLY\\.areas a': [
      { PARENT_CONTAINER_ID: null, AREA_DELETED: null, PROP_DELETED: null, PARENT_DELETED: null },
    ],
  });

  await Recycle.restore(7, 42);

  const ancestorIdx = sqls.findIndex((s) => /FROM TALLY\.containers c JOIN TALLY\.areas a/i.test(s));
  const firstUndeleteIdx = sqls.findIndex((s) => /SET DELETED_AT = NULL/i.test(s));
  assert.ok(ancestorIdx >= 0, 'the ancestor-liveness check ran');
  assert.match(sqls[ancestorIdx], /FOR UPDATE/i,
    'the ancestor rows the restore trusts are locked, not merely read');
  assert.ok(ancestorIdx < firstUndeleteIdx, 'checked (and locked) BEFORE anything is un-deleted');
});

test('every root type checks its ancestors with a locking read', async () => {
  // area root → the property row; item root → container/area/property rows.
  for (const [batch, ancestorRe, canned] of [
    [{ ID: 10, PROPERTY_ID: 3, ROOT_TYPE: 'area', ROOT_ID: 4, ROOT_NAME: 'Garage', ROLE: 'owner' },
      /FROM TALLY\.properties WHERE ID = \?/i, { DELETED_AT: null }],
    [{ ID: 11, PROPERTY_ID: 3, ROOT_TYPE: 'item', ROOT_ID: 101, ROOT_NAME: 'Mug', ROLE: 'owner' },
      /FROM TALLY\.items i JOIN TALLY\.containers c/i,
      { CONTAINER_DELETED: null, AREA_DELETED: null, PROP_DELETED: null }],
  ]) {
    const { sqls } = harness({
      'FROM TALLY\\.delete_batches b': [batch],
      'FROM TALLY\\.properties WHERE ID': [canned],
      'FROM TALLY\\.items i JOIN': [canned],
    });
    await Recycle.restore(batch.ID, 42);
    const ancestorSql = sqls.find((s) => ancestorRe.test(s));
    assert.ok(ancestorSql, `the ${batch.ROOT_TYPE}-root ancestor check ran`);
    assert.match(ancestorSql, /FOR UPDATE/i,
      `the ${batch.ROOT_TYPE}-root ancestor check locks the rows it trusts`);
  }
});

test("a batch in someone else's property is 404, not 403", async () => {
  // The membership INNER JOIN returns nothing, so the batch is indistinguishable
  // from one that never existed — it must not leak that it exists.
  const { sqls } = harness({ 'FROM TALLY\\.delete_batches b': [] });

  await assert.rejects(
    () => Recycle.restore(999, 42),
    (err) => err.statusCode === 404,
  );
  assert.match(sqls[0], /JOIN TALLY\.property_members pm/i,
    'the lookup is membership-scoped in SQL, not filtered afterwards');
});

test('the bin list is membership-scoped and windowed to 30 days', async () => {
  const { sqls } = harness();
  await Recycle.list(42);
  assert.match(sqls[0], /JOIN TALLY\.property_members pm ON b\.PROPERTY_ID = pm\.PROPERTY_ID/i);
  assert.match(sqls[0], /pm\.USER_ID = \?/i);
  assert.match(sqls[0], /DATE_SUB\(NOW\(\), INTERVAL 30 DAY\)/i,
    'matches the window the item bin has always used');
});

// ── #347: owner-only restore, enforced retention, lazy purge ─────────────────

test('restore refuses a viewer with 403, and only after finding the batch', async () => {
  const { sqls } = harness({
    'FROM TALLY\\.delete_batches b': [
      { ID: 7, PROPERTY_ID: 3, ROOT_TYPE: 'item', ROOT_ID: 55, ROOT_NAME: 'Lamp', ROLE: 'viewer' },
    ],
  });

  await assert.rejects(
    () => Recycle.restore(7, 42),
    (err) => err.statusCode === 403 && /owner/i.test(err.message),
  );
  assert.ok(!sqls.some((s) => /SET DELETED_AT = NULL/i.test(s)), 'nothing is un-deleted');
  assert.match(sqls[0], /pm\.ROLE/i, 'the role rides the same locked read as the batch');
});

test('an editor cannot restore either — the gate is owner, matching every other delete route', async () => {
  const { sqls } = harness({
    'FROM TALLY\\.delete_batches b': [
      { ID: 7, PROPERTY_ID: 3, ROOT_TYPE: 'item', ROOT_ID: 55, ROOT_NAME: 'Lamp', ROLE: 'editor' },
    ],
  });
  await assert.rejects(() => Recycle.restore(7, 42), (err) => err.statusCode === 403);
  assert.ok(!sqls.some((s) => /SET DELETED_AT = NULL/i.test(s)));
});

test('restore applies the same 30-day window the list does', async () => {
  // The membership join returning nothing is also what an expired batch looks
  // like once the predicate is in the SQL — so it is a 404, same as "not yours".
  const { sqls } = harness({ 'FROM TALLY\\.delete_batches b': [] });
  await assert.rejects(() => Recycle.restore(7, 42), (err) => err.statusCode === 404);
  assert.match(sqls[0], /b\.DELETED_AT > DATE_SUB\(NOW\(\), INTERVAL 30 DAY\)/i,
    'an expired batch is not restorable by id just because the list hides it');
});

test('the list says whether the caller can restore each row', async () => {
  const { sqls } = harness({
    'FROM TALLY\\.delete_batches b': [
      { ID: 1, ROOT_TYPE: 'item', ROOT_ID: 5, ROOT_NAME: 'A', DELETED_AT: '2026-09-01', DAYS_LEFT: 28, ROLE: 'owner' },
      { ID: 2, ROOT_TYPE: 'item', ROOT_ID: 6, ROOT_NAME: 'B', DELETED_AT: '2026-09-01', DAYS_LEFT: 28, ROLE: 'viewer' },
    ],
  });
  const rows = await Recycle.list(42);
  assert.match(sqls[0], /pm\.ROLE/i);
  assert.deepEqual(rows.map((r) => r.canRestore), [true, false]);
});

test('purgeExpired hard-deletes expired batches oldest first, bounded, in FK order', async () => {
  const ItemsService = require('../src/modules/inventory/items.service');
  const purgedItems = [];
  const orig = ItemsService.permanentDelete;
  ItemsService.permanentDelete = async (id) => { purgedItems.push(id); };
  try {
    const { sqls, params } = harness({
      // Legacy orphans (pre-batch rows): none this time.
      'FROM TALLY\\.items i WHERE i\\.DELETED_AT IS NOT NULL': [],
      'SELECT .* FROM TALLY\\.delete_batches WHERE DELETED_AT <': [
        { ID: 9, PROPERTY_ID: 3, ROOT_TYPE: 'area', ROOT_ID: 1, ROOT_NAME: 'Garage' },
      ],
      'FROM TALLY\\.items i WHERE i\\.DELETE_BATCH_ID = \\?': [
        { ID: 101, ON_LOAN: 0 }, { ID: 102, ON_LOAN: 0 },
      ],
      'SELECT ID FROM TALLY\\.containers WHERE DELETE_BATCH_ID': [{ ID: 31 }, { ID: 32 }],
      'SELECT ID FROM TALLY\\.areas WHERE DELETE_BATCH_ID': [{ ID: 1 }],
    });

    const result = await Recycle.purgeExpired();

    assert.deepEqual(result, { items: 0, batches: 1 });
    assert.deepEqual(purgedItems, [101, 102], 'items go through the one real permanentDelete');

    const pick = sqls.find((s) => /FROM TALLY\.delete_batches WHERE DELETED_AT </i.test(s));
    assert.match(pick, /DELETED_AT < DATE_SUB\(NOW\(\), INTERVAL 30 DAY\)/i);
    assert.match(pick, /ORDER BY DELETED_AT ASC LIMIT \?/i, 'oldest first, bounded per sweep');

    // Everything hanging off a container is gone before the container is,
    // and the self-FK is nulled so a nested bin in the same batch cannot
    // block its parent's row.
    const order = sqls.map((s) => s.replace(/\s+/g, ' '));
    const at = (re) => order.findIndex((s) => re.test(s));
    const iTags = at(/DELETE FROM TALLY\.entity_tags WHERE ENTITY_TYPE = 'container'/i);
    const iLinks = at(/DELETE FROM TALLY\.share_links WHERE ENTITY_TYPE = 'container'/i);
    const iPaths = at(/DELETE FROM TALLY\.container_paths WHERE ANCESTOR_ID IN/i);
    const iParent = at(/UPDATE TALLY\.containers SET PARENT_CONTAINER_ID = NULL WHERE DELETE_BATCH_ID/i);
    const iCont = at(/DELETE FROM TALLY\.containers WHERE DELETE_BATCH_ID/i);
    const iATags = at(/DELETE FROM TALLY\.entity_tags WHERE ENTITY_TYPE = 'area'/i);
    const iArea = at(/DELETE FROM TALLY\.areas WHERE DELETE_BATCH_ID/i);
    const iHdr = at(/DELETE FROM TALLY\.delete_batches WHERE ID = \?/i);
    for (const i of [iTags, iLinks, iPaths, iParent, iCont, iATags, iArea, iHdr]) assert.ok(i >= 0, 'every step ran');
    assert.ok(iTags < iCont && iLinks < iCont && iPaths < iCont && iParent < iCont, 'container children first');
    assert.ok(iCont < iArea, 'containers before their areas');
    assert.ok(iATags < iArea, 'area tags before the area');
    assert.ok(iArea < iHdr, 'the header goes last');

    const pathParams = params[iPaths];
    assert.deepEqual(pathParams, [31, 32, 31, 32], 'both closure columns, same id list');
    assert.ok(params.every((a) => !a || a.every((v) => v !== undefined)), 'no undefined bind parameters');
  } finally {
    ItemsService.permanentDelete = orig;
  }
});

test('purgeExpired skips a batch with an open loan inside it, and purges the rest', async () => {
  const ItemsService = require('../src/modules/inventory/items.service');
  const purgedItems = [];
  const orig = ItemsService.permanentDelete;
  ItemsService.permanentDelete = async (id) => { purgedItems.push(id); };
  try {
    const { sqls } = harness({
      'FROM TALLY\\.items i WHERE i\\.DELETED_AT IS NOT NULL': [],
      'SELECT .* FROM TALLY\\.delete_batches WHERE DELETED_AT <': [
        { ID: 9, PROPERTY_ID: 3, ROOT_TYPE: 'container', ROOT_ID: 31, ROOT_NAME: 'Bin' },
        { ID: 10, PROPERTY_ID: 3, ROOT_TYPE: 'item', ROOT_ID: 200, ROOT_NAME: 'Drill' },
      ],
      // Per-batch item reads: batch 9 carries a loan, batch 10 is clean.
      'FROM TALLY\\.items i WHERE i\\.DELETE_BATCH_ID = \\?': ([batchId]) =>
        batchId === 9 ? [{ ID: 101, ON_LOAN: 1 }] : [{ ID: 200, ON_LOAN: 0 }],
    });

    const result = await Recycle.purgeExpired();
    assert.deepEqual(result, { items: 0, batches: 1 });
    assert.deepEqual(purgedItems, [200], 'the loaned batch is left alone entirely');
    const headerDeletes = sqls.filter((s) => /DELETE FROM TALLY\.delete_batches WHERE ID = \?/i.test(s));
    assert.equal(headerDeletes.length, 1, 'only the clean batch loses its header');
  } finally {
    ItemsService.permanentDelete = orig;
  }
});

test('legacy pre-batch items are purged too, still skipping open loans', async () => {
  const ItemsService = require('../src/modules/inventory/items.service');
  const purgedItems = [];
  const orig = ItemsService.permanentDelete;
  ItemsService.permanentDelete = async (id) => { purgedItems.push(id); };
  try {
    const { sqls } = harness({
      'FROM TALLY\\.items i WHERE i\\.DELETED_AT IS NOT NULL': [{ ID: 7 }, { ID: 8 }],
      'SELECT .* FROM TALLY\\.delete_batches WHERE DELETED_AT <': [],
    });
    const result = await Recycle.purgeExpired();
    assert.deepEqual(result, { items: 2, batches: 0 });
    assert.deepEqual(purgedItems, [7, 8]);
    const orphanSql = sqls.find((s) => /FROM TALLY\.items i WHERE i\.DELETED_AT IS NOT NULL/i.test(s));
    assert.match(orphanSql, /i\.DELETE_BATCH_ID IS NULL/i, 'only rows no batch owns');
    assert.match(orphanSql, /NOT EXISTS \( SELECT 1 FROM TALLY\.item_lending il WHERE il\.ITEM_ID = i\.ID AND il\.RETURNED_AT IS NULL \)/i,
      'the purge selection skips items that still have an open loan');
  } finally {
    ItemsService.permanentDelete = orig;
  }
});

test('sweepIfDue runs at most once per interval and never throws into the caller', async () => {
  let runs = 0;
  harness();
  const orig = Recycle.purgeExpired;
  Recycle.purgeExpired = async () => { runs += 1; throw new Error('db went away'); };
  Recycle._lastSweepAt = 0;
  try {
    const first = Recycle.sweepIfDue(1_000_000);
    assert.ok(first, 'a sweep is started');
    await first; // the rejection is swallowed and logged, not propagated
    assert.equal(Recycle.sweepIfDue(1_000_000 + 60_000), null, 'too soon — nothing starts');
    assert.equal(runs, 1);
    assert.ok(Recycle.sweepIfDue(1_000_000 + 11 * 60_000), 'due again after the interval');
    assert.equal(runs, 2);
  } finally {
    Recycle.purgeExpired = orig;
    Recycle._lastSweepAt = 0;
  }
});

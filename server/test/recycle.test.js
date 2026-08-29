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
      if (new RegExp(pattern, 'i').test(flat)) return value;
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
      { ID: 7, PROPERTY_ID: 3, ROOT_TYPE: 'container', ROOT_ID: 55, ROOT_NAME: 'Bin A' },
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
      { ID: 8, PROPERTY_ID: 3, ROOT_TYPE: 'container', ROOT_ID: 55, ROOT_NAME: 'Bin A' },
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
      { ID: 9, PROPERTY_ID: 3, ROOT_TYPE: 'container', ROOT_ID: 56, ROOT_NAME: 'Inner Box' },
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
      { ID: 7, PROPERTY_ID: 3, ROOT_TYPE: 'container', ROOT_ID: 55, ROOT_NAME: 'Bin A' },
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
    [{ ID: 10, PROPERTY_ID: 3, ROOT_TYPE: 'area', ROOT_ID: 4, ROOT_NAME: 'Garage' },
      /FROM TALLY\.properties WHERE ID = \?/i, { DELETED_AT: null }],
    [{ ID: 11, PROPERTY_ID: 3, ROOT_TYPE: 'item', ROOT_ID: 101, ROOT_NAME: 'Mug' },
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

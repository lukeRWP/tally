const test = require('node:test');
const assert = require('node:assert');
const Recycle = require('../src/modules/recycle/recycle.service');
const Audit = require('../src/modules/audit/audit.service');

const noop = { warn() {}, info() {}, error() {} };

// ── #87: multi-row locks take a globally consistent order ───────────────────
// _assertAncestorsLive's joined FOR UPDATE reads lock their rows in optimizer
// join order, so two concurrent restores with different root types could
// acquire the same property/area/container rows in opposite orders and
// deadlock — and withTransaction deliberately does not retry deadlocks.
// Every root type now takes the SAME first lock, a point lock on the property
// row, so restores within a property serialize before any join runs.

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
  return { sqls, params };
}

const PROP_LOCK = /FROM TALLY\.properties WHERE ID = \? FOR UPDATE/i;

test('container-root restore takes the property point lock FIRST, before the multi-row ancestor join', async () => {
  const { sqls, params } = harness({
    'FROM TALLY\\.delete_batches b': [
      { ID: 7, PROPERTY_ID: 3, ROOT_TYPE: 'container', ROOT_ID: 55, ROOT_NAME: 'Bin A', ROLE: 'owner' },
    ],
    'FROM TALLY\\.properties WHERE ID = \\?': [{ DELETED_AT: null }],
    'FROM TALLY\\.containers c JOIN TALLY\\.areas a': [
      { PARENT_CONTAINER_ID: null, AREA_DELETED: null, PROP_DELETED: null, PARENT_DELETED: null },
    ],
  });

  await Recycle.restore(7, 42);

  const propLockIdx = sqls.findIndex((s) => PROP_LOCK.test(s));
  const joinIdx = sqls.findIndex((s) => /FROM TALLY\.containers c JOIN TALLY\.areas a/i.test(s));
  const firstUndeleteIdx = sqls.findIndex((s) => /SET DELETED_AT = NULL/i.test(s));

  assert.ok(propLockIdx >= 0, 'the property row is locked');
  assert.ok(joinIdx >= 0, 'the joined ancestor read still runs (and still trusts locked rows)');
  assert.ok(propLockIdx < joinIdx,
    'the serializing property lock is acquired BEFORE the join takes its multi-row locks');
  assert.ok(propLockIdx < firstUndeleteIdx, 'and before anything is un-deleted');
  assert.deepEqual(params[propLockIdx], [3], "the lock is a point lock on the batch's own property row");
});

test('item-root restore takes the property point lock FIRST too — every root type shares the same first lock', async () => {
  const { sqls } = harness({
    'FROM TALLY\\.delete_batches b': [
      { ID: 11, PROPERTY_ID: 3, ROOT_TYPE: 'item', ROOT_ID: 101, ROOT_NAME: 'Mug', ROLE: 'owner' },
    ],
    'FROM TALLY\\.properties WHERE ID = \\?': [{ DELETED_AT: null }],
    'FROM TALLY\\.items i JOIN': [
      { CONTAINER_DELETED: null, AREA_DELETED: null, PROP_DELETED: null },
    ],
  });

  await Recycle.restore(11, 42);

  const propLockIdx = sqls.findIndex((s) => PROP_LOCK.test(s));
  const joinIdx = sqls.findIndex((s) => /FROM TALLY\.items i JOIN TALLY\.containers c/i.test(s));
  assert.ok(propLockIdx >= 0 && joinIdx >= 0);
  assert.ok(propLockIdx < joinIdx,
    'item-root: property lock first, joined multi-row read second — same global order as every other root type');
});

test('a soft-deleted property refuses the restore AT the serializing lock (409), before the join ever runs', async () => {
  const { sqls } = harness({
    'FROM TALLY\\.delete_batches b': [
      { ID: 8, PROPERTY_ID: 3, ROOT_TYPE: 'container', ROOT_ID: 55, ROOT_NAME: 'Bin A', ROLE: 'owner' },
    ],
    'FROM TALLY\\.properties WHERE ID = \\?': [{ DELETED_AT: '2026-08-01' }],
  });

  await assert.rejects(
    () => Recycle.restore(8, 42),
    (err) => err.statusCode === 409 && /property/i.test(err.message),
  );
  assert.ok(!sqls.some((s) => /FROM TALLY\.containers c JOIN/i.test(s)),
    'the multi-row join never ran — the refusal came from the ordered point lock');
  assert.ok(!sqls.some((s) => /SET DELETED_AT = NULL/i.test(s)), 'nothing was un-deleted');
});

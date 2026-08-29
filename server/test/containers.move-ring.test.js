const test = require('node:test');
const assert = require('node:assert');
const Containers = require('../src/modules/inventory/containers.service');
const Audit = require('../src/modules/audit/audit.service');

const noop = { warn() {}, info() {}, error() {} };

// ── #87: concurrent moves arranged in a ring ────────────────────────────────
// Locking only {mover, destination} provably fails rings of ≥4: with
// A→B→C→D→A, moves 1+3 commit first, after which moves 2+4 hold DISJOINT
// lock pairs — neither waits, each cycle check passes against a state with
// no cycle yet, and together they commit the 4-cycle. The fix locks the
// mover, the destination, AND the destination's whole current ancestor
// chain in one ascending-ID FOR UPDATE, then re-reads the chain after the
// locks are held: any move that could change the answer must wait on those
// rows, and the post-lock reads see whatever it committed.

// txDb idiom (containers.integrity/move-cross tests): every query is logged
// with a tx flag so a test can prove a statement ran inside the transaction,
// and in what order relative to the serializing lock.
function txDb(handler) {
  const calls = [];
  const log = async (sql, params, tx) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: flat, params, tx });
    return handler(flat, params);
  };
  return {
    calls,
    query: (sql, params) => log(sql, params, false),
    withTransaction: async (fn) => fn({ query: (sql, params) => log(sql, params, true) }),
  };
}

function initAudit() { Audit.init({ db: { query: async () => [] }, logger: noop }); }

const LOCK = /SELECT ID FROM TALLY\.containers WHERE ID IN .* FOR UPDATE/i;
// Pre-tx advisory chain read (ClosureTableService.getAncestors) vs the
// in-tx post-lock re-read: distinguished by the ORDER BY only the former has.
const ANC_ADVISORY = /SELECT ANCESTOR_ID, DEPTH FROM TALLY\.container_paths WHERE DESCENDANT_ID = \?/i;
const ANC_RECHECK = /SELECT ANCESTOR_ID FROM TALLY\.container_paths WHERE DESCENDANT_ID = \? AND DEPTH > 0/i;
const CYCLE = /container_paths WHERE ANCESTOR_ID = \? AND DESCENDANT_ID = \? LIMIT 1/i;
const MOVE_WRITE = /UPDATE TALLY\.containers SET PARENT_CONTAINER_ID|DELETE FROM TALLY\.container_paths|INSERT INTO TALLY\.container_paths/i;

test('the serializing lock covers mover + destination + its whole ancestor chain, ascending, BEFORE any in-tx ancestry read', async () => {
  const db = txDb((sql, params) => {
    if (LOCK.test(sql)) return params.map((id) => ({ ID: id }));
    if (ANC_ADVISORY.test(sql)) return [{ ANCESTOR_ID: 9, DEPTH: 1 }, { ANCESTOR_ID: 2, DEPTH: 2 }];
    if (ANC_RECHECK.test(sql)) return [{ ANCESTOR_ID: 9 }, { ANCESTOR_ID: 2 }]; // unchanged chain
    if (CYCLE.test(sql)) return [];
    if (/SELECT c\.AREA_ID FROM TALLY\.containers c/i.test(sql)) return [{ AREA_ID: 7 }];
    if (/SELECT a\.PROPERTY_ID/i.test(sql)) return [{ PROPERTY_ID: 1 }];
    if (/PROPERTY_ID AS PROPERTY_ID/.test(sql)) return [{ ID: 5, NAME: 'Bin', AREA_ID: 7 }];
    return [];
  });
  initAudit();
  Containers.init({ db, logger: noop });

  await Containers.move(5, 3, undefined, 42); // dest 3 currently sits under 9, which sits under 2

  const txCalls = db.calls.filter((c) => c.tx);
  const lockIdx = txCalls.findIndex((c) => LOCK.test(c.sql));
  const recheckIdx = txCalls.findIndex((c) => ANC_RECHECK.test(c.sql));
  const cycleIdx = txCalls.findIndex((c) => CYCLE.test(c.sql));

  assert.equal(lockIdx, 0, 'the FOR UPDATE lock is the first statement in the transaction');
  assert.deepEqual(txCalls[lockIdx].params, [2, 3, 5, 9],
    "locks mover (5), destination (3) AND the destination's ancestors (9, 2), in ascending-ID order");
  assert.ok(recheckIdx > lockIdx, 'the ancestor chain is re-read AFTER the locks are held');
  assert.ok(cycleIdx > recheckIdx, 'the cycle check reads the closure table only after the post-lock re-verification');
});

test("ring partner committed while we waited on the lock: the post-lock chain re-read sees it and refuses 409, before any write", async () => {
  // D→under A, arriving last in the ring. At advisory time A was a root
  // (empty chain); by the time our locks are granted, a partner has
  // committed A under something — the chain we locked is no longer the
  // chain that exists, so the move must refuse rather than trust it.
  const db = txDb((sql, params) => {
    if (LOCK.test(sql)) return params.map((id) => ({ ID: id }));
    if (ANC_ADVISORY.test(sql)) return []; // chain empty when the move was requested
    if (ANC_RECHECK.test(sql)) return [{ ANCESTOR_ID: 7 }]; // partner's commit landed while we waited
    return [];
  });
  initAudit();
  Containers.init({ db, logger: noop });

  await assert.rejects(
    () => Containers.move(5, 3, undefined, 42),
    (e) => e.statusCode === 409 && /changed|try again/i.test(e.message),
    'a drifted ancestor chain refuses with 409'
  );

  const txCalls = db.calls.filter((c) => c.tx);
  const lockIdx = txCalls.findIndex((c) => LOCK.test(c.sql));
  const recheckIdx = txCalls.findIndex((c) => ANC_RECHECK.test(c.sql));
  assert.equal(lockIdx, 0, 'the lock was taken first');
  assert.ok(recheckIdx > lockIdx, 'the re-read that caught the drift ran under the lock');
  assert.ok(!db.calls.some((c) => MOVE_WRITE.test(c.sql)),
    'nothing was written — no parent update, no closure rewrite');
});

test('ring closes into a cycle: the post-lock cycle check sees the committed partner and refuses 400, before any write', async () => {
  // The chain we locked is intact (the partner committed BEFORE our advisory
  // read), and that committed state already makes the destination our
  // descendant — the classic "would create a cycle", decided under the lock.
  const db = txDb((sql, params) => {
    if (LOCK.test(sql)) return params.map((id) => ({ ID: id }));
    if (ANC_ADVISORY.test(sql)) return [{ ANCESTOR_ID: 7, DEPTH: 1 }];
    if (ANC_RECHECK.test(sql)) return [{ ANCESTOR_ID: 7 }]; // chain unchanged
    if (CYCLE.test(sql)) return [{ 1: 1 }]; // destination descends from the mover
    return [];
  });
  initAudit();
  Containers.init({ db, logger: noop });

  await assert.rejects(
    () => Containers.move(5, 3, undefined, 42),
    (e) => e.statusCode === 400 && /descendant/i.test(e.message)
  );

  const txCalls = db.calls.filter((c) => c.tx);
  const lockIdx = txCalls.findIndex((c) => LOCK.test(c.sql));
  const cycleIdx = txCalls.findIndex((c) => CYCLE.test(c.sql));
  assert.equal(lockIdx, 0);
  assert.ok(cycleIdx > lockIdx, 'the cycle check ran under the lock, against committed state');
  assert.ok(!db.calls.some((c) => MOVE_WRITE.test(c.sql)), 'nothing was written');
});

test('a root move (no destination parent) locks only the mover and skips chain verification', async () => {
  const db = txDb((sql, params) => {
    if (LOCK.test(sql)) return params.map((id) => ({ ID: id }));
    if (/SELECT ID FROM TALLY\.areas WHERE ID = \? AND DELETED_AT IS NULL/i.test(sql)) return [{ ID: 9 }];
    if (/SELECT a\.PROPERTY_ID/i.test(sql)) return [{ PROPERTY_ID: 1 }];
    if (/PROPERTY_ID AS PROPERTY_ID/.test(sql)) return [{ ID: 5, NAME: 'Bin', AREA_ID: 9 }];
    return [];
  });
  initAudit();
  Containers.init({ db, logger: noop });

  await Containers.move(5, null, 9, 42);

  const lockCall = db.calls.find((c) => LOCK.test(c.sql));
  assert.deepEqual(lockCall.params, [5], 'only the mover is locked');
  // Scoped to tx calls: getById's breadcrumb legitimately reads ancestors on
  // the pool AFTER the move; the transaction itself must not.
  assert.ok(!db.calls.some((c) => c.tx && (ANC_RECHECK.test(c.sql) || ANC_ADVISORY.test(c.sql))),
    'no ancestor chain is read in-tx — a root move cannot create a cycle');
});

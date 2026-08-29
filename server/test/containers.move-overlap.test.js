const test = require('node:test');
const assert = require('node:assert');
const Containers = require('../src/modules/inventory/containers.service');
const Audit = require('../src/modules/audit/audit.service');

const noop = { warn() {}, info() {}, error() {} };

// ── #252: overlapping-subtree moves must not eat each other's fresh edges ───
// moveNode's Step-3 DELETE replays ancestors(mover) × subtree(mover) IN-lists
// materialized by its Step-1/2 reads. The reviewer's trace (b6-t2): A→B with
// B outside shared ancestor R's tree, concurrent W∈subtree(A)→S with S under
// R. Under #87's {mover, dest} ∪ anc(dest) discipline those two moves hold
// DISJOINT lock sets — fully concurrent — and whichever Step-3 lands second
// deletes the R→W closure row the partner just inserted: a lost ancestry
// edge, silent (no cycle, no deadlock, no error).
//
// The fix widens the lock set with the mover's SUBTREE (still one ascending-
// ID FOR UPDATE, still statement 0), advisory pre-tx + re-verified post-lock
// (409 on drift), exactly the #87 shape. Every row a move's rewrite touches
// has its DESCENDANT in that mover's subtree, so two rewrites that could
// touch the same closure row share a subtree member — a container row BOTH
// lock sets contain — and serialize. Cast below: R=2, B=3, A=5, W=8, S=9.

// txDb idiom (containers.move-ring.test.js): every query is logged with a tx
// flag so a test can prove a statement ran inside the transaction, and in
// what order relative to the serializing lock.
function txDb(handler) {
  const calls = [];
  const log = async (sql, params, tx) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: flat, params, tx });
    return handler(flat, params, tx);
  };
  return {
    calls,
    query: (sql, params) => log(sql, params, false),
    withTransaction: async (fn) => fn({ query: (sql, params) => log(sql, params, true) }),
  };
}

function initAudit() { Audit.init({ db: { query: async () => [] }, logger: noop }); }

const LOCK = /SELECT ID FROM TALLY\.containers WHERE ID IN .* FOR UPDATE/i;
// The subtree read: the advisory pre-tx read and the post-lock re-read share
// this exact SQL on purpose (same predicate, same rows) — the tx flag is
// what separates them, which is precisely what these tests assert.
const SUBTREE = /SELECT DESCENDANT_ID FROM TALLY\.container_paths WHERE ANCESTOR_ID = \? AND DEPTH > 0/i;
// moveNode's Step-1 (no DEPTH filter — it includes self) vs the subtree pair.
const STEP1 = /SELECT DESCENDANT_ID FROM TALLY\.container_paths WHERE ANCESTOR_ID = \?(?! AND DEPTH)/i;
const STEP2 = /SELECT ANCESTOR_ID FROM TALLY\.container_paths WHERE DESCENDANT_ID = \? AND ANCESTOR_ID != \?/i;
const STEP3_DELETE = /DELETE FROM TALLY\.container_paths WHERE ANCESTOR_ID IN/i;
const ANC_ADVISORY = /SELECT ANCESTOR_ID, DEPTH FROM TALLY\.container_paths WHERE DESCENDANT_ID = \?/i;
const ANC_RECHECK = /SELECT ANCESTOR_ID FROM TALLY\.container_paths WHERE DESCENDANT_ID = \? AND DEPTH > 0/i;
const CYCLE = /container_paths WHERE ANCESTOR_ID = \? AND DESCENDANT_ID = \? LIMIT 1/i;
const PARENT_AREA = /SELECT c\.AREA_ID FROM TALLY\.containers c JOIN/i;
const AREA_LIVE = /SELECT ID FROM TALLY\.areas WHERE ID = \? AND DELETED_AT IS NULL/i;
const MOVE_WRITE = /UPDATE TALLY\.containers SET PARENT_CONTAINER_ID|DELETE FROM TALLY\.container_paths|INSERT INTO TALLY\.container_paths/i;

test("the lock set includes the mover's subtree: A→B locks W, the very row W→S must lock as its mover", async () => {
  // Move A(5) → B(3). W(8) sits inside subtree(A). Under the old lock set
  // {5, 3} ∪ anc(3), the concurrent W→S ({8, 9} ∪ anc(9) = {8, 9, 2}) shares
  // nothing with this move — the disjointness the trace exploits. W's row in
  // THIS lock set is what forces the two moves to collide.
  const db = txDb((sql, params) => {
    if (LOCK.test(sql)) return params.map((id) => ({ ID: id }));
    if (SUBTREE.test(sql)) return [{ DESCENDANT_ID: 8 }]; // subtree(A) = {W}, stable
    if (ANC_ADVISORY.test(sql)) return []; // B is a root outside R's tree
    if (ANC_RECHECK.test(sql)) return [];
    if (CYCLE.test(sql)) return [];
    if (PARENT_AREA.test(sql)) return [{ AREA_ID: 7 }];
    if (STEP1.test(sql)) return [{ DESCENDANT_ID: 5 }, { DESCENDANT_ID: 8 }];
    if (STEP2.test(sql)) return [{ ANCESTOR_ID: 2 }]; // A currently sits under R
    if (/SELECT a\.PROPERTY_ID/i.test(sql)) return [{ PROPERTY_ID: 1 }];
    if (/PROPERTY_ID AS PROPERTY_ID/.test(sql)) return [{ ID: 5, NAME: 'A', AREA_ID: 7 }];
    return [];
  });
  initAudit();
  Containers.init({ db, logger: noop });

  await Containers.move(5, 3, undefined, 42);

  const txCalls = db.calls.filter((c) => c.tx);
  assert.ok(LOCK.test(txCalls[0].sql), 'the FOR UPDATE lock is still the FIRST statement in the transaction (#87 pin)');
  assert.deepEqual(txCalls[0].params, [3, 5, 8],
    "one ascending-ID statement: destination (3), mover (5), and the mover's subtree (8=W) — W's row is the collision point with W→S");

  const advisoryIdx = db.calls.findIndex((c) => !c.tx && SUBTREE.test(c.sql));
  const recheckIdx = txCalls.findIndex((c) => SUBTREE.test(c.sql));
  assert.ok(advisoryIdx >= 0, 'the subtree that fed the lock set was read on the POOL, pre-tx (never pinning the tx read view early)');
  assert.ok(recheckIdx > 0, 'and is re-verified IN-TX, after the locks are held');
});

test("reviewer's interleaving: partner's W→S committed while we waited — 409 BEFORE any closure write, so the fresh R→W edge survives", async () => {
  // Move A(5)→B(3) read subtree(A) ∋ W at advisory time, so its lock
  // statement includes W's row — and W→S holds it. We wait. The partner
  // commits (its Step-4 freshly inserted R→W under S). Our post-lock subtree
  // re-read now shows W gone: the lists we would replay are stale, so the
  // move must refuse — its Step-3 DELETE (ancestors {R} × descendants {A,W})
  // is exactly the statement that would have eaten the partner's fresh R→W.
  const db = txDb((sql, params, tx) => {
    if (LOCK.test(sql)) return params.map((id) => ({ ID: id }));
    // Advisory (pool): W still ours. In-tx re-read: W left while we waited.
    if (SUBTREE.test(sql)) return tx ? [] : [{ DESCENDANT_ID: 8 }];
    if (ANC_ADVISORY.test(sql)) return [];
    return [];
  });
  initAudit();
  Containers.init({ db, logger: noop });

  await assert.rejects(
    () => Containers.move(5, 3, undefined, 42),
    (e) => e.statusCode === 409 && /changed|try again/i.test(e.message),
    'a drifted subtree refuses with 409 — retry locks the settled tree'
  );

  const txCalls = db.calls.filter((c) => c.tx);
  assert.ok(LOCK.test(txCalls[0].sql), 'the lock was taken first');
  assert.ok(SUBTREE.test(txCalls[1].sql), 'the subtree re-read that caught the drift ran directly under the lock');
  assert.ok(!db.calls.some((c) => MOVE_WRITE.test(c.sql)),
    "nothing was written — no Step-3 DELETE ever ran, so the partner's freshly inserted closure rows are untouched");
});

test('a member that JOINED the subtree while we waited also drifts to 409 — the unlocked newcomer is never rewritten', async () => {
  const db = txDb((sql, params, tx) => {
    if (LOCK.test(sql)) return params.map((id) => ({ ID: id }));
    // Leaf at advisory time; someone moved 12 under us while we waited.
    if (SUBTREE.test(sql)) return tx ? [{ DESCENDANT_ID: 12 }] : [];
    if (ANC_ADVISORY.test(sql)) return [];
    return [];
  });
  initAudit();
  Containers.init({ db, logger: noop });

  await assert.rejects(
    () => Containers.move(5, 3, undefined, 42),
    (e) => e.statusCode === 409 && /changed|try again/i.test(e.message)
  );
  assert.ok(!db.calls.some((c) => MOVE_WRITE.test(c.sql)),
    'a subtree member we do not hold locked is never swept into the rewrite');
});

test("serialized second: W→S after A→B committed — Step-3's IN-lists are the post-lock reads' output, so R is not in the delete list", async () => {
  // The other serialization order. A→B has committed: W's ancestors are now
  // {A(5), B(3)} — R(2) already detached. Our Step-1/2 reads run in-tx,
  // after the lock; the Step-3 DELETE must be fed exactly what they
  // returned. The stale-world lists (ancestors ∋ R) would have deleted
  // R→W; the post-lock lists cannot name R at all.
  const db = txDb((sql, params) => {
    if (LOCK.test(sql)) return params.map((id) => ({ ID: id }));
    if (SUBTREE.test(sql)) return []; // W is a leaf, before and after the lock
    if (ANC_ADVISORY.test(sql)) return [{ ANCESTOR_ID: 2, DEPTH: 1 }]; // S(9) sits under R(2)
    if (ANC_RECHECK.test(sql)) return [{ ANCESTOR_ID: 2 }]; // unchanged
    if (CYCLE.test(sql)) return [];
    if (PARENT_AREA.test(sql)) return [{ AREA_ID: 7 }];
    if (STEP1.test(sql)) return [{ DESCENDANT_ID: 8 }]; // subtree(W) = {W}
    if (STEP2.test(sql)) return [{ ANCESTOR_ID: 5 }, { ANCESTOR_ID: 3 }]; // current truth: A, B — NOT R
    if (/SELECT a\.PROPERTY_ID/i.test(sql)) return [{ PROPERTY_ID: 1 }];
    if (/PROPERTY_ID AS PROPERTY_ID/.test(sql)) return [{ ID: 8, NAME: 'W', AREA_ID: 7 }];
    return [];
  });
  initAudit();
  Containers.init({ db, logger: noop });

  await Containers.move(8, 9, undefined, 42); // W → under S

  const txCalls = db.calls.filter((c) => c.tx);
  const lockIdx = txCalls.findIndex((c) => LOCK.test(c.sql));
  const step1Idx = txCalls.findIndex((c) => STEP1.test(c.sql));
  const step2Idx = txCalls.findIndex((c) => STEP2.test(c.sql));
  const step3Idx = txCalls.findIndex((c) => STEP3_DELETE.test(c.sql));

  assert.equal(lockIdx, 0, 'lock first');
  assert.deepEqual(txCalls[lockIdx].params, [2, 8, 9], 'mover (8), destination (9), and its ancestor R (2), ascending');
  assert.ok(step1Idx > lockIdx && step2Idx > lockIdx, "moveNode's list reads run in-tx, AFTER the lock waits");
  assert.ok(step3Idx > step2Idx, 'the DELETE follows the reads that feed it');
  assert.deepEqual(txCalls[step3Idx].params, [5, 3, 8],
    'the DELETE replays exactly the post-lock lists: ancestors {A(5), B(3)} × descendants {W(8)}');
  assert.ok(!txCalls[step3Idx].params.includes(2),
    "R(2) is NOT in the delete list — the fresh R→W edge this move is about to re-create can never be sniped by a stale replay");
});

test('a root move locks its subtree too — Step 3 runs for root moves, so the same overlap exists there', async () => {
  const db = txDb((sql, params) => {
    if (LOCK.test(sql)) return params.map((id) => ({ ID: id }));
    if (SUBTREE.test(sql)) return [{ DESCENDANT_ID: 8 }];
    if (AREA_LIVE.test(sql)) return [{ ID: 9 }];
    if (STEP1.test(sql)) return [{ DESCENDANT_ID: 5 }, { DESCENDANT_ID: 8 }];
    if (STEP2.test(sql)) return [{ ANCESTOR_ID: 2 }];
    if (/SELECT a\.PROPERTY_ID/i.test(sql)) return [{ PROPERTY_ID: 1 }];
    if (/PROPERTY_ID AS PROPERTY_ID/.test(sql)) return [{ ID: 5, NAME: 'A', AREA_ID: 9 }];
    return [];
  });
  initAudit();
  Containers.init({ db, logger: noop });

  await Containers.move(5, null, 9, 42); // A → root of area 9

  const txCalls = db.calls.filter((c) => c.tx);
  assert.ok(LOCK.test(txCalls[0].sql), 'lock is still statement 0');
  assert.deepEqual(txCalls[0].params, [5, 8],
    'a root move locks the mover AND its subtree — its Step-3 detach-from-old-ancestors runs all the same');
  assert.ok(txCalls.some((c) => SUBTREE.test(c.sql)), 'and re-verifies the subtree under the lock');
});

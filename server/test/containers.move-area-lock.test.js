const test = require('node:test');
const assert = require('node:assert');
const Containers = require('../src/modules/inventory/containers.service');
const Audit = require('../src/modules/audit/audit.service');

const noop = { warn() {}, info() {}, error() {} };

// ── #256: the lock family's last stray ──────────────────────────────────────
// A root move's destination-AREA liveness check (no parent container to lock
// instead) used to be a plain, unlocked read — the one gap #252's adversarial
// review found, pre-existing and untouched by that fix. A concurrent
// AreasService.cascadeDelete landing between that read and the move's final
// UPDATE could plant a live subtree in a dead area: phantom inventory,
// hidden from area navigation but still surfacing in search/reports.
//
// The fix locks the area row (SELECT ... FOR UPDATE) INSIDE the move's
// transaction, as the statement immediately following the container
// family's ascending statement-0 lock — areas are a different id space, so
// it cannot be folded into that IN-list; it lands in the one fixed position
// (right after the container lock) so it can never invert against
// AreasService.cascadeDelete's own internal order (containers, then the
// area row last).

// txDb idiom (containers.move-ring/move-overlap tests): every query is
// logged with a tx flag so a test can prove a statement ran inside the
// transaction, and in what order relative to the serializing lock(s).
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

const CONTAINER_LOCK = /SELECT ID FROM TALLY\.containers WHERE ID IN .* FOR UPDATE/i;
const AREA_LOCK = /SELECT ID FROM TALLY\.areas WHERE ID = \? AND DELETED_AT IS NULL FOR UPDATE/i;
const SUBTREE = /SELECT DESCENDANT_ID FROM TALLY\.container_paths WHERE ANCESTOR_ID = \? AND DEPTH > 0/i;
const MOVE_WRITE = /UPDATE TALLY\.containers SET PARENT_CONTAINER_ID|DELETE FROM TALLY\.container_paths|INSERT INTO TALLY\.container_paths|UPDATE TALLY\.containers SET AREA_ID/i;
const PARENT_AREA = /SELECT c\.AREA_ID FROM TALLY\.containers c JOIN/i;

test('a root move locks the destination area FOR UPDATE, as the statement immediately after the container lock', async () => {
  const db = txDb((sql, params) => {
    if (CONTAINER_LOCK.test(sql)) return params.map((id) => ({ ID: id }));
    if (AREA_LOCK.test(sql)) return [{ ID: 9 }];
    if (SUBTREE.test(sql)) return [];
    if (/SELECT a\.PROPERTY_ID/i.test(sql)) return [{ PROPERTY_ID: 1 }];
    if (/PROPERTY_ID AS PROPERTY_ID/.test(sql)) return [{ ID: 5, NAME: 'A', AREA_ID: 9 }];
    return [];
  });
  initAudit();
  Containers.init({ db, logger: noop });

  await Containers.move(5, null, 9, 42); // root move: container 5 → area 9

  const txCalls = db.calls.filter((c) => c.tx);
  const containerLockIdx = txCalls.findIndex((c) => CONTAINER_LOCK.test(c.sql));
  const areaLockIdx = txCalls.findIndex((c) => AREA_LOCK.test(c.sql));

  assert.equal(containerLockIdx, 0, 'the container-family lock is still statement 0 (unchanged by this fix)');
  assert.equal(areaLockIdx, 1, 'the area lock is the very next statement — before any other tx logic runs');
  assert.deepEqual(txCalls[areaLockIdx].params, [9], 'a point lock on exactly the destination area row');
  assert.match(txCalls[areaLockIdx].sql, /FOR UPDATE/, 'the area row is actually locked, not just read');
});

test('area soft-deleted between the request and the lock: the locking read sees it dead and 404s — nothing is written', async () => {
  // Simulates AreasService.cascadeDelete having already committed by the
  // time this move's transaction reaches its area-lock statement: the
  // locking SELECT's own DELETED_AT IS NULL predicate now excludes the row.
  const db = txDb((sql, params) => {
    if (CONTAINER_LOCK.test(sql)) return params.map((id) => ({ ID: id }));
    if (AREA_LOCK.test(sql)) return []; // dead by the time we locked it
    return [];
  });
  initAudit();
  Containers.init({ db, logger: noop });

  await assert.rejects(
    () => Containers.move(5, null, 9, 42),
    (e) => e.statusCode === 404 && /Destination area not found/.test(e.message),
    'a dead destination area refuses with 404, per the family convention for "the thing you are attaching to does not exist"'
  );

  assert.ok(!db.calls.some((c) => MOVE_WRITE.test(c.sql)),
    'no PARENT_CONTAINER_ID/AREA_ID update, no closure rewrite — nothing is planted in the dead area');
});

test('a move UNDER AN EXISTING PARENT never takes an area lock at all — the parent container lock is the serialization point', async () => {
  // Confirms the b6-t1 reasoning still holds for this path: the destination
  // parent container is already in the statement-0 lock set, and
  // AreasService.cascadeDelete's mass "WHERE AREA_ID = ?" UPDATE would have
  // to lock that SAME parent row to sweep it — so the parent's own
  // DELETED_AT (re-checked below, under the lock we already hold) is
  // sufficient. A root move has no such row to stand in for the area, which
  // is exactly why #256 needed its own point lock only for that case.
  const db = txDb((sql, params) => {
    if (CONTAINER_LOCK.test(sql)) return params.map((id) => ({ ID: id }));
    if (SUBTREE.test(sql)) return [];
    if (/container_paths WHERE DESCENDANT_ID = \? AND DEPTH > 0/i.test(sql)) return [];
    if (/container_paths WHERE ANCESTOR_ID = \? AND DESCENDANT_ID = \? LIMIT 1/i.test(sql)) return [];
    if (PARENT_AREA.test(sql)) return [{ AREA_ID: 7 }];
    if (/SELECT a\.PROPERTY_ID/i.test(sql)) return [{ PROPERTY_ID: 1 }];
    if (/PROPERTY_ID AS PROPERTY_ID/.test(sql)) return [{ ID: 5, NAME: 'A', AREA_ID: 7 }];
    return [];
  });
  initAudit();
  Containers.init({ db, logger: noop });

  await Containers.move(5, 3, undefined, 42); // move under existing parent 3, no explicit areaId

  assert.ok(!db.calls.some((c) => AREA_LOCK.test(c.sql)),
    'no standalone areas-table FOR UPDATE for a move with a destination parent');
});

test('a root move with no areaId (parent stays put) never touches the areas table at all', async () => {
  const db = txDb((sql, params) => {
    if (CONTAINER_LOCK.test(sql)) return params.map((id) => ({ ID: id }));
    if (SUBTREE.test(sql)) return [];
    if (/SELECT a\.PROPERTY_ID/i.test(sql)) return [{ PROPERTY_ID: 1 }];
    if (/PROPERTY_ID AS PROPERTY_ID/.test(sql)) return [{ ID: 5, NAME: 'A', AREA_ID: 7 }];
    return [];
  });
  initAudit();
  Containers.init({ db, logger: noop });

  await Containers.move(5, null, undefined, 42); // root move, no areaId given at all

  // Scoped to the TRANSACTION: getPropertyIdForContainer/getById legitimately
  // join TALLY.areas on the pool, post-commit, to resolve the audit's
  // propertyId and the response's breadcrumb — neither is a lock, and
  // neither is what #256 is about.
  assert.ok(!db.calls.some((c) => c.tx && /TALLY\.areas/i.test(c.sql)),
    'nothing to lock or check inside the transaction — the container simply keeps its current area');
});

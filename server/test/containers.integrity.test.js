const test = require('node:test');
const assert = require('node:assert');
const Containers = require('../src/modules/inventory/containers.service');
const Audit = require('../src/modules/audit/audit.service');

const noop = { warn() {}, info() {}, error() {} };
function txDb(handler) {
  const db = { query: async (sql, params) => handler(sql, params), withTransaction: async (fn) => fn({ query: db.query }) };
  return db;
}
function initAudit() { Audit.init({ db: { query: async () => [] }, logger: noop }); }

// ── move: cycle-guard inside the tx + area derived from the destination parent ──

test('move locks rows, re-checks the cycle in-tx, and cascades the parent-derived area', async () => {
  const sqls = [];
  const db = txDb((sql, params) => {
    sqls.push({ s: sql.replace(/\s+/g, ' ').trim(), p: params });
    if (/FROM TALLY\.containers WHERE ID IN .* FOR UPDATE/i.test(sql)) return params.map((id) => ({ ID: id }));
    if (/container_paths WHERE ANCESTOR_ID = \? AND DESCENDANT_ID = \?/i.test(sql)) return []; // no cycle
    if (/SELECT c\.AREA_ID FROM TALLY\.containers c/i.test(sql)) return [{ AREA_ID: 7 }];
    if (/SELECT a\.PROPERTY_ID/i.test(sql)) return [{ PROPERTY_ID: 1 }];
    return [];
  });
  initAudit();
  Containers.init({ db, logger: noop });

  await Containers.move(5, 3, undefined, 42); // move 5 under parent 3, NO areaId passed
  const joined = sqls.map((x) => x.s).join(' || ');
  assert.match(joined, /FOR UPDATE/i, 'locks the container rows FOR UPDATE');
  assert.match(joined, /container_paths WHERE ANCESTOR_ID = \? AND DESCENDANT_ID/i, 'cycle-checks inside the tx');
  const cascade = sqls.find((x) => /UPDATE TALLY\.containers SET AREA_ID = \? WHERE ID IN/i.test(x.s));
  assert.ok(cascade, 'cascades AREA_ID to the subtree');
  assert.equal(cascade.p[0], 7, 'cascaded area is derived from the parent (7), not the (absent) body areaId');
});

test('move rejects an areaId that disagrees with the destination parent (400)', async () => {
  const db = txDb((sql, params) => {
    if (/FROM TALLY\.containers WHERE ID IN .* FOR UPDATE/i.test(sql)) return params.map((id) => ({ ID: id }));
    if (/container_paths WHERE ANCESTOR_ID = \? AND DESCENDANT_ID = \?/i.test(sql)) return [];
    if (/SELECT c\.AREA_ID FROM TALLY\.containers c/i.test(sql)) return [{ AREA_ID: 7 }];
    return [];
  });
  initAudit();
  Containers.init({ db, logger: noop });
  await assert.rejects(() => Containers.move(5, 3, 9, 42), (e) => e.statusCode === 400); // areaId 9 ≠ parent area 7
});

test('move rejects a cycle detected inside the tx (400)', async () => {
  const db = txDb((sql, params) => {
    if (/FROM TALLY\.containers WHERE ID IN .* FOR UPDATE/i.test(sql)) return params.map((id) => ({ ID: id }));
    if (/container_paths WHERE ANCESTOR_ID = \? AND DESCENDANT_ID = \?/i.test(sql)) return [{ x: 1 }]; // cycle present
    return [];
  });
  initAudit();
  Containers.init({ db, logger: noop });
  await assert.rejects(() => Containers.move(5, 3, undefined, 42), (e) => e.statusCode === 400);
});

test('move into itself is rejected (400)', async () => {
  initAudit();
  Containers.init({ db: txDb(() => []), logger: noop });
  await assert.rejects(() => Containers.move(5, 5, undefined, 42), (e) => e.statusCode === 400);
});

test('root move into a soft-deleted area is rejected (404)', async () => {
  // parentContainerId null + a target areaId that resolves to no LIVE area row.
  const db = txDb((sql, params) => {
    if (/FROM TALLY\.containers WHERE ID IN .* FOR UPDATE/i.test(sql)) return params.map((id) => ({ ID: id }));
    if (/SELECT ID FROM TALLY\.areas WHERE ID = \? AND DELETED_AT IS NULL/i.test(sql)) return []; // area not live
    return [];
  });
  initAudit();
  Containers.init({ db, logger: noop });
  await assert.rejects(() => Containers.move(5, null, 9, 42), (e) => e.statusCode === 404);
});

// ── getActiveAreaId — the phantom-container guard ───────────────────────────

test('getActiveAreaId returns null for a soft-deleted container/area', async () => {
  Containers.init({ db: { query: async () => [] }, logger: noop });
  assert.equal(await Containers.getActiveAreaId(99), null);
});

test('getActiveAreaId returns the area id for a live container', async () => {
  Containers.init({ db: { query: async () => [{ AREA_ID: 7 }] }, logger: noop });
  assert.equal(await Containers.getActiveAreaId(3), 7);
});

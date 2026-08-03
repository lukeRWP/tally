const test = require('node:test');
const assert = require('node:assert');
const Areas = require('../src/modules/inventory/areas.service');
const Audit = require('../src/modules/audit/audit.service');

const noop = { warn() {}, info() {}, error() {} };

// Regression guard for the #75-sibling fix: soft-deleting an area must NOT
// destroy container_paths (which left descendants phantom + unrestorable), and
// the cascade must be set-based (was a per-container × per-item loop).
test('area cascadeDelete preserves closure paths and cascades set-based', async () => {
  const sqls = [];
  const query = async (sql) => {
    sqls.push(sql.replace(/\s+/g, ' ').trim());
    if (/SELECT PROPERTY_ID FROM TALLY\.areas/i.test(sql)) return [{ PROPERTY_ID: 3 }];
    return [];
  };
  const db = { query, withTransaction: async (fn) => fn({ query }) };
  Audit.init({ db: { query: async () => [] }, logger: noop });
  Areas.init({ db, logger: noop });

  await Areas.softDelete(5, 42);
  const joined = sqls.join(' || ');

  assert.ok(
    !/DELETE FROM TALLY\.container_paths/i.test(joined),
    'closure paths are NOT destroyed on soft-delete — subtree stays restorable',
  );
  assert.match(
    joined,
    /UPDATE TALLY\.containers SET DELETED_AT = NOW\(\) WHERE DELETED_AT IS NULL AND AREA_ID = \?/i,
    'containers soft-deleted set-based by AREA_ID',
  );
  assert.match(
    joined,
    /UPDATE TALLY\.items SET DELETED_AT = NOW\(\), STATUS = 'removed' WHERE DELETED_AT IS NULL AND CONTAINER_ID IN/i,
    'items soft-deleted set-based',
  );
  assert.match(joined, /UPDATE TALLY\.areas SET DELETED_AT = NOW\(\) WHERE ID = \?/i, 'area soft-deleted');

  // No per-item loop: exactly one item UPDATE, not one per item.
  const itemUpdates = sqls.filter((s) => /UPDATE TALLY\.items SET DELETED_AT/i.test(s));
  assert.equal(itemUpdates.length, 1, 'a single set-based item update, not a per-row loop');
});

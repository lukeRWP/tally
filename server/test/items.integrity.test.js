const test = require('node:test');
const assert = require('node:assert');
const Items = require('../src/modules/inventory/items.service');
const Audit = require('../src/modules/audit/audit.service');

const noop = { warn() {}, info() {}, error() {} };

// softDelete must refuse an item that is currently lent out, or the open loan
// record is orphaned and later destroyed by the 30-day purge.
test('softDelete refuses an item with an open loan (409)', async () => {
  Audit.init({ db: { query: async () => [] }, logger: noop });
  Items.init({
    db: {
      query: async (sql) => {
        if (/SELECT a\.PROPERTY_ID|PROPERTY_ID FROM/i.test(sql)) return [{ PROPERTY_ID: 1 }];
        if (/FROM TALLY\.item_lending WHERE ITEM_ID = \? AND RETURNED_AT IS NULL/i.test(sql)) return [{ ID: 7 }]; // open loan
        return [];
      },
    },
    logger: noop,
  });
  await assert.rejects(() => Items.softDelete(5, 42), (e) => e.statusCode === 409);
});

test('softDelete proceeds when the item has no open loan', async () => {
  Audit.init({ db: { query: async () => [] }, logger: noop });
  let deleted = false;
  Items.init({
    db: {
      query: async (sql) => {
        if (/PROPERTY_ID FROM|SELECT a\.PROPERTY_ID/i.test(sql)) return [{ PROPERTY_ID: 1 }];
        if (/FROM TALLY\.item_lending WHERE ITEM_ID = \? AND RETURNED_AT IS NULL/i.test(sql)) return []; // no open loan
        if (/UPDATE TALLY\.items SET DELETED_AT = NOW\(\), STATUS = 'removed'/i.test(sql)) { deleted = true; return { affectedRows: 1 }; }
        return [];
      },
    },
    logger: noop,
  });
  await Items.softDelete(5, 42);
  assert.equal(deleted, true);
});

// purgeExpired must skip items with an open loan (defense in depth).
test('purgeExpired excludes open-loan items via NOT EXISTS', async () => {
  let selectSql = '';
  Items.init({
    db: {
      query: async (sql) => {
        if (/SELECT i\.ID FROM TALLY\.items i/i.test(sql)) { selectSql = sql.replace(/\s+/g, ' '); return []; }
        return [];
      },
    },
    logger: noop,
  });
  await Items.purgeExpired(42);
  assert.match(selectSql, /NOT EXISTS \( SELECT 1 FROM TALLY\.item_lending il WHERE il\.ITEM_ID = i\.ID AND il\.RETURNED_AT IS NULL \)/i,
    'the purge selection skips items that still have an open loan');
});

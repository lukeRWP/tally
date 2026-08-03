const test = require('node:test');
const assert = require('node:assert');
const Lending = require('../src/modules/lending/lending.service');

// Fake db: scriptable query + a withTransaction that runs fn with the same query.
function fakeDb(handler) {
  const db = {
    query: async (sql, params) => handler(sql, params),
    withTransaction: async (fn) => fn({ query: db.query }),
  };
  return db;
}
const logger = { warn() {}, info() {}, error() {} };

test('lend rejects a second active loan on the same item (409)', async () => {
  Lending.init({
    // lend() now locks the item row (SELECT ... FOR UPDATE) then checks for an
    // open loan, both inside the transaction. Mock the item as existing and an
    // open loan as present so the 409 path is exercised.
    db: fakeDb((sql) => {
      if (/FROM TALLY\.items WHERE ID = \? AND DELETED_AT IS NULL FOR UPDATE/.test(sql)) return [{ ID: 5 }];
      if (/WHERE ITEM_ID = \? AND RETURNED_AT IS NULL/.test(sql)) return [{ ID: 1, ITEM_ID: 5 }];
      return [];
    }),
    logger,
  });
  await assert.rejects(() => Lending.lend(5, { lentTo: 'Bob' }, 1), (e) => e.statusCode === 409);
});

test('lend inserts and marks the item lent when it is free', async () => {
  let statusSet = false;
  Lending.init({
    db: fakeDb((sql) => {
      if (/FROM TALLY\.items WHERE ID = \? AND DELETED_AT IS NULL FOR UPDATE/.test(sql)) return [{ ID: 5 }];
      if (/SELECT 1 FROM TALLY\.item_lending WHERE ITEM_ID = \? AND RETURNED_AT IS NULL/.test(sql)) return []; // no open loan
      if (/INSERT INTO TALLY\.item_lending/.test(sql)) return { insertId: 42 };
      if (/UPDATE TALLY\.items SET STATUS = 'lent'/.test(sql)) { statusSet = true; return { affectedRows: 1 }; }
      if (/SELECT \* FROM TALLY\.item_lending WHERE ID/.test(sql)) return [{ ID: 42, ITEM_ID: 5, LENT_TO: 'Bob' }];
      return [];
    }),
    logger,
  });
  const result = await Lending.lend(5, { lentTo: 'Bob' }, 1);
  assert.ok(result && result.id === 42 && result.itemId === 5);
  assert.equal(statusSet, true);
});

test('lend refuses a soft-deleted (recycled) item — 404', async () => {
  // The lock query filters DELETED_AT IS NULL, so a recycled item returns no
  // row → 404. This stops a loan being created on an item that will be purged
  // (which would then destroy the loan record).
  Lending.init({
    db: fakeDb(() => []), // no live item row for any query
    logger,
  });
  await assert.rejects(() => Lending.lend(5, { lentTo: 'Bob' }, 1), (e) => e.statusCode === 404);
});

test('return rejects a double-return (409, affectedRows 0)', async () => {
  Lending.init({
    db: fakeDb((sql) => (/UPDATE TALLY\.item_lending SET RETURNED_AT/.test(sql) ? { affectedRows: 0 } : [])),
    logger,
  });
  await assert.rejects(() => Lending.return(9, 1), (e) => e.statusCode === 409);
});

test('return reactivates the item only when no other open lending remains', async () => {
  let activated = false;
  Lending.init({
    db: fakeDb((sql) => {
      if (/UPDATE TALLY\.item_lending SET RETURNED_AT/.test(sql)) return { affectedRows: 1 };
      if (/SELECT \* FROM TALLY\.item_lending WHERE ID/.test(sql)) return [{ ID: 9, ITEM_ID: 5 }];
      if (/SELECT 1 FROM TALLY\.item_lending WHERE ITEM_ID = \? AND RETURNED_AT IS NULL/.test(sql)) return [];
      if (/UPDATE TALLY\.items SET STATUS = 'active'/.test(sql)) { activated = true; return { affectedRows: 1 }; }
      return [];
    }),
    logger,
  });
  const result = await Lending.return(9, 1);
  assert.ok(result && result.id === 9);
  assert.equal(activated, true);
});

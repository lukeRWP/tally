const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Reports = require('../src/modules/reports/reports.service');

const SRC = fs.readFileSync(
  path.join(__dirname, '../src/modules/reports/reports.service.js'),
  'utf8',
);

// #344 — items.STATUS is active | lent | removed. Lending flips an item to
// 'lent' and only a return flips it back (lending.service.js), so a report that
// filters `STATUS = 'active'` drops everything out on loan. The insurance
// summary and total value did exactly that, and it looked like nothing: the
// numbers were just smaller, with no line saying what was left out.
//
// Same style of guard as reports.purchase-date.test.js: the fake db does not
// run SQL, so the contract is asserted on the query text itself.

test("no report filters items on STATUS = 'active'", () => {
  const hits = SRC.match(/STATUS\s*=\s*'active'/g) || [];
  assert.deepEqual(hits, [], 'a report is excluding lent items again — this is #344');
});

test('the two money reports exclude only what the property no longer owns', () => {
  // Both queries carry the predicate, so a lent item is in the money and a
  // removed one is not — whatever DELETED_AT says.
  const hits = SRC.match(/i\.STATUS\s*<>\s*'removed'/g) || [];
  assert.equal(hits.length, 2, `expected the insurance + total-value predicates, found ${hits.length}`);
});

test('a lent item is worth what it is worth', async () => {
  // The service does no filtering of its own on status — the SQL is the whole
  // control — so a row that comes back is counted. This pins that: nothing in
  // JS quietly drops a row because its STATUS is not 'active'.
  const noop = { warn() {}, info() {}, error() {} };
  const rows = [
    { ITEM_ID: 1, AREA_NAME: 'Garage', ITEM_CONDITION: 'good', PURCHASE_PRICE: '100.00', CURRENT_VALUE: '90.00', COMPLETENESS: 'complete', STATUS: 'active' },
    { ITEM_ID: 2, AREA_NAME: 'Garage', ITEM_CONDITION: 'good', PURCHASE_PRICE: '40.00', CURRENT_VALUE: '30.00', COMPLETENESS: 'complete', STATUS: 'lent' },
  ];
  Reports.init({ db: { query: async (sql) => (/entity_tags/.test(sql) ? [] : rows) }, logger: noop, config: {} });

  const { totals } = await Reports.totalValue(1, { groupBy: 'property' });
  assert.equal(totals.itemCount, 2, 'the lent item was dropped');
  assert.equal(totals.currentTotal, 120);
  assert.equal(totals.purchaseTotal, 140);
});

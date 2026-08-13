const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Items = require('../src/modules/inventory/items.service');
const Reports = require('../src/modules/reports/reports.service');
const Audit = require('../src/modules/audit/audit.service');

const noop = { warn() {}, info() {}, error() {} };

/**
 * items.CURRENT_VALUE is read straight into the insurance summary, and vision
 * identification writes a GUESS into it. These tests hold the line that a
 * guessed number and a declared one stay distinguishable all the way to the
 * report — the failure mode is silent and only shows up on a claim form.
 */

// ── create ────────────────────────────────────────────────────────────────

/** Runs Items.create against a fake db and returns the INSERT's sql + params. */
async function captureInsert(data) {
  Audit.init({ db: { query: async () => [] }, logger: noop });
  let insert = null;
  Items.init({
    db: {
      query: async (sql, params) => {
        if (/^\s*INSERT INTO TALLY\.items/i.test(sql)) {
          insert = { sql, params };
          return { insertId: 1 };
        }
        if (/PROPERTY_ID/i.test(sql)) return [{ PROPERTY_ID: 1 }];
        return [{ ID: 1, NAME: 'x', CONTAINER_ID: 1 }];
      },
    },
    logger: noop,
  });
  // Distinctive containerId and quantity on purpose: with both set to 1, an
  // off-by-one in the column index would read a 1 and the assertion would pass
  // for the wrong reason.
  await Items.create({ containerId: 7, name: 'Mug', quantity: 5, ...data }, 42);
  return insert;
}

test('create marks a kept estimate as an estimate', async () => {
  const { sql, params } = await captureInsert({ currentValue: 12, currentValueIsEstimate: true });
  const i = sql.split(',').findIndex(c => /CURRENT_VALUE_IS_ESTIMATE/.test(c));
  assert.ok(i >= 0, 'CURRENT_VALUE_IS_ESTIMATE not in the column list');
  assert.equal(params[i], 1);
});

test('create defaults to declared when the flag is absent', async () => {
  const { sql, params } = await captureInsert({ currentValue: 12 });
  const i = sql.split(',').findIndex(c => /CURRENT_VALUE_IS_ESTIMATE/.test(c));
  assert.equal(params[i], 0);
});

test('a flag with no value never claims provenance for nothing', async () => {
  const { sql, params } = await captureInsert({ currentValueIsEstimate: true });
  const i = sql.split(',').findIndex(c => /CURRENT_VALUE_IS_ESTIMATE/.test(c));
  assert.equal(params[i], 0);
});

// The bug this class of test exists for: an INSERT whose placeholder count and
// param count disagree binds silently and shifts every column after the gap.
test('the create INSERT binds one param per placeholder', async () => {
  const { sql, params } = await captureInsert({ currentValue: 12, currentValueIsEstimate: true });
  const placeholders = (sql.match(/\?/g) || []).length;
  assert.equal(placeholders, params.length,
    `${placeholders} placeholders vs ${params.length} params — columns are shifted`);
});

// The QR-collision retry used to carry a second, divergent copy of the INSERT
// that omitted CURRENT_VALUE, so a collision silently discarded the value.
test('a QR collision retries with the SAME columns, losing nothing', async () => {
  Audit.init({ db: { query: async () => [] }, logger: noop });
  const inserts = [];
  Items.init({
    db: {
      query: async (sql, params) => {
        if (/^\s*INSERT INTO TALLY\.items/i.test(sql)) {
          inserts.push({ sql, params });
          if (inserts.length === 1) {
            const err = new Error('Duplicate entry for key uq_items_qr_code');
            err.code = 'ER_DUP_ENTRY';
            throw err;
          }
          return { insertId: 2 };
        }
        if (/PROPERTY_ID/i.test(sql)) return [{ PROPERTY_ID: 1 }];
        return [{ ID: 2, NAME: 'x', CONTAINER_ID: 1 }];
      },
    },
    logger: noop,
  });

  await Items.create(
    { containerId: 1, name: 'Mug', purchasePrice: 30, currentValue: 12, currentValueIsEstimate: true },
    42,
  );

  assert.equal(inserts.length, 2, 'expected one retry');
  assert.equal(inserts[0].sql, inserts[1].sql, 'retry uses a different statement — they will drift');
  // Everything but the QR code survives the retry.
  const strip = (p) => p.filter((v) => !/^TLY-/.test(String(v)));
  assert.deepEqual(strip(inserts[1].params), strip(inserts[0].params));
});

// ── update ────────────────────────────────────────────────────────────────

/** Runs Items.update and returns the UPDATE's sql + params. */
async function captureUpdate(data) {
  Audit.init({ db: { query: async () => [] }, logger: noop });
  let update = null;
  Items.init({
    db: {
      query: async (sql, params) => {
        if (/^\s*UPDATE TALLY\.items SET/i.test(sql)) { update = { sql, params }; return { affectedRows: 1 }; }
        if (/PROPERTY_ID/i.test(sql)) return [{ PROPERTY_ID: 1 }];
        return [{ ID: 1, NAME: 'x', CONTAINER_ID: 1 }];
      },
    },
    logger: noop,
  });
  await Items.update(1, data, 42);
  return update;
}

test('typing a value by hand clears the estimate flag', async () => {
  const { sql } = await captureUpdate({ currentValue: 40 });
  assert.match(sql, /CURRENT_VALUE = \?/);
  assert.match(sql, /CURRENT_VALUE_IS_ESTIMATE = 0/,
    'a corrected value still reads as an estimate');
});

test('an update that does not touch the value leaves provenance alone', async () => {
  const { sql } = await captureUpdate({ name: 'Renamed' });
  assert.doesNotMatch(sql, /CURRENT_VALUE/);
});

test('the estimate flag is not settable through update', () => {
  const { updateItem } = require('../src/modules/inventory/items.schema');
  const { error } = updateItem.validate({ currentValueIsEstimate: true });
  assert.ok(error, 'a client can mark its own guess as declared, or vice versa');
});

// ── the report ────────────────────────────────────────────────────────────

/** Runs insuranceSummary over one fabricated row and returns the mapped item. */
async function basisOf(row) {
  Reports.init({
    db: { query: async () => [{ ITEM_ID: 1, ITEM_NAME: 'Mug', AREA_NAME: 'A', CONTAINER_NAME: 'C', ...row }] },
    logger: noop,
    config: {},
  });
  const [item] = await Reports.insuranceSummary(1);
  return item;
}

test('a hand-entered value reports as declared', async () => {
  const item = await basisOf({ PURCHASE_PRICE: '30.00', CURRENT_VALUE: '12.00', CURRENT_VALUE_IS_ESTIMATE: 0 });
  assert.equal(item.valueBasis, 'declared');
  assert.equal(item.currentValue, 12);
});

test('a kept AI guess reports as estimated', async () => {
  const item = await basisOf({ PURCHASE_PRICE: null, CURRENT_VALUE: '12.00', CURRENT_VALUE_IS_ESTIMATE: 1 });
  assert.equal(item.valueBasis, 'estimated');
});

test('depreciation still wins over a stored value, and says so', async () => {
  const item = await basisOf({
    PURCHASE_PRICE: '100.00', CURRENT_VALUE: '12.00', CURRENT_VALUE_IS_ESTIMATE: 1,
    DEPRECIATION_ENABLED: 1, ITEM_DEPRECIATION_RATE: '0.2000',
    ITEM_CREATED_AT: new Date('2024-01-01'),
  });
  assert.equal(item.valueBasis, 'depreciated');
  assert.notEqual(item.currentValue, 12, 'the stored value should not have been used');
});

// The quietest of the four: an item with no current value reports its PURCHASE
// price in the Current Value column, overstating the total with nothing said.
test('a purchase-price fallback is labelled rather than passed off as current', async () => {
  const item = await basisOf({ PURCHASE_PRICE: '30.00', CURRENT_VALUE: null });
  assert.equal(item.valueBasis, 'purchase');
  assert.equal(item.currentValue, 30);
});

test('an item with no money at all has no basis to report', async () => {
  const item = await basisOf({ PURCHASE_PRICE: null, CURRENT_VALUE: null });
  assert.equal(item.valueBasis, null);
});

// ── the exports ───────────────────────────────────────────────────────────

test('every basis the report can produce has a PDF mark and none prints undefined', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/modules/reports/reports.service.js'), 'utf8');
  for (const basis of ['declared', 'estimated', 'depreciated', 'purchase']) {
    assert.match(src, new RegExp(`${basis}:\\s*'`), `BASIS_MARK has no entry for ${basis}`);
  }
});

test('the insurance CSV carries provenance as its own column', () => {
  const csv = Reports.generateCsv('insurance', [
    { itemName: 'Mug', currentValue: 12, valueBasis: 'estimated' },
  ]);
  assert.match(csv.split('\n')[0], /Value Basis/);
  assert.match(csv, /estimated/);
});

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Items = require('../src/modules/inventory/items.service');
const Reports = require('../src/modules/reports/reports.service');
const Audit = require('../src/modules/audit/audit.service');
const { GROUP_BY } = require('../src/modules/reports/reports.schema');

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
  // create() now checks-and-writes inside one transaction (#88), so the mock
  // db exposes withTransaction; the catch-all row also answers the container
  // liveness lock with a live row.
  const query = async (sql, params) => {
    if (/^\s*INSERT INTO TALLY\.items/i.test(sql)) {
      insert = { sql, params };
      return { insertId: 1 };
    }
    if (/PROPERTY_ID/i.test(sql)) return [{ PROPERTY_ID: 1 }];
    return [{ ID: 1, NAME: 'x', CONTAINER_ID: 1 }];
  };
  Items.init({
    db: { query, withTransaction: async (fn) => fn({ query }) },
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
  const query = async (sql, params) => {
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
  };
  Items.init({
    db: { query, withTransaction: async (fn) => fn({ query }) },
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

/**
 * #310, same shape of bug on the same document: a join that MULTIPLIES.
 *
 * `insuranceSummary` LEFT JOINs `item_dates` (DATE_TYPE is free text a user
 * types — nothing stops two rows saying "Purchased") and a `condition_snapshots`
 * subquery keyed on `MAX(CREATED_AT)` (a DATETIME tie returns both rows). Either
 * one fans a single item out into several, and the item then prints twice with
 * its value added to the band twice — on the report you hand an insurer.
 *
 * Both fan-outs at once, on one $1,400 laptop: 2 date rows × 2 tied snapshots =
 * 4 rows for one item. The service de-duplicates on ITEM_ID, so the fix holds
 * regardless of what any future join does. Delete that `seen` Set and this test
 * fails — nothing else in the suite would.
 */
test('a join that fans one item out still reports one item, once', async () => {
  const base = {
    ITEM_ID: 7, ITEM_NAME: 'Dell XPS 15', AREA_NAME: 'Study', CONTAINER_NAME: 'Desk',
    PURCHASE_PRICE: '1400.00', CURRENT_VALUE: '1400.00', CURRENT_VALUE_IS_ESTIMATE: 0,
    COMPLETENESS: 'complete',
  };
  const rows = [
    // Two "Purchased" dates × two condition snapshots sharing one CREATED_AT.
    { ...base, PURCHASE_DATE: new Date('2024-03-01'), LATEST_CONDITION: 'good' },
    { ...base, PURCHASE_DATE: new Date('2024-03-01'), LATEST_CONDITION: 'fair' },
    { ...base, PURCHASE_DATE: new Date('2025-11-20'), LATEST_CONDITION: 'good' },
    { ...base, PURCHASE_DATE: new Date('2025-11-20'), LATEST_CONDITION: 'fair' },
  ];
  Reports.init({ db: { query: async () => rows }, logger: noop, config: {} });

  const items = await Reports.insuranceSummary(1);
  assert.equal(items.length, 1, 'the laptop was reported four times — one row per join combination');

  // The band's two figures, computed exactly as _renderInsurancePdf computes
  // them: the fan-out reported a two-laptop, $2,800 study.
  const counted = items.filter(i => i.completeness === 'complete');
  assert.equal(counted.reduce((s, i) => s + (i.currentValue || 0), 0), 1400);
  assert.equal(counted.reduce((s, i) => s + (i.purchasePrice || 0), 0), 1400);

  // …and the CSV a spreadsheet sums has one data row, not four.
  const lines = Reports.generateCsv('insurance', items).trim().split('\n');
  assert.equal(lines.length, 2, `expected a header and ONE row, got ${lines.length - 1} rows`);
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

// ── completeness: box / spares only ───────────────────────────────────────

/**
 * Scanning a retail box files it under the product's name AND its catalogue
 * price, while the thing itself is in use elsewhere. These hold the line that
 * such a row never counts toward an insured total.
 */

test('create stores what is actually in the bin', async () => {
  const { sql, params } = await captureInsert({ completeness: 'box_only' });
  const i = sql.split(',').findIndex(c => /COMPLETENESS/.test(c));
  assert.ok(i >= 0, 'COMPLETENESS not in the column list');
  assert.equal(params[i], 'box_only');
});

test('create defaults to the whole thing being present', async () => {
  const { sql, params } = await captureInsert({});
  const i = sql.split(',').findIndex(c => /COMPLETENESS/.test(c));
  assert.equal(params[i], 'complete');
});

test('an item can be corrected back to complete', async () => {
  const { sql, params } = await captureUpdate({ completeness: 'complete' });
  assert.match(sql, /COMPLETENESS = \?/);
  assert.ok(params.includes('complete'));
});

test('the enum is closed — a typo cannot reach the column', () => {
  const { createItem } = require('../src/modules/inventory/items.schema');
  assert.ok(createItem.validate({ containerId: 1, name: 'x', completeness: 'box' }).error);
  assert.ok(createItem.validate({ containerId: 1, name: 'x', completeness: 'boxes_only' }).error);
});

test('a box is reported, but its value is not counted', async () => {
  Reports.init({
    db: {
      query: async () => [
        { ITEM_ID: 1, ITEM_NAME: 'Cordless Drill', AREA_NAME: 'A', CONTAINER_NAME: 'C',
          PURCHASE_PRICE: '189.00', CURRENT_VALUE: '142.00', COMPLETENESS: 'complete' },
        { ITEM_ID: 2, ITEM_NAME: 'Dell XPS 15', AREA_NAME: 'A', CONTAINER_NAME: 'C',
          PURCHASE_PRICE: '1400.00', CURRENT_VALUE: '1400.00', COMPLETENESS: 'box_only' },
      ],
    },
    logger: noop,
    config: {},
  });
  const items = await Reports.insuranceSummary(1);

  // The box is still listed — you want to know it is in that tote.
  assert.equal(items.length, 2);
  assert.equal(items[1].completeness, 'box_only');

  // But a total built from this data must skip it. This mirrors the filter in
  // _renderInsurancePdf; if that filter is dropped the assertion below is what
  // catches a claim overstated by the price of a whole machine.
  const { PARTIAL } = require('../src/modules/inventory/items.schema');
  const counted = items.filter(i => !PARTIAL.includes(i.completeness));
  assert.equal(counted.length, 1);
  assert.equal(counted.reduce((s, i) => s + (i.currentValue || 0), 0), 142);
});

test('the PDF renderer excludes partial rows from both totals', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/modules/reports/reports.service.js'), 'utf8');
  const body = src.slice(src.indexOf('_renderInsurancePdf'));
  assert.match(body, /const counted = items\.filter\(i => !_isPartial\(i\)\)/,
    'totals are no longer computed from a filtered list');
  for (const total of ['totalPurchase', 'totalCurrent']) {
    assert.match(body, new RegExp(`const ${total} = counted\\.reduce`),
      `${total} is summed over every row, including boxes`);
  }
});

test('PARTIAL never silently includes complete', () => {
  const { COMPLETENESS, PARTIAL } = require('../src/modules/inventory/items.schema');
  assert.ok(!PARTIAL.includes('complete'), 'every whole item would drop out of the totals');
  assert.equal(PARTIAL.length, COMPLETENESS.length - 1);
});

test('the insurance CSV carries completeness, so a spreadsheet total agrees', () => {
  const csv = Reports.generateCsv('insurance', [
    { itemName: 'Dell XPS 15', currentValue: 1400, completeness: 'box_only' },
  ]);
  assert.match(csv.split('\n')[0], /Completeness/);
  assert.match(csv, /box_only/);
});

// ── total value agrees with the insurance summary ─────────────────────────

/**
 * Runs totalValue over fabricated item rows and returns the single group.
 *
 * Each row is one item, so each gets an id: since #310 the service keys on
 * `ITEM_ID` to make its value set a SET — a duplicated row is a join fanning
 * out, not a second thing you own.
 */
async function totalOf(rows, groupBy = 'property') {
  const items = rows.map((r, i) => ({ ITEM_ID: i + 1, ...r }));
  Reports.init({ db: { query: async () => items }, logger: noop, config: {} });
  const { groups } = await Reports.totalValue(1, { groupBy });
  return groups[0];
}

test('total value skips box/spares rows, as the insurance summary does', async () => {
  // The two reports describing the same property must not disagree about what
  // it is worth. This counted boxes at full price until now.
  const group = await totalOf([
    { PURCHASE_PRICE: '189.00', CURRENT_VALUE: '142.00', COMPLETENESS: 'complete' },
    { PURCHASE_PRICE: '1400.00', CURRENT_VALUE: '1400.00', COMPLETENESS: 'box_only' },
  ]);
  assert.equal(group.currentTotal, 142);
  assert.equal(group.purchaseTotal, 189);
});

test('an excluded row is counted and reported, not silently dropped', async () => {
  const group = await totalOf([
    { PURCHASE_PRICE: '189.00', CURRENT_VALUE: '142.00', COMPLETENESS: 'complete' },
    { PURCHASE_PRICE: '1400.00', CURRENT_VALUE: '1400.00', COMPLETENESS: 'box_only' },
    { PURCHASE_PRICE: '30.00', CURRENT_VALUE: null, COMPLETENESS: 'accessories_only' },
  ]);
  assert.equal(group.itemCount, 1, 'an excluded row still counted toward itemCount');
  assert.equal(group.excludedCount, 2);
});

test('rows predating the completeness column still count', async () => {
  // COMPLETENESS is NOT NULL DEFAULT 'complete', but a fake/legacy row may
  // arrive undefined. Treating that as partial would zero the whole report.
  const group = await totalOf([
    { PURCHASE_PRICE: '50.00', CURRENT_VALUE: '40.00' },
  ]);
  assert.equal(group.currentTotal, 40);
  assert.equal(group.itemCount, 1);
  assert.equal(group.excludedCount, 0);
});

test('the total-value CSV carries the excluded count', () => {
  const csv = Reports.generateCsv('total_value', [
    { group: 'Garage', itemCount: 40, purchaseTotal: 8420, currentTotal: 6100, excludedCount: 2 },
  ]);
  assert.match(csv.split('\n')[0], /Excluded \(box\/spares\)/);
});

test('every totalValue grouping excludes packaging — asserted by running them', async () => {
  // This used to grep the source for three copies of `i.COMPLETENESS`, because
  // the grouping was three near-identical SELECTs and adding the column to two
  // of them would leave "by tag" quietly counting boxes. #310 collapsed those
  // into one query with the grouping key chosen in JS, so the honest form of
  // the same guard is to run every grouping the schema offers.
  const rows = [
    { PURCHASE_PRICE: '189.00', CURRENT_VALUE: '142.00', COMPLETENESS: 'complete' },
    { PURCHASE_PRICE: '1400.00', CURRENT_VALUE: '1400.00', COMPLETENESS: 'box_only' },
  ];
  for (const groupBy of GROUP_BY) {
    const items = rows.map((r, i) => ({ ITEM_ID: i + 1, ...r }));
    Reports.init({ db: { query: async () => items }, logger: noop, config: {} });
    const { totals } = await Reports.totalValue(1, { groupBy });
    assert.equal(totals.currentTotal, 142, `groupBy=${groupBy} counted packaging at full value`);
    assert.equal(totals.excludedCount, 1, `groupBy=${groupBy} lost the exclusion`);
  }
});

const test = require('node:test');
const assert = require('node:assert');
const Reports = require('../src/modules/reports/reports.service');
const { GROUP_BY } = require('../src/modules/reports/reports.schema');

// #310 — a Total Value report grouped by tag INNER JOINed entity_tags, so an
// item carrying three tags was counted three times and an item carrying none
// was dropped from the report entirely. The grand total could be inflated and
// incomplete at once, and the renderer produced it by summing the groups, so
// nothing in the document disagreed with itself.
//
// This suite is the guard that makes that un-reintroducible, in the spirit of
// the contract test #287 added for the report ids: the invariant is asserted
// across EVERY groupBy the Joi enum offers, read from the enum itself, so a
// grouping added later is covered the day it is added.
//
// THE INVARIANT: the report's grand total is a fact about the property, not
// about the grouping. Change groupBy and only `groups` may change.

const noop = { warn() {}, info() {}, error() {} };

/**
 * One property, built so that every way this could go wrong is present at once.
 *
 * Values, all with DEPRECIATION_ENABLED off so the arithmetic is checkable by
 * eye: the drill's declared 90, the lamp's missing CURRENT_VALUE falling back
 * to its 50 purchase price, the vice's 20, the ladder's 10.
 */
const ITEMS = [
  // Three tags. The item the bug multiplied by three.
  { ITEM_ID: 1, AREA_NAME: 'Garage', ITEM_CONDITION: 'good', PURCHASE_PRICE: '100.00', CURRENT_VALUE: '90.00', COMPLETENESS: 'complete' },
  // No tags at all. The item the bug deleted.
  { ITEM_ID: 2, AREA_NAME: 'Office', ITEM_CONDITION: 'poor', PURCHASE_PRICE: '50.00', CURRENT_VALUE: null, COMPLETENESS: 'complete' },
  // One tag, and no condition recorded — a real hole, not a missing item.
  { ITEM_ID: 3, AREA_NAME: 'Garage', ITEM_CONDITION: null, PURCHASE_PRICE: '30.00', CURRENT_VALUE: '20.00', COMPLETENESS: 'complete' },
  // Packaging only: excluded from the money since #178, but still counted as
  // excluded so the exclusion is visible rather than silent.
  { ITEM_ID: 4, AREA_NAME: 'Garage', ITEM_CONDITION: 'fair', PURCHASE_PRICE: '999.00', CURRENT_VALUE: '999.00', COMPLETENESS: 'box_only' },
  // The SAME item twice, which is what a second row typed "Purchased" in
  // item_dates does to the LEFT JOIN. Same class of bug, different join.
  { ITEM_ID: 5, AREA_NAME: 'Office', ITEM_CONDITION: 'good', PURCHASE_PRICE: '10.00', CURRENT_VALUE: '10.00', COMPLETENESS: 'complete' },
  { ITEM_ID: 5, AREA_NAME: 'Office', ITEM_CONDITION: 'good', PURCHASE_PRICE: '10.00', CURRENT_VALUE: '10.00', COMPLETENESS: 'complete' },
];

const TAGS = [
  { ITEM_ID: 1, TAG_NAME: 'Insured' },
  { ITEM_ID: 1, TAG_NAME: 'Power tools' },
  { ITEM_ID: 1, TAG_NAME: 'Tools' },
  { ITEM_ID: 3, TAG_NAME: 'Tools' },
  { ITEM_ID: 4, TAG_NAME: 'Tools' },
];

/** What the property is actually worth: items 1, 2, 3, 5, each counted once. */
const TRUTH = Object.freeze({
  itemCount: 4,
  purchaseTotal: 190,   // 100 + 50 + 30 + 10
  currentTotal: 170,    // 90 + 50 (no current value → purchase price) + 20 + 10
  excludedCount: 1,     // the box
});

function useDb({ items = ITEMS, tags = TAGS } = {}) {
  Reports.init({
    db: { query: async (sql) => (/entity_tags/.test(sql) ? tags : items) },
    logger: noop,
    config: {},
  });
}

const sum = (rows, key) => rows.reduce((s, r) => s + (r[key] || 0), 0);

// ── the invariant ───────────────────────────────────────────────────────────

test('the grand total is the property, whatever the grouping — every groupBy', async () => {
  useDb();

  for (const groupBy of GROUP_BY) {
    const report = await Reports.totalValue(1, { groupBy });

    assert.deepEqual(
      {
        itemCount: report.totals.itemCount,
        purchaseTotal: report.totals.purchaseTotal,
        currentTotal: report.totals.currentTotal,
        excludedCount: report.totals.excludedCount,
      },
      TRUTH,
      `groupBy=${groupBy} does not total the property — this is #310`,
    );
  }
});

test('a grouping with no branch of its own cannot pass by collapsing to one bucket', async () => {
  // The totals above are invariant even for a groupBy nobody implemented,
  // because an unknown key falls through to the single 'Total' bucket — which
  // is precisely how `condition` shipped in the UI doing nothing for years
  // (#285). So: every grouping except `property` must actually group.
  useDb();

  for (const groupBy of GROUP_BY) {
    const { groups } = await Reports.totalValue(1, { groupBy });
    if (groupBy === 'property') {
      assert.deepEqual(groups.map(g => g.group), ['Total']);
    } else {
      assert.ok(groups.length > 1,
        `groupBy=${groupBy} produced ${groups.length} group(s) — it is not grouping by anything`);
      assert.ok(!groups.some(g => g.group === 'Total'),
        `groupBy=${groupBy} fell through to the property bucket`);
    }
  }
});

test('an empty property still answers the shape, with zeroes', async () => {
  useDb({ items: [], tags: [] });

  for (const groupBy of GROUP_BY) {
    const report = await Reports.totalValue(1, { groupBy });
    assert.deepEqual(report.groups, []);
    assert.equal(report.totals.itemCount, 0);
    assert.equal(report.totals.currentTotal, 0);
    assert.equal(report.overlapping, false);
  }
});

// ── grouped by tag: the two halves of the bug ───────────────────────────────

test('an item with three tags is listed under all three and owned once', async () => {
  useDb();
  const { groups, totals, overlapping } = await Reports.totalValue(1, { groupBy: 'tag' });

  const byName = Object.fromEntries(groups.map(g => [g.group, g]));
  assert.deepEqual(Object.keys(byName).sort(), ['Insured', 'Power tools', 'Tools', 'Untagged']);

  // Listed under each of its tags — that is what the reader asked to see.
  for (const tag of ['Insured', 'Power tools', 'Tools']) {
    assert.equal(byName[tag].itemCount >= 1, true, `${tag} lost the drill`);
  }
  assert.equal(byName.Tools.itemCount, 2);             // drill + vice
  assert.equal(byName.Tools.currentTotal, 110);        // 90 + 20
  assert.equal(byName.Insured.currentTotal, 90);
  assert.equal(byName['Power tools'].currentTotal, 90);

  // …and the subtotals therefore add up to more than the property is worth.
  // The report says so rather than pretending otherwise.
  assert.equal(sum(groups, 'currentTotal') > totals.currentTotal, true);
  assert.equal(overlapping, true);
  assert.equal(totals.currentTotal, TRUTH.currentTotal);
});

test('an untagged item lands in an explicit Untagged bucket instead of vanishing', async () => {
  useDb();
  const { groups } = await Reports.totalValue(1, { groupBy: 'tag' });
  const untagged = groups.find(g => g.group === 'Untagged');

  assert.ok(untagged, 'the untagged lamp is missing from the report entirely — this is #310');
  assert.equal(untagged.itemCount, 2);        // the lamp and the ladder
  assert.equal(untagged.currentTotal, 60);    // 50 + 10
});

test('a tagged box still counts as excluded in its tag, and in no total', async () => {
  useDb();
  const { groups, totals } = await Reports.totalValue(1, { groupBy: 'tag' });
  const tools = groups.find(g => g.group === 'Tools');

  assert.equal(tools.excludedCount, 1);
  assert.equal(totals.excludedCount, 1);
  assert.equal(tools.currentTotal, 110, 'the box\'s 999 leaked into a subtotal');
});

test('overlapping is measured, not assumed — single-tagged items do not overlap', async () => {
  useDb({ tags: [{ ITEM_ID: 1, TAG_NAME: 'Tools' }, { ITEM_ID: 3, TAG_NAME: 'Spares' }] });
  const { groups, totals, overlapping } = await Reports.totalValue(1, { groupBy: 'tag' });

  assert.equal(overlapping, false);
  assert.equal(sum(groups, 'currentTotal'), totals.currentTotal);
});

test('a property whose only multi-tagged thing is a BOX still reports the overlap', async () => {
  // Every counted item is single-tagged, so the money columns tally — but the
  // box carries two tags, and "Excluded (box/spares)" is a column of its own
  // that sums above the total row. An unqualified total row there would be the
  // same lie in a quieter column.
  useDb({
    tags: [
      { ITEM_ID: 1, TAG_NAME: 'Tools' },
      { ITEM_ID: 3, TAG_NAME: 'Spares' },
      { ITEM_ID: 4, TAG_NAME: 'Tools' },
      { ITEM_ID: 4, TAG_NAME: 'Spares' },
    ],
  });
  const { groups, totals, overlapping } = await Reports.totalValue(1, { groupBy: 'tag' });

  assert.equal(sum(groups, 'itemCount'), totals.itemCount, 'the counted items do NOT overlap here');
  assert.equal(sum(groups, 'excludedCount'), 2);
  assert.equal(totals.excludedCount, 1);
  assert.equal(overlapping, true, 'the excluded column overlaps and the report must say so');

  const last = Reports.generateCsv('total_value', { groups, totals, overlapping }).trim().split('\n').pop();
  assert.match(last, /groups above overlap/);
});

// ── the other groupings ─────────────────────────────────────────────────────

test('grouped by area, the groups partition the property exactly', async () => {
  useDb();
  const { groups, totals, overlapping } = await Reports.totalValue(1, { groupBy: 'area' });

  assert.deepEqual(groups.map(g => g.group).sort(), ['Garage', 'Office']);
  assert.equal(overlapping, false);
  assert.equal(sum(groups, 'itemCount'), totals.itemCount);
  assert.equal(sum(groups, 'currentTotal'), totals.currentTotal);
  // The duplicate row for item 5 is one item, in one area, once.
  assert.equal(groups.find(g => g.group === 'Office').itemCount, 2);
});

test('grouped by condition (#285), an unrated item is its own answer', async () => {
  useDb();
  const { groups, totals, overlapping } = await Reports.totalValue(1, { groupBy: 'condition' });

  // Title-cased: the column is ENUM('new','good','fair','poor'), and a
  // lowercase `poor` beside `Unrated` on an insurer's page reads as a different
  // kind of label rather than the same one.
  const byName = Object.fromEntries(groups.map(g => [g.group, g]));
  assert.deepEqual(Object.keys(byName).sort(), ['Fair', 'Good', 'Poor', 'Unrated']);
  assert.equal(byName.Good.itemCount, 2);        // drill + ladder
  assert.equal(byName.Good.currentTotal, 100);   // 90 + 10
  assert.equal(byName.Poor.currentTotal, 50);
  assert.equal(byName.Unrated.currentTotal, 20);
  // The box is 'fair' — present as an exclusion, absent from the money.
  assert.equal(byName.Fair.itemCount, 0);
  assert.equal(byName.Fair.excludedCount, 1);
  assert.equal(byName.Fair.currentTotal, 0);

  assert.equal(overlapping, false);
  assert.equal(sum(groups, 'currentTotal'), totals.currentTotal);
});

test('grouped by property, the one group IS the total', async () => {
  useDb();
  const { groups, totals } = await Reports.totalValue(1, { groupBy: 'property' });

  assert.equal(groups.length, 1);
  assert.equal(groups[0].group, 'Total');
  assert.equal(groups[0].currentTotal, totals.currentTotal);
  assert.equal(groups[0].itemCount, totals.itemCount);
});

test('the tag lookup is not run at all for the groupings that cannot use it', async () => {
  const seen = [];
  Reports.init({
    db: { query: async (sql) => { seen.push(/entity_tags/.test(sql) ? 'tags' : 'items'); return /entity_tags/.test(sql) ? TAGS : ITEMS; } },
    logger: noop,
    config: {},
  });

  await Reports.totalValue(1, { groupBy: 'area' });
  assert.deepEqual(seen, ['items']);

  seen.length = 0;
  await Reports.totalValue(1, { groupBy: 'tag' });
  assert.deepEqual(seen, ['items', 'tags']);
});

// ── what the documents say ──────────────────────────────────────────────────

test('the CSV carries the property total as its own labelled row', async () => {
  useDb();
  const report = await Reports.totalValue(1, { groupBy: 'tag' });
  const csv = Reports.generateCsv('total_value', report);
  const lines = csv.trim().split('\n');
  const last = lines[lines.length - 1];

  // A spreadsheet is exactly where someone sums a column of overlapping
  // subtotals and believes the answer, so the honest number is in the file.
  assert.match(last, /^"?TOTAL \(each item once — groups above overlap\)"?,/);
  assert.match(last, /,4,190,170,1$/);
});

test('a non-overlapping grouping still gets a total row, without the warning', async () => {
  useDb();
  const csv = Reports.generateCsv('total_value', await Reports.totalValue(1, { groupBy: 'area' }));
  const last = csv.trim().split('\n').pop();

  assert.match(last, /^"?TOTAL \(each item once\)"?,/);
  assert.match(last, /,4,190,170,1$/);
});

test('the PDF renders for every grouping, overlap notice and all', async () => {
  useDb();
  for (const groupBy of GROUP_BY) {
    const report = await Reports.totalValue(1, { groupBy });
    const buf = await Reports.generatePdf('total_value', report, { propertyName: 'Home', scope: `by ${groupBy}` });
    assert.deepEqual(buf.subarray(0, 5), Buffer.from('%PDF-'), `groupBy=${groupBy} did not render`);
    assert.ok(buf.length > 2000, `groupBy=${groupBy} PDF suspiciously small`);
  }
});

test('the renderers survive the pre-#310 bare-array shape, and an empty one', async () => {
  // Nothing persists a report payload, so this is not a migration — but a
  // document that throws is the worst possible failure mode for the one report
  // you generate under pressure, and `generatePdf(type, [])` is how every
  // "renders with no rows" test calls in.
  const legacy = [{ group: 'Garage', itemCount: 3, purchaseTotal: 300, currentTotal: 200, excludedCount: 0 }];
  const buf = await Reports.generatePdf('total_value', legacy, {});
  assert.deepEqual(buf.subarray(0, 5), Buffer.from('%PDF-'));

  const csv = Reports.generateCsv('total_value', legacy).trim().split('\n');
  assert.match(csv[csv.length - 1], /^"?TOTAL \(each item once\)"?,3,300,200,0$/);

  const empty = await Reports.generatePdf('total_value', [], {});
  assert.deepEqual(empty.subarray(0, 5), Buffer.from('%PDF-'));
});

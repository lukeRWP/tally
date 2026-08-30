const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '../src/modules/reports/reports.service.js'),
  'utf8',
);

// DATE_TYPE is free text. The date form's own preset is "Purchased"
// (client/src/components/dates/date-form.tsx), so a join on 'purchase' matches
// nothing a user ever entered and every report's purchase date reads empty —
// a wrong answer that looks exactly like "no data".
test('no report joins the purchase date on a value the UI never writes', () => {
  const exact = SRC.match(/DATE_TYPE\s*=\s*'purchase'/g) || [];
  assert.deepEqual(exact, [], 'found an exact match on the singular form');
});

test('every purchase-date join accepts what the form actually writes', () => {
  // Two joins, not the original four: #310 collapsed totalValue's three
  // near-identical SELECTs (one per grouping) into a single query, leaving the
  // insurance summary and that one. What matters is that EVERY join present
  // matches what the date form writes — the count is only here so a silent
  // deletion of them all cannot pass.
  const joins = SRC.match(/id_purchase\.ITEM_ID = i\.ID AND [^\n]+/g) || [];
  assert.ok(joins.length >= 2, `expected the purchase joins, found ${joins.length}`);
  for (const j of joins) {
    assert.match(j, /LOWER\(id_purchase\.DATE_TYPE\)/, `not case-insensitive: ${j}`);
    assert.match(j, /'purchased'/, `does not accept the form's preset: ${j}`);
  }
});

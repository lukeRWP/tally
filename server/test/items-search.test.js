const test = require('node:test');
const assert = require('node:assert');
const Items = require('../src/modules/inventory/items.service');

function fakeDb(handler) { return { query: async (sql, params) => handler(sql, params) }; }
const logger = { warn() {}, info() {}, error() {} };

test('search returns each result with its location names (Where is X? needs where)', async () => {
  let sql = '', params = null;
  Items.init({ db: fakeDb((s, p) => { sql = s; params = p; return [{
    ID: 7, CONTAINER_ID: 5, NAME: 'Cordless Drill', QR_CODE: 'TLY-I-1', STATUS: 'active',
    CONTAINER_NAME: 'Bin 4', AREA_NAME: 'Garage', PROPERTY_NAME: 'Home',
  }]; }), logger });

  const out = await Items.search('drill', 42, {});
  assert.match(sql, /pr\.NAME AS PROPERTY_NAME/, 'selects the property name');
  assert.match(sql, /a\.NAME AS AREA_NAME/, 'selects the area name');
  assert.match(sql, /c\.NAME AS CONTAINER_NAME/, 'selects the container name');
  assert.match(sql, /JOIN TALLY\.properties pr/, 'joins properties for the name');
  assert.match(sql, /pm\.USER_ID = \?/, 'stays membership-scoped');
  assert.equal(params[0], 42, 'userId bound first');
  assert.deepEqual(out[0].location, { property: 'Home', area: 'Garage', container: 'Bin 4' });
});

test('search omits the status clause entirely when no status filter is given (All)', async () => {
  let sql = '';
  Items.init({ db: fakeDb((s) => { sql = s; return []; }), logger });
  await Items.search('drill', 42, {});
  assert.ok(!/i\.STATUS = \?/.test(sql), 'no status restriction means lent/removed items are findable');
});

// ── tagIds filter: ALL-of, not any-of (#99) ─────────────────────────────────
//
// CLAUDE.md documents the contract: "filter results to items that have all
// specified tags." The query used to implement any-of (a plain
// `et.TAG_ID IN (?)` after the join, deduped with SELECT DISTINCT) — an item
// with just ONE of the requested tags would wrongly match. These tests pin
// the SQL shape that makes it all-of (a correlated HAVING COUNT(DISTINCT) =
// tagIds.length) and, since this fake db is a stand-in for MySQL rather than
// a real one, also pin that the service asks for exactly that: the right
// tag ids and the right required count bound as params.

test('two-tag filter asks the DB for ALL of the requested tags, not any one of them', async () => {
  let sql = '', params = null;
  Items.init({ db: fakeDb((s, p) => { sql = s; params = p; return []; }), logger });

  await Items.search('drill', 42, { tagIds: [10, 20] });

  assert.match(
    sql,
    /HAVING COUNT\(DISTINCT et2\.TAG_ID\) = \?/,
    'requires a count of matched tags, not merely at least one'
  );
  assert.match(sql, /et2\.TAG_ID IN \(\?\)/, 'the correlated count is scoped to the requested tag ids');
  assert.match(sql, /GROUP BY et2\.ENTITY_ID/, 'grouped per item so the count is per-item');

  // Both the tagIds array and the required count (2, i.e. tagIds.length) must
  // be bound — an any-of regression would drop the count param entirely.
  assert.ok(params.some(p => Array.isArray(p) && p.length === 2 && p[0] === 10 && p[1] === 20),
    'tag ids are bound for the correlated subquery');
  assert.ok(params.includes(2), 'required match count (tagIds.length) is bound');
});

test('two-tag filter returns only the item carrying BOTH tags, not the one carrying only one', async () => {
  const itemBoth = { ID: 1, CONTAINER_ID: 5, NAME: 'Both Tags Item', STATUS: 'active' };
  const itemOne = { ID: 2, CONTAINER_ID: 5, NAME: 'One Tag Item', STATUS: 'active' };
  // Tag membership the real query's correlated subquery would compute against.
  const itemTags = { 1: [10, 20], 2: [10] };

  Items.init({
    db: fakeDb((sql, params) => {
      const havingMatch = /HAVING COUNT\(DISTINCT et2\.TAG_ID\) = \?/.test(sql);
      assert.ok(havingMatch, 'query must express all-of via a count HAVING clause');
      const tagIdsParam = params.find(p => Array.isArray(p));
      const requiredCount = params[params.length - 1];
      const passes = (id) => {
        const tags = itemTags[id] || [];
        const matched = new Set(tags.filter(t => tagIdsParam.includes(t)));
        return matched.size === requiredCount;
      };
      return [itemBoth, itemOne].filter(row => passes(row.ID));
    }),
    logger,
  });

  const out = await Items.search('drill', 42, { tagIds: [10, 20] });

  assert.equal(out.length, 1, 'only the item carrying both requested tags is returned');
  assert.equal(out[0].id, 1);
});

test('single-tag filter is unchanged: an item carrying that one tag still matches', async () => {
  let sql = '', params = null;
  const itemRow = { ID: 3, CONTAINER_ID: 5, NAME: 'Tagged Item', STATUS: 'active' };
  Items.init({
    db: fakeDb((s, p) => { sql = s; params = p; return [itemRow]; }),
    logger,
  });

  const out = await Items.search('drill', 42, { tagIds: [10] });

  // For a single tag, ALL-of and ANY-of agree — the count required is 1.
  assert.ok(params.includes(1), 'required match count for a single tag is 1');
  assert.match(sql, /HAVING COUNT\(DISTINCT et2\.TAG_ID\) = \?/);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 3);
});

test('tag filter composes with condition and status filters', async () => {
  let sql = '', params = null;
  Items.init({ db: fakeDb((s, p) => { sql = s; params = p; return []; }), logger });

  await Items.search('drill', 42, { tagIds: [10, 20], condition: 'good', status: 'active' });

  assert.match(sql, /i\.`CONDITION` = \?/, 'condition filter still applies alongside tags');
  assert.match(sql, /i\.STATUS = \?/, 'status filter still applies alongside tags');
  assert.match(sql, /HAVING COUNT\(DISTINCT et2\.TAG_ID\) = \?/, 'tag all-of filter still applies alongside the others');
  assert.ok(params.includes('good'));
  assert.ok(params.includes('active'));
  assert.ok(params.includes(2));
});

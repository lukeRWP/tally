const test = require('node:test');
const assert = require('node:assert');
const Labels = require('../src/modules/labels/labels.service');
const schema = require('../src/modules/labels/labels.schema');

// Same fakeDb pattern as lending.test.js: a scriptable query() so we can both
// capture the SQL/params and script the returned rows without a real DB.
function fakeDb(handler) {
  return { query: async (sql, params) => handler(sql, params) };
}
const logger = { warn() {}, info() {}, error() {} };
const config = { clientUrl: 'https://tally.example' };

// ── getEntityData — cross-property IDOR guard ───────────────────────────────

test('getEntityData scopes every entity type to the caller via property_members', async () => {
  for (const type of ['item', 'container', 'area']) {
    let sql = '';
    let params = null;
    Labels.init({ db: fakeDb((s, p) => { sql = s; params = p; return []; }), logger, config });
    await Labels.getEntityData(type, [1, 2, 3], 42);
    assert.match(sql, /property_members/, `${type} query joins property_members`);
    assert.match(sql, /pm\.USER_ID = \?/, `${type} query binds userId in the membership join`);
    assert.equal(params[0], 42, `${type}: userId is bound first`);
    assert.deepEqual(params.slice(1), [1, 2, 3], `${type}: entity ids follow userId`);
  }
});

test('getEntityData returns nothing for IDs the caller cannot access (no member rows)', async () => {
  Labels.init({ db: fakeDb(() => []), logger, config });
  const out = await Labels.getEntityData('item', [999], 42);
  assert.deepEqual(out, [], 'out-of-scope IDs yield an empty result (route then 404s)');
});

// ── resolveCode — cross-property QR-resolution IDOR guard ───────────────────

test('resolveCode scopes to the caller and hides foreign/unknown codes', async () => {
  let sql = '';
  let params = null;
  Labels.init({ db: fakeDb((s, p) => { sql = s; params = p; return []; }), logger, config });
  const res = await Labels.resolveCode('TLY-I-ABC123', 42);
  assert.match(sql, /property_members/, 'resolveCode joins property_members');
  assert.match(sql, /pm\.USER_ID = \?/, 'resolveCode binds userId');
  assert.equal(params[0], 42, 'userId bound first');
  assert.deepEqual(res, { type: 'item', id: null, name: null, exists: false },
    'a code in a property the caller is not a member of resolves to not-found');
});

test('resolveCode returns the entity when the caller is a member', async () => {
  Labels.init({ db: fakeDb(() => [{ ID: 7, NAME: 'Drill' }]), logger, config });
  const res = await Labels.resolveCode('TLY-I-ABC123', 42);
  assert.deepEqual(res, { type: 'item', id: 7, name: 'Drill', exists: true });
});

test('resolveCode rejects a malformed code without touching the db', async () => {
  let queried = false;
  Labels.init({ db: fakeDb(() => { queried = true; return []; }), logger, config });
  const res = await Labels.resolveCode('not-a-code', 42);
  assert.equal(res.exists, false);
  assert.equal(queried, false, 'no db query for an unparseable code');
});

// ── generateLabels schema — preset field ─────────────────────────────────

test('generateLabels accepts a preset and defaults to small', () => {
  const ok = schema.generateLabels.validate({ entityType: 'item', entityIds: [1] });
  assert.equal(ok.error, undefined);
  assert.equal(ok.value.preset, 'small');
  assert.equal(schema.generateLabels.validate({ entityType: 'container', entityIds: [1], preset: 'medium' }).error, undefined);
});

test('generateLabels rejects an unknown preset', () => {
  assert.ok(schema.generateLabels.validate({ entityType: 'item', entityIds: [1], preset: 'giant' }).error);
});

test('generateLabels rejects large for items (container/area only)', () => {
  assert.ok(schema.generateLabels.validate({ entityType: 'item', entityIds: [1], preset: 'large' }).error);
  assert.equal(schema.generateLabels.validate({ entityType: 'container', entityIds: [1], preset: 'large' }).error, undefined);
  assert.equal(schema.generateLabels.validate({ entityType: 'area', entityIds: [1], preset: 'large' }).error, undefined);
});

// ── getEntityData — parentZone per entity type ──────────────────────────────

test('getEntityData exposes parentZone per type (Area for container, Property for area)', async () => {
  Labels.init({ db: fakeDb((sql) => {
    if (/FROM TALLY\.containers c/i.test(sql)) return [{ ID: 5, NAME: 'Camping Gear', QR_CODE: 'TLY-C-1', AREA_NAME: 'Garage', PROPERTY_NAME: 'Home' }];
    return [];
  }), logger, config });
  const [c] = await Labels.getEntityData('container', [5], 42);
  assert.equal(c.parentZone, 'Garage');   // banner
  assert.equal(c.breadcrumb, 'Home');     // header remainder

  Labels.init({ db: fakeDb((sql) => {
    if (/FROM TALLY\.areas a/i.test(sql)) return [{ ID: 3, NAME: 'Garage', QR_CODE: 'TLY-A-1', PROPERTY_NAME: 'Home' }];
    return [];
  }), logger, config });
  const [a] = await Labels.getEntityData('area', [3], 42);
  assert.equal(a.parentZone, 'Home');
  assert.equal(a.breadcrumb, '');
});

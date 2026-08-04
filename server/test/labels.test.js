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

// ── _fullLocation — Avery sheet recombines breadcrumb + parentZone ──────────

// REGRESSION GUARD: the redesign split the location path across `breadcrumb`
// (ancestors) and `parentZone` (the thermal banner zone). The Avery sheet has
// no banner, so it must print the recombined path — printing `breadcrumb`
// alone silently dropped the Area from container labels and left area labels
// with no location line at all.
test('_fullLocation recombines breadcrumb + parentZone for every entity type', () => {
  assert.equal(
    Labels._fullLocation({ parentZone: null, breadcrumb: 'Home > Garage > Bin 4' }),
    'Home > Garage > Bin 4', 'item: full path already in breadcrumb');
  assert.equal(
    Labels._fullLocation({ parentZone: 'Garage', breadcrumb: 'Home' }),
    'Home > Garage', 'container: property then area');
  assert.equal(
    Labels._fullLocation({ parentZone: 'Home', breadcrumb: '' }),
    'Home', 'area: property only, no leading separator');
  assert.equal(
    Labels._fullLocation({ parentZone: null, breadcrumb: '' }), '',
    'nothing to show yields an empty string (renderer skips the line)');
});

// ── renderLabelPdf — thermal single-label rendering (small/medium) ──────────

function pdfPageCount(buf) { return (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length; }

test('renderLabelPdf makes one page per entity and is a PDF', async () => {
  Labels.init({ db: fakeDb(() => []), logger, config });
  const entities = [
    { id: 1, name: 'Cordless Drill', qrCode: 'TLY-I-3A9F2C', parentZone: null, breadcrumb: 'Home > Garage > Bin 4' },
    { id: 2, name: 'Circular Saw', qrCode: 'TLY-I-7B2E1D', parentZone: null, breadcrumb: 'Home > Garage > Bin 4' },
  ];
  const buf = await Labels.renderLabelPdf(entities, 'small');
  assert.ok(Buffer.isBuffer(buf) && buf.slice(0, 4).toString() === '%PDF');
  assert.equal(pdfPageCount(buf), 2);

  const med = await Labels.renderLabelPdf(
    [{ id: 5, name: 'Holiday Decorations', qrCode: 'TLY-C-8B1E2D', parentZone: 'Garage', breadcrumb: 'Home' }], 'medium');
  assert.ok(med.slice(0, 4).toString() === '%PDF');
  assert.equal(pdfPageCount(med), 1);
});

// ── Contents manifest (large) ────────────────────────────────────────────

test('manifestPageCount paginates by the large preset row capacity', () => {
  const n1 = Labels.manifestPageCount(1, 'large');
  const many = Labels.manifestPageCount(500, 'large');
  assert.equal(n1, 1);
  assert.ok(many > 1, 'a long list spans multiple pages');
  assert.equal(Labels.manifestPageCount(0, 'large'), 1, 'empty manifest is still one page');
});

test('getManifest is membership-scoped and returns name+qty rows for a container', async () => {
  let itemSql = '';
  Labels.init({ db: fakeDb((sql, params) => {
    if (/FROM TALLY\.containers c/i.test(sql) && /property_members/i.test(sql) && /IN \(/i.test(sql))
      return [{ ID: 5, NAME: 'Camping Gear', QR_CODE: 'TLY-C-1', AREA_NAME: 'Garage', PROPERTY_NAME: 'Home' }]; // getEntityData header
    if (/FROM TALLY\.items i/i.test(sql)) { itemSql = sql; return [{ name: 'Tent', qty: 1 }, { name: 'Lantern', qty: 2 }]; }
    return [];
  }), logger, config });
  const m = await Labels.getManifest('container', 5, 42);
  assert.equal(m.header.name, 'Camping Gear');
  assert.deepEqual(m.rows, [{ name: 'Tent', qty: 1 }, { name: 'Lantern', qty: 2 }]);
  assert.match(itemSql, /property_members/i, 'the manifest item query is membership-scoped');
  assert.match(itemSql, /pm\.USER_ID = \?/i);
});

test('getManifest returns null for an entity the caller does not own', async () => {
  Labels.init({ db: fakeDb(() => []), logger, config }); // getEntityData yields no header
  assert.equal(await Labels.getManifest('container', 999, 42), null);
});

test('renderManifestPdf produces a PDF (paginated by row count)', async () => {
  Labels.init({ db: fakeDb(() => []), logger, config });
  const rows = Array.from({ length: 60 }, (_, i) => ({ name: `Item ${i + 1}`, qty: (i % 3) + 1 }));
  const buf = await Labels.renderManifestPdf(
    { header: { name: 'Camping Gear', qrCode: 'TLY-C-1', parentZone: 'Garage', breadcrumb: 'Home' }, rows }, 'large');
  assert.ok(buf.slice(0, 4).toString() === '%PDF');
  assert.equal(pdfPageCount(buf), Labels.manifestPageCount(60, 'large'));
});

test('renderManifestBundle concatenates several manifests into one PDF', async () => {
  Labels.init({ db: fakeDb(() => []), logger, config });
  const mk = (n, count) => ({ header: { name: n, qrCode: 'TLY-C-1', parentZone: 'Garage', breadcrumb: 'Home' },
    rows: Array.from({ length: count }, (_, i) => ({ name: `x${i}`, qty: 1 })) });
  const buf = await Labels.renderManifestBundle([mk('A', 3), mk('B', 3)], 'large');
  assert.ok(buf.slice(0, 4).toString() === '%PDF');
  // Two single-page manifests → two pages total (no blank leading page).
  assert.equal(pdfPageCount(buf), Labels.manifestPageCount(3, 'large') * 2);
});

test('generateZpl is removed from the service', () => {
  assert.equal(typeof Labels.generateZpl, 'undefined');
});

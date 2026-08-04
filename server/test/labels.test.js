const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
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

test('generateLabels defaults the preset per entity type (small item, medium bin/location)', () => {
  const def = (entityType) => schema.generateLabels.validate({ entityType, entityIds: [1] });
  assert.equal(def('item').error, undefined);
  assert.equal(def('item').value.preset, 'small', 'an item tag defaults to the 2x1 small preset');
  assert.equal(def('container').error, undefined);
  assert.equal(def('container').value.preset, 'medium', 'a container defaults to the 3x3 bin tag');
  assert.equal(def('area').error, undefined);
  assert.equal(def('area').value.preset, 'medium', 'an area defaults to the 3x3 location tag');
});

test('generateLabels rejects an unknown preset', () => {
  assert.ok(schema.generateLabels.validate({ entityType: 'item', entityIds: [1], preset: 'giant' }).error);
});

test('generateLabels rejects large for items (container/area only)', () => {
  assert.ok(schema.generateLabels.validate({ entityType: 'item', entityIds: [1], preset: 'large' }).error);
  assert.equal(schema.generateLabels.validate({ entityType: 'container', entityIds: [1], preset: 'large' }).error, undefined);
  assert.equal(schema.generateLabels.validate({ entityType: 'area', entityIds: [1], preset: 'large' }).error, undefined);
});

test('generateLabels still rejects the legacy format:"zpl" body', () => {
  // Spec §6: ZPL is gone. The schema is strict (no `.unknown(true)`), so a body
  // carrying the old field must be refused rather than silently ignored — this
  // guards against a future loosening quietly re-accepting ZPL requests.
  const zpl = schema.generateLabels.validate({ entityType: 'item', entityIds: [1], format: 'zpl' });
  assert.ok(zpl.error, 'a body with format:"zpl" is rejected');
  assert.match(zpl.error.message, /format/, 'the rejection names the offending field');
  assert.ok(schema.generateLabels.validate({ entityType: 'item', entityIds: [1], format: 'pdf' }).error,
    'even format:"pdf" is rejected — the field no longer exists at all');
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

test('getEntityData tags every row with its entity type (medium footer label)', async () => {
  const scripted = {
    item:      [{ ID: 1, NAME: 'Drill', QR_CODE: 'TLY-I-1', CONTAINER_NAME: 'Bin 4', AREA_NAME: 'Garage', PROPERTY_NAME: 'Home' }],
    container: [{ ID: 5, NAME: 'Camping Gear', QR_CODE: 'TLY-C-1', AREA_NAME: 'Garage', PROPERTY_NAME: 'Home' }],
    area:      [{ ID: 3, NAME: 'Garage', QR_CODE: 'TLY-A-1', PROPERTY_NAME: 'Home' }],
  };
  for (const type of ['item', 'container', 'area']) {
    Labels.init({ db: fakeDb(() => scripted[type]), logger, config });
    const [row] = await Labels.getEntityData(type, [1], 42);
    assert.equal(row.type, type, `${type} rows carry type:'${type}'`);
  }
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

// pdfkit deflates its content streams and writes text as hex inside `[...] TJ`
// arrays (split at kerning pairs), so the rendered strings are not greppable in
// the raw bytes. Inflate every stream and rebuild one string per drawn text
// run, with the baseline y it was placed at, so tests can assert on real
// rendered content rather than on byte size.
function pdfTextRuns(buf) {
  const src = buf.toString('latin1');
  const runs = [];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    const end = src.indexOf('endstream', start);
    if (end < 0) continue;
    let content;
    try { content = zlib.inflateSync(Buffer.from(src.slice(start, end), 'latin1')).toString('latin1'); }
    catch { continue; } // not a deflated content stream (e.g. an embedded PNG)
    for (const block of content.match(/BT[\s\S]*?ET/g) || []) {
      const hex = (block.match(/<([0-9a-fA-F]*)>/g) || []).map(h => h.slice(1, -1)).join('');
      if (!hex) continue;
      const tm = block.match(/1 0 0 1 ([-\d.]+) ([-\d.]+) Tm/);
      runs.push({ text: Buffer.from(hex, 'hex').toString('latin1'), y: tm ? Number(tm[2]) : null });
    }
  }
  return runs;
}
const pdfTextCount = (buf, needle) => pdfTextRuns(buf).filter(r => r.text.startsWith(needle)).length;

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

// Hard-coded so a geometry change that silently alters capacity fails here
// rather than being rubber-stamped by a test that derives its own expectation.
test('manifestPageCount pins the documented large-preset capacity of 22 rows/page', () => {
  assert.equal(Labels.manifestPageCount(22, 'large'), 1, '22 rows is exactly one full page');
  assert.equal(Labels.manifestPageCount(23, 'large'), 2, 'the 23rd row starts a second page');
  assert.equal(Labels.manifestPageCount(44, 'large'), 2);
  assert.equal(Labels.manifestPageCount(45, 'large'), 3);
});

test('getManifest is membership-scoped and returns name+qty rows for a container', async () => {
  let itemSql = '';
  let itemParams = null;
  Labels.init({ db: fakeDb((sql, params) => {
    if (/FROM TALLY\.containers c/i.test(sql) && /property_members/i.test(sql) && /IN \(/i.test(sql))
      return [{ ID: 5, NAME: 'Camping Gear', QR_CODE: 'TLY-C-1', AREA_NAME: 'Garage', PROPERTY_NAME: 'Home' }]; // getEntityData header
    if (/FROM TALLY\.items i/i.test(sql)) { itemSql = sql; itemParams = params; return [{ name: 'Tent', qty: 1 }, { name: 'Lantern', qty: 2 }]; }
    return [];
  }), logger, config });
  const m = await Labels.getManifest('container', 5, 42);
  assert.equal(m.header.name, 'Camping Gear');
  assert.deepEqual(m.rows, [{ name: 'Tent', qty: 1 }, { name: 'Lantern', qty: 2 }]);
  assert.match(itemSql, /property_members/i, 'the manifest item query is membership-scoped');
  assert.match(itemSql, /pm\.USER_ID = \?/i);
  // The binds matter as much as the SQL: swapping them would scope the
  // membership join by the container id and filter contents by the user id —
  // an IDOR the SQL-text assertions alone would happily pass.
  assert.equal(itemParams[0], 42, 'userId is bound first (into the membership join)');
  assert.equal(itemParams[1], 5, 'the container id is bound second (into the WHERE)');
});

test('getManifest is membership-scoped for an area and counts items per container', async () => {
  let containerSql = '';
  let containerParams = null;
  Labels.init({ db: fakeDb((sql, params) => {
    if (/FROM TALLY\.areas a/i.test(sql) && /IN \(/i.test(sql))
      return [{ ID: 3, NAME: 'Garage', QR_CODE: 'TLY-A-1', PROPERTY_NAME: 'Home' }]; // getEntityData header
    if (/FROM TALLY\.containers c/i.test(sql)) {
      containerSql = sql; containerParams = params;
      return [{ name: 'Camping Gear', qty: 7 }, { name: 'Tools', qty: '0' }];
    }
    return [];
  }), logger, config });
  const m = await Labels.getManifest('area', 3, 42);
  assert.equal(m.header.name, 'Garage');
  assert.equal(m.header.parentZone, 'Home');
  assert.match(containerSql, /property_members/i, 'the area manifest container query is membership-scoped');
  assert.match(containerSql, /pm\.USER_ID = \?/i);
  assert.deepEqual(containerParams, [42, 3], 'userId first, then the area id');
  // COUNT(*) can come back as a string/BigInt from mysql2 — the mapping coerces.
  assert.deepEqual(m.rows, [{ name: 'Camping Gear', qty: 7 }, { name: 'Tools', qty: 0 }]);
  assert.ok(m.rows.every(r => typeof r.qty === 'number'), 'qty is always a Number');
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
  assert.equal(pdfPageCount(buf), 3, '60 rows at 22/page is 3 pages');
});

test('a multi-page manifest repeats the header and column header on every page', async () => {
  Labels.init({ db: fakeDb(() => []), logger, config });
  const rows = Array.from({ length: 50 }, (_, i) => ({ name: `Item ${i + 1}`, qty: 1 }));
  const buf = await Labels.renderManifestPdf(
    { header: { name: 'Camping Gear', qrCode: 'TLY-C-1', parentZone: 'Garage', breadcrumb: 'Home' }, rows }, 'large');
  const pages = pdfPageCount(buf);
  assert.equal(pages, 3, '50 rows at 22/page is 3 pages');
  // Spec §3: every page is self-contained — header block + column header.
  assert.equal(pdfTextCount(buf, 'CAMPING GEAR'), pages, 'the inverted title repeats per page');
  assert.equal(pdfTextCount(buf, 'TLY-C-1'), pages, 'the TLY code repeats per page');
  assert.equal(pdfTextCount(buf, 'Home'), pages, 'the breadcrumb repeats per page');
  assert.equal(pdfTextCount(buf, 'CONTENTS'), pages, 'the CONTENTS column header repeats per page');
  assert.equal(pdfTextCount(buf, 'QTY'), pages, 'the QTY column header repeats per page');
  // ...and the footer paginates rather than repeating a constant.
  for (let p = 1; p <= pages; p++) {
    assert.equal(pdfTextCount(buf, `Page ${p} of ${pages}`), 1, `page ${p} names itself in the footer`);
  }
  assert.equal(pdfTextCount(buf, '50 items'), pages, 'the total is restated on every page');
  // Rows are not repeated — each page carries its own slice.
  assert.equal(pdfTextCount(buf, 'Item 1 '), 0, 'sanity: exact-prefix matching is in play');
  assert.equal(pdfTextCount(buf, 'Item 23'), 1, 'the 23rd row appears exactly once (on page 2)');
});

test('manifest rows stay on one line — a long name / big qty cannot overlap the next row', async () => {
  Labels.init({ db: fakeDb(() => []), logger, config });
  const buf = await Labels.renderManifestPdf({
    header: { name: 'Camping Gear', qrCode: 'TLY-C-1', parentZone: 'Garage', breadcrumb: 'Home' },
    rows: [
      { name: 'An extremely long unbreakable item name that cannot possibly fit', qty: 123456 },
      { name: 'Lantern', qty: 2 },
    ],
  }, 'large');
  // The two rows sit one rowH (14pt) apart. If either cell wrapped, a third
  // baseline would appear between them and paint over the next row's shading.
  const rowRuns = pdfTextRuns(buf).filter(r => r.y !== null && r.y > 300 && r.y < 340);
  assert.equal(rowRuns.length, 4, `expected exactly 4 row cells (2 rows x name+qty), got ${JSON.stringify(rowRuns)}`);
  const baselines = [...new Set(rowRuns.map(r => Math.round(r.y)))].sort((a, b) => b - a);
  assert.equal(baselines.length, 4, 'name and qty share a row but not an exact baseline');
  assert.ok(baselines[0] - baselines[2] === 14, 'consecutive rows are exactly one rowH apart');
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

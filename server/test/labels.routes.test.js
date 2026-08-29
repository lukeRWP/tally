const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const Labels = require('../src/modules/labels/labels.service');
const labelsRoutes = require('../src/modules/labels/labels.routes');

// Route-level tests for POST /api/labels/_y_/generate (#101): the service
// tests cover the renderers and the schema tests cover Joi in isolation, but
// the preset→renderer DISPATCH — validate middleware, 404s, headers — only
// exists in the route, so it is exercised here over real HTTP. Renderers are
// mocked per-test with t.mock (auto-restored); the middleware never is.

const logger = { warn() {}, info() {}, error() {} };
const config = { clientUrl: 'https://tally.example' };

function makeApp(db = { query: async () => [] }) {
  const app = express();
  app.use(express.json());
  // The real requireAuth needs a session row; the route only reads req.user.id.
  app.locals.requireAuth = (req, res, next) => { req.user = { id: 42 }; next(); };
  labelsRoutes({ app, db, logger, config });
  return app;
}

/** Run fn against a live ephemeral listener, always closing it after. */
async function withServer(fn, db) {
  const server = makeApp(db).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

const generate = (base, body) => fetch(`${base}/api/labels/_y_/generate`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const ENTITY = { id: 1, name: 'Drill', qrCode: 'TLY-I-3A9F2C', type: 'item', tags: [], parentZone: null, breadcrumb: 'Home > Garage' };
const MANIFEST = (name) => ({ header: { name, qrCode: 'TLY-C-1', tags: [], parentZone: 'Garage', breadcrumb: 'Home' }, rows: [{ name: 'Tent', qty: 1 }] });

test('generate defaults the preset per type and always answers application/pdf + attachment', async (t) => {
  const calls = [];
  t.mock.method(Labels, 'getEntityData', async () => [ENTITY]);
  t.mock.method(Labels, 'renderLabelPdf', async (entities, preset) => { calls.push(preset); return Buffer.from('%PDF-fake'); });

  await withServer(async (base) => {
    for (const [entityType, expected] of [['item', 'small'], ['container', 'medium'], ['area', 'medium']]) {
      const res = await generate(base, { entityType, entityIds: [1] });
      assert.equal(res.status, 200, `${entityType} generates`);
      assert.equal(res.headers.get('content-type'), 'application/pdf');
      assert.equal(res.headers.get('content-disposition'), 'attachment; filename="tally-labels.pdf"');
      assert.equal(Buffer.from(await res.arrayBuffer()).toString(), '%PDF-fake');
      assert.equal(calls.at(-1), expected,
        `the validate middleware fills the ${entityType} default preset (${expected}) before dispatch`);
    }
  });
  assert.deepEqual(calls, ['small', 'medium', 'medium']);
});

test('generate rejects preset "large" for items with a Joi 400, before any service call', async (t) => {
  const getManifest = t.mock.method(Labels, 'getManifest', async () => MANIFEST('x'));
  const getEntityData = t.mock.method(Labels, 'getEntityData', async () => [ENTITY]);

  await withServer(async (base) => {
    const res = await generate(base, { entityType: 'item', entityIds: [1], preset: 'large' });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(JSON.stringify(body), /large/, 'the 400 names the offending rule');
  });
  assert.equal(getManifest.mock.callCount(), 0, 'validation failed before the manifest branch ran');
  assert.equal(getEntityData.mock.callCount(), 0);
});

test('generate rejects more than 100 ids and non-array ids with a 400', async (t) => {
  t.mock.method(Labels, 'getEntityData', async () => [ENTITY]);
  await withServer(async (base) => {
    const over = await generate(base, { entityType: 'item', entityIds: Array.from({ length: 101 }, (_, i) => i + 1) });
    assert.equal(over.status, 400, '101 ids exceeds the schema cap of 100');
    const exact = await generate(base, { entityType: 'item', entityIds: Array.from({ length: 100 }, (_, i) => i + 1) });
    assert.equal(exact.status, 200, '100 ids is the inclusive maximum');
    const notArray = await generate(base, { entityType: 'item', entityIds: 1 });
    assert.equal(notArray.status, 400);
    const empty = await generate(base, { entityType: 'item', entityIds: [] });
    assert.equal(empty.status, 400, 'min 1 id');
  });
});

test('the large branch fetches one manifest per id, drops unowned ones, and bundles the rest', async (t) => {
  const seen = [];
  t.mock.method(Labels, 'getManifest', async (entityType, id, userId) => {
    seen.push([entityType, id, userId]);
    return id === 6 ? null : MANIFEST(`C${id}`); // 6 = not the caller's (route must skip it)
  });
  let bundled = null;
  t.mock.method(Labels, 'renderManifestBundle', async (manifests, preset) => {
    bundled = { names: manifests.map(m => m.header.name), preset };
    return Buffer.from('%PDF-bundle');
  });

  await withServer(async (base) => {
    const res = await generate(base, { entityType: 'container', entityIds: [5, 6, 7], preset: 'large' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
  });
  assert.deepEqual(seen, [['container', 5, 42], ['container', 6, 42], ['container', 7, 42]],
    'every id is fetched as the authenticated user');
  assert.deepEqual(bundled, { names: ['C5', 'C7'], preset: 'large' },
    'only the owned manifests reach the bundle, in request order');
});

test('generate 404s when nothing is owned — both the manifest and the flat branches', async (t) => {
  t.mock.method(Labels, 'getManifest', async () => null);
  t.mock.method(Labels, 'getEntityData', async () => []);

  await withServer(async (base) => {
    for (const body of [
      { entityType: 'container', entityIds: [999], preset: 'large' },
      { entityType: 'item', entityIds: [999] },
      { entityType: 'item', entityIds: [999], preset: 'sheet' },
    ]) {
      const res = await generate(base, body);
      assert.equal(res.status, 404, `${body.preset || 'default'} preset hides unowned ids`);
      assert.equal((await res.json()).success, false);
    }
  });
});

test('the sheet branch maps entity type to the legacy Avery label type', async (t) => {
  t.mock.method(Labels, 'getEntityData', async () => [ENTITY]);
  const calls = [];
  t.mock.method(Labels, 'generatePdf', async (entities, labelType) => { calls.push(labelType); return Buffer.from('%PDF-sheet'); });

  await withServer(async (base) => {
    for (const entityType of ['item', 'container', 'area']) {
      const res = await generate(base, { entityType, entityIds: [1], preset: 'sheet' });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/pdf');
    }
  });
  assert.deepEqual(calls, ['asset', 'bin', 'location']);
});

test('generate renders a real PDF end-to-end (no renderer mocks)', async () => {
  // The db is scripted rather than the service, so the whole route stack runs:
  // validate → getEntityData (membership-scoped SQL) → renderLabelPdf → send.
  const db = { query: async (sql) => {
    if (/FROM TALLY\.items i/i.test(sql)) {
      return [{ ID: 1, NAME: 'Drill', QR_CODE: 'TLY-I-3A9F2C', CONTAINER_NAME: 'Bin 4', AREA_NAME: 'Garage', PROPERTY_NAME: 'Home' }];
    }
    return []; // tags
  } };
  // routes call Labels.init with THIS db via makeApp.
  await withServer(async (base) => {
    const res = await generate(base, { entityType: 'item', entityIds: [1] });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.subarray(0, 4).toString(), '%PDF', 'a real rendered PDF comes back');
    assert.ok(buf.length > 1000, `plausibly a drawn label: ${buf.length} bytes`);
  }, db);
});

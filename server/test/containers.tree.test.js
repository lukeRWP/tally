const test = require('node:test');
const assert = require('node:assert');
const ContainersService = require('../src/modules/inventory/containers.service');

const logger = { info() {}, warn() {}, error() {} };
function fakeDb(handler) { return { query: async (sql, params) => handler(sql, params) }; }

test('getPropertyTree is scoped by USER_ID via property_members', async () => {
  // This returns a whole property's structure in one payload, so the membership
  // join is load-bearing rather than defence in depth.
  let sql = '', params = null;
  ContainersService.init({ db: fakeDb((s, p) => { sql = s; params = p; return []; }), logger });
  await ContainersService.getPropertyTree(7, 42);
  assert.match(sql, /JOIN TALLY\.property_members pm/i, 'must join property_members');
  assert.match(sql, /pm\.USER_ID = \?/i, 'must bind the user');
  assert.deepEqual(params, [7, 42], 'propertyId then userId');
});

test('getPropertyTree excludes deleted containers and deleted areas', async () => {
  // A bin in a recycled area is phantom structure — present in the tree,
  // unreachable by navigation.
  let sql = '';
  ContainersService.init({ db: fakeDb((s) => { sql = s; return []; }), logger });
  await ContainersService.getPropertyTree(1, 1);
  assert.match(sql, /c\.DELETED_AT IS NULL/i, 'deleted containers excluded');
  assert.match(sql, /a\.DELETED_AT IS NULL/i, 'containers under a deleted area excluded');
});

test('getPropertyTree returns every depth in ONE query, not per level', async () => {
  // Walking level by level is one request per node: fine on a demo, unusable
  // on a garage with forty bins.
  let calls = 0;
  ContainersService.init({ db: fakeDb(() => { calls++; return []; }), logger });
  await ContainersService.getPropertyTree(1, 1);
  assert.equal(calls, 1, 'the whole tree must cost a single query');
});

test('getPropertyTree carries the parent link the caller needs to nest', async () => {
  ContainersService.init({
    db: fakeDb(() => [
      { ID: 1, AREA_ID: 5, PARENT_CONTAINER_ID: null, NAME: 'Shelf', TYPE: 'shelf',
        QR_CODE: 'TLY-C-1', CONTAINER_COUNT: 1, ITEM_COUNT: 0 },
      { ID: 2, AREA_ID: 5, PARENT_CONTAINER_ID: 1, NAME: 'Box', TYPE: 'box',
        QR_CODE: 'TLY-C-2', CONTAINER_COUNT: 0, ITEM_COUNT: 3 },
    ]),
    logger,
  });
  const rows = await ContainersService.getPropertyTree(1, 1);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].parentContainerId, null, 'a top-level bin has no parent');
  assert.equal(rows[1].parentContainerId, 1, 'a nested bin points at its parent');
  assert.equal(rows[1].areaId, 5, 'every node keeps its area, so orphans are detectable');
});

test('the tree route is registered before /:containerId', () => {
  // Express matches in order: registered after, "tree" is read as a container
  // id and the route becomes unreachable. Same trap the barcode and search
  // routes carry a comment about in products.routes.js.
  const routes = [];
  const requireAuth = (req, res, next) => next();
  const record = (m) => (p, ...handlers) => routes.push({ method: m, path: p, handlers });
  const app = {
    locals: { requireAuth, resolvePropertyRole: (req, res, next) => next(), requireRole: () => (req, res, next) => next() },
    get: record('GET'), post: record('POST'), put: record('PUT'),
    patch: record('PATCH'), delete: record('DELETE'),
  };
  require('../src/modules/inventory/containers.routes')({ app, db: fakeDb(() => []), logger });

  const paths = routes.filter((r) => r.method === 'GET').map((r) => r.path);
  const tree = paths.indexOf('/api/containers/_x_/tree/:propertyId');
  const byId = paths.indexOf('/api/containers/_x_/:containerId');
  assert.ok(tree !== -1, 'the tree route must be registered');
  assert.ok(byId === -1 || tree < byId, 'tree must come before the :containerId wildcard');
});

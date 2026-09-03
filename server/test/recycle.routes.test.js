const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const errorHandler = require('../src/middleware/error-handler');
const recycleRoutes = require('../src/modules/recycle/recycle.routes');
const RecycleService = require('../src/modules/recycle/recycle.service');
const Audit = require('../src/modules/audit/audit.service');

// #347 through the real route module: the role gate and the retention window
// live in the service, but what the CLIENT sees is what the route returns.
// vision.test.js idiom — a real app, the real error handler, a real listener.

const logger = { warn() {}, info() {}, error() {} };

function makeApp(db) {
  const app = express();
  app.locals.requireAuth = (req, res, next) => { req.user = { id: 42 }; next(); };
  // The audit service is wired by the app, not by this route module.
  Audit.init({ db: { query: async () => [] }, logger });
  recycleRoutes({ app, db, logger });
  app.use(errorHandler);
  return app;
}

async function call(app, method, path) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

function dbWith(role) {
  const query = async (sql) => {
    if (/FROM TALLY\.delete_batches b/i.test(sql)) {
      return role == null ? [] : [
        { ID: 7, PROPERTY_ID: 3, ROOT_TYPE: 'item', ROOT_ID: 55, ROOT_NAME: 'Lamp', ROLE: role },
      ];
    }
    if (/FROM TALLY\.items i\s+JOIN/i.test(sql)) {
      return [{ CONTAINER_DELETED: null, AREA_DELETED: null, PROP_DELETED: null }];
    }
    return [];
  };
  return { query, withTransaction: async (fn) => fn({ query }) };
}

test.beforeEach(() => { RecycleService._lastSweepAt = 0; });
test.afterEach(() => { RecycleService._lastSweepAt = 0; });

test('a viewer restoring is 403 with the envelope, not a 500', async (t) => {
  t.mock.method(RecycleService, 'sweepIfDue', () => null);
  const { status, body } = await call(makeApp(dbWith('viewer')), 'POST', '/api/recycle/_y_/restore/7');
  assert.equal(status, 403);
  assert.equal(body.success, false);
  assert.match(body.message, /owner/i);
});

test('an owner restoring is 200', async () => {
  const { status, body } = await call(makeApp(dbWith('owner')), 'POST', '/api/recycle/_y_/restore/7');
  assert.equal(status, 200);
  assert.equal(body.data.restored.rootName, 'Lamp');
});

test('a batch that is not yours, or has aged out, is 404', async () => {
  const { status } = await call(makeApp(dbWith(null)), 'POST', '/api/recycle/_y_/restore/7');
  assert.equal(status, 404);
});

test('listing the bin kicks the retention sweep without waiting on it', async (t) => {
  let resolveSweep;
  const sweep = new Promise((r) => { resolveSweep = r; });
  const spy = t.mock.method(RecycleService, 'sweepIfDue', () => sweep);
  const { status, body } = await call(makeApp(dbWith(null)), 'GET', '/api/recycle/_x_/list');
  assert.equal(status, 200, 'the list answered while the sweep was still pending');
  assert.deepEqual(body.data.batches, []);
  assert.equal(spy.mock.callCount(), 1);
  resolveSweep();
});

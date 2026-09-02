const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const errorHandler = require('../src/middleware/error-handler');
const filesRoutes = require('../src/modules/files/files.routes');
const conditionRoutes = require('../src/modules/files/condition.routes');
const ItemsService = require('../src/modules/inventory/items.service');

// #346 — a multer rejection on the files and condition routes was a 500. The
// fileFilter threw a bare Error, `upload.single()` sat bare in the chain, and
// the global handler has nothing to map a status-less error to but 500. So an
// iPhone picking a photo with `accept="image/*"` (which hands over HEIC) got
// "Internal Server Error" for "we don't take that format".
//
// Idiom from vision.test.js: a real Express app with the real route module and
// the real error handler, posting real multipart. Only the item→property lookup
// is stubbed; the request never reaches the service on any path tested here.

const logger = { warn() {}, info() {}, error() {} };
const db = { query: async () => [] };

function makeApp(mount) {
  const app = express();
  app.locals.requireAuth = (req, res, next) => { req.user = { id: 42 }; next(); };
  app.locals.resolvePropertyRole = (req, res, next) => { req.propertyRole = 'owner'; next(); };
  app.locals.requireRole = () => (req, res, next) => next();
  mount({ app, db, logger, config: {} });
  app.use(errorHandler);
  return app;
}

async function post(app, path, field, { type, bytes, name = 'p.bin' }) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const form = new FormData();
    form.append(field, new Blob([bytes], { type }), name);
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST', body: form });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

const HEIC = { type: 'image/heic', bytes: Buffer.alloc(64), name: 'IMG_0001.heic' };

test.beforeEach((t) => {
  t.mock.method(ItemsService, 'getPropertyIdForItem', async () => 7);
});

test('files: a type the route does not take is a 415, not a 500', async () => {
  const app = makeApp(filesRoutes);
  const { status, body } = await post(app, '/api/files/_y_/item/1/upload', 'file', HEIC);
  assert.equal(status, 415);
  assert.equal(body.success, false);
  assert.equal(body.message, 'File type not allowed');
});

test('conditions: same rejection, same status, its own message', async () => {
  const app = makeApp(conditionRoutes);
  const { status, body } = await post(app, '/api/conditions/_y_/item/1', 'photo', HEIC);
  assert.equal(status, 415);
  assert.equal(body.message, 'Only image files are allowed');
});

test('files: over the 20MB cap is a 413', async () => {
  const app = makeApp(filesRoutes);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20 * 1024 * 1024 + 1)]);
  const { status } = await post(app, '/api/files/_y_/item/1/upload', 'file', { type: 'image/jpeg', bytes: jpeg, name: 'big.jpg' });
  assert.equal(status, 413);
});

test('files: the wrong field name is a 400, not a 500', async () => {
  const app = makeApp(filesRoutes);
  const { status } = await post(app, '/api/files/_y_/item/1/upload', 'photo', { type: 'image/jpeg', bytes: Buffer.alloc(16), name: 'p.jpg' });
  assert.equal(status, 400);
});

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const SharingService = require('../src/modules/sharing/sharing.service');
const sharingRoutes = require('../src/modules/sharing/sharing.routes');

/**
 * The PUBLIC share route (#282). This is the only endpoint in tally that
 * answers with no session at all, so what it puts in the envelope is exactly
 * what a stranger with a URL can read. These tests pin two things:
 *
 *  1. the `share` framing block — sharer display name + expiry — that lets the
 *     page say who sent this and when it dies, instead of rendering someone
 *     else's inventory with no context;
 *  2. that the block carries the display NAME and nothing else about the
 *     sharer — no email, no user id.
 *
 * Idiom from matches.routes.test.js: a real Express app with the real routes
 * wired in over an ephemeral listener; only the service methods are mocked.
 */
const logger = { warn() {}, info() {}, error() {}, debug() {} };

function makeApp() {
  const app = express();
  app.use(express.json());
  app.locals.requireAuth = (req, res, next) => { req.user = { id: 42 }; next(); };
  app.locals.resolvePropertyRole = (req, res, next) => next();
  app.locals.requireRole = () => (req, res, next) => next();
  sharingRoutes({
    app,
    db: { query: async () => [] },
    logger,
    config: { clientUrl: 'https://tally.example' },
  });
  return app;
}

async function get(path) {
  const server = makeApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

test('the public view sends a `share` block naming the sharer and the expiry', async (t) => {
  t.mock.method(SharingService, 'validate', async () => ({
    entityType: 'container',
    entityId: 4,
    createdBy: 1,
    createdByName: 'Luke Turner',
    expiresAt: '2026-09-05T00:00:00.000Z',
    createdAt: '2026-08-29T00:00:00.000Z',
  }));
  t.mock.method(SharingService, 'getEntityForShare', async () => ({ type: 'container', container: { id: 4, name: 'Bin A' }, nestedContainers: [], items: [] }));

  const { status, body } = await get('/api/sharing/_x_/view/tok');
  assert.equal(status, 200);
  assert.equal(body.data.share.sharedByName, 'Luke Turner');
  assert.equal(body.data.share.expiresAt, '2026-09-05T00:00:00.000Z');
  assert.equal(body.data.share.entityType, 'container');
  // The entity payload is untouched — `share` is framing beside it, not inside.
  assert.equal(body.data.entity.type, 'container');
});

test('the `share` block leaks nothing about the sharer beyond a display name', async (t) => {
  t.mock.method(SharingService, 'validate', async () => ({
    entityType: 'item',
    entityId: 9,
    createdBy: 77,
    createdByName: 'Luke Turner',
    expiresAt: '2026-09-05T00:00:00.000Z',
    createdAt: '2026-08-29T00:00:00.000Z',
  }));
  t.mock.method(SharingService, 'getEntityForShare', async () => ({ type: 'item', item: { id: 9 }, files: [], dates: [], conditionSnapshots: [] }));

  const { body } = await get('/api/sharing/_x_/view/tok');
  assert.deepEqual(
    Object.keys(body.data.share).sort(),
    ['createdAt', 'entityType', 'expiresAt', 'sharedByName'],
  );
  const serialised = JSON.stringify(body.data.share);
  assert.ok(!/@/.test(serialised), 'no email address may ride along');
  assert.ok(!/"createdBy"/.test(serialised), 'the sharer user id stays server-side');
});

test('a share whose creator row is gone still resolves, with a null name', async (t) => {
  t.mock.method(SharingService, 'validate', async () => ({
    entityType: 'container', entityId: 4, createdBy: 77, createdByName: null, expiresAt: null, createdAt: null,
  }));
  t.mock.method(SharingService, 'getEntityForShare', async () => ({ type: 'container', container: { id: 4 }, nestedContainers: [], items: [] }));

  const { status, body } = await get('/api/sharing/_x_/view/tok');
  assert.equal(status, 200, 'a missing sharer must not 404 the link');
  assert.equal(body.data.share.sharedByName, null);
  assert.equal(body.data.share.expiresAt, null);
});

test('an expired or unknown token is still a 404 with no share block', async (t) => {
  t.mock.method(SharingService, 'validate', async () => null);
  const { status, body } = await get('/api/sharing/_x_/view/nope');
  assert.equal(status, 404);
  assert.equal(body.success, false);
  assert.equal(body.data, undefined);
});

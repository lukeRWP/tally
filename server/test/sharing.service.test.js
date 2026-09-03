const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const express = require('express');
const SharingService = require('../src/modules/sharing/sharing.service');
const sharingRoutes = require('../src/modules/sharing/sharing.routes');
const errorHandler = require('../src/middleware/error-handler');

/**
 * #349: the share token is the whole credential for a public page, and it sat
 * in share_links verbatim; an owner could neither see nor revoke a link an
 * editor made; and a link outlived its creator's membership. These pin the
 * SQL the service now sends — a fake db that records every query — because
 * the properties that matter (digest not raw, TOKEN_HASHED = 1, creator OR
 * owner, expired rows swept first) are all in the statements themselves.
 */
const logger = { warn() {}, info() {}, error() {}, debug() {} };
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function fakeDb(answers = {}) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    if (/^INSERT/.test(sql.trim())) return { insertId: 11 };
    if (/^DELETE/.test(sql.trim())) return { affectedRows: answers.deleted ?? 0 };
    if (/WHERE s\.ID = \?/.test(sql)) {
      return [{ ID: 11, ENTITY_TYPE: 'item', ENTITY_ID: 9, PROPERTY_ID: 3, CREATED_BY: 42, CREATED_BY_NAME: 'Luke', EXPIRES_AT: 'later', CREATED_AT: 'now', DISCLOSURE: null }];
    }
    return answers.rows ?? [];
  };
  return { query, calls };
}

function init(db) {
  SharingService.init({ db, logger, config: { clientUrl: 'https://tally.example' } });
}

test('create stores the sha256 digest with TOKEN_HASHED = 1 and returns the raw token only in the URL', async () => {
  const db = fakeDb();
  init(db);

  const link = await SharingService.create('item', 9, 42, 7);

  const insert = db.calls.find((c) => /^INSERT/.test(c.sql));
  assert.match(insert.sql, /\(TOKEN, TOKEN_HASHED, ENTITY_TYPE/);
  assert.match(insert.sql, /VALUES \(\?, 1, \?/);
  const stored = insert.params[0];
  const raw = link.url.split('/share/')[1];
  assert.equal(raw.length, 64, 'raw token is 32 random bytes as hex');
  assert.equal(stored, sha256(raw), 'what hits the table is the digest of what went in the URL');
  assert.notEqual(stored, raw);
  // Nothing but the URL carries the credential — no `token` field to leak
  // into a list, a log, or a client store.
  assert.equal(link.token, undefined);
  assert.equal(link.id, 11);
  assert.equal(link.propertyId, 3);
  assert.equal(link.createdByName, 'Luke');
});

test('validate hashes the incoming token, requires TOKEN_HASHED = 1, and rechecks the creator is still a member', async () => {
  const db = fakeDb({ rows: [{ ENTITY_TYPE: 'item', ENTITY_ID: 9, CREATED_BY: 42, CREATED_BY_NAME: 'Luke', EXPIRES_AT: 'later', CREATED_AT: 'now', DISCLOSURE: null }] });
  init(db);

  const found = await SharingService.validate('raw-token');

  assert.equal(found.entityId, 9);
  const [q] = db.calls;
  assert.deepEqual(q.params, [sha256('raw-token')]);
  assert.match(q.sql, /s\.TOKEN = \? AND s\.TOKEN_HASHED = 1 AND s\.EXPIRES_AT > NOW\(\)/);
  // The membership recheck: an INNER join from the link's property to a
  // property_members row for its creator. LEFT here would be the old bug.
  assert.match(q.sql, /(?<!LEFT )JOIN TALLY\.property_members pm ON pm\.PROPERTY_ID = COALESCE\(.*?\) AND pm\.USER_ID = s\.CREATED_BY/);
  // The digest is never compared as the raw value would have been.
  assert.doesNotMatch(q.sql, /SHA2\(/);
});

test('validate resolves the property for every entity type through one join chain', async () => {
  const db = fakeDb();
  init(db);
  await SharingService.validate('x');
  const [q] = db.calls;
  for (const table of ['areas la', 'containers lc', 'areas lca', 'items li', 'containers lic', 'areas lia']) {
    assert.match(q.sql, new RegExp(`LEFT JOIN TALLY\\.${table} `), `joins ${table}`);
  }
  assert.match(q.sql, /CASE WHEN s\.ENTITY_TYPE = 'property' THEN s\.ENTITY_ID END, la\.PROPERTY_ID, lca\.PROPERTY_ID, lia\.PROPERTY_ID/);
});

test('getByUser purges expired rows first, then lists creator-or-owner links without the token', async () => {
  const db = fakeDb({ rows: [{ ID: 5, TOKEN: 'should-not-appear', ENTITY_TYPE: 'area', ENTITY_ID: 2, PROPERTY_ID: 3, CREATED_BY: 8, CREATED_BY_NAME: 'Sam', EXPIRES_AT: 'later', CREATED_AT: 'now', DISCLOSURE: null }] });
  init(db);

  const links = await SharingService.getByUser(42);

  assert.equal(db.calls.length, 2);
  assert.equal(db.calls[0].sql, 'DELETE FROM TALLY.share_links WHERE EXPIRES_AT <= NOW()');
  const list = db.calls[1];
  assert.deepEqual(list.params, [42, 42]);
  assert.match(list.sql, /pm\.USER_ID = \? WHERE s\.CREATED_BY = \? OR pm\.ROLE = 'owner'/);
  assert.match(list.sql, /^SELECT s\.ID, s\.ENTITY_TYPE, s\.ENTITY_ID, s\.CREATED_BY, s\.EXPIRES_AT, s\.CREATED_AT, s\.DISCLOSURE,/);
  assert.doesNotMatch(list.sql, /s\.\*|s\.TOKEN/);

  assert.equal(links.length, 1);
  assert.equal(links[0].createdBy, 8);
  assert.equal(links[0].createdByName, 'Sam');
  assert.equal(links[0].propertyId, 3);
  assert.equal(links[0].url, undefined, 'no URL can be rebuilt from a digest');
  assert.equal(links[0].token, undefined);
});

test('revoke deletes as creator OR property owner and reports whether a row went', async () => {
  const db = fakeDb({ deleted: 1 });
  init(db);

  assert.equal(await SharingService.revoke(5, 42), true);
  const [q] = db.calls;
  assert.deepEqual(q.params, [42, 5, 42]);
  assert.match(q.sql, /^DELETE s FROM TALLY\.share_links s LEFT JOIN/);
  assert.match(q.sql, /WHERE s\.ID = \? AND \(s\.CREATED_BY = \? OR pm\.ROLE = 'owner'\)$/);

  init(fakeDb({ deleted: 0 }));
  assert.equal(await SharingService.revoke(5, 42), false);
});

// ── The route on top ────────────────────────────────────────────────────────

function makeApp(db) {
  const app = express();
  app.use(express.json());
  app.locals.requireAuth = (req, res, next) => { req.user = { id: 42 }; next(); };
  app.locals.resolvePropertyRole = (req, res, next) => next();
  app.locals.requireRole = () => (req, res, next) => next();
  sharingRoutes({ app, db, logger, config: { clientUrl: 'https://tally.example' } });
  app.use(errorHandler);
  return app;
}

async function call(db, method, path) {
  const server = makeApp(db).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

test('DELETE a link that is not yours (or not there) is a 404, not a silent 200', async () => {
  const { status, body } = await call(fakeDb({ deleted: 0 }), 'DELETE', '/api/sharing/_d_/5');
  assert.equal(status, 404);
  assert.equal(body.message, 'Share link not found');

  const ok = await call(fakeDb({ deleted: 1 }), 'DELETE', '/api/sharing/_d_/5');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.message, 'Share link revoked');
});

test('the public view never echoes the token back, and a miss is a plain 404', async () => {
  const { status, body } = await call(fakeDb(), 'GET', '/api/sharing/_x_/view/deadbeef');
  assert.equal(status, 404);
  assert.doesNotMatch(JSON.stringify(body), /deadbeef/);
});

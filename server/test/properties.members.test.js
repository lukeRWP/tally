const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const errorHandler = require('../src/middleware/error-handler');
const propertiesRoutes = require('../src/modules/inventory/properties.routes');
const { requireRole, resolvePropertyRole } = require('../src/modules/auth/auth.middleware');
const Audit = require('../src/modules/audit/audit.service');

// #345: membership was append-only — removeMember/updateMemberRole existed in
// the service but nothing routed to them. These go through the real route
// module with the real role middleware, because the two things that matter
// are (a) who is allowed to call them and (b) that a property can never be
// left without an owner. recycle.routes.test.js idiom.

const logger = { warn() {}, info() {}, error() {} };
const PROPERTY = 3;
const ME = 42;

/**
 * Fake db. `members` is the property's membership; `me` is the caller's role
 * in it (null = not a member). Records every write so tests can assert on
 * what would have hit MySQL. FOR UPDATE reads come through the transaction.
 */
function fakeDb({ members, me }) {
  const writes = [];
  const rows = () => members.map((m) => ({ USER_ID: m.userId, ROLE: m.role }));
  const query = async (sql, params) => {
    if (/SELECT ROLE FROM TALLY\.property_members WHERE PROPERTY_ID = \? AND USER_ID = \?/.test(sql)) {
      return me ? [{ ROLE: me }] : [];
    }
    if (/FOR UPDATE/.test(sql)) return rows();
    if (/^(DELETE|UPDATE|INSERT)/.test(sql.trim())) { writes.push({ sql, params }); return { affectedRows: 1 }; }
    if (/SELECT ID FROM TALLY\.users WHERE EMAIL/.test(sql)) {
      return params[0] === 'new@example.com' ? [{ ID: 99 }] : [];
    }
    if (/JOIN TALLY\.users u/.test(sql)) {
      const m = members.find((x) => x.userId === params[1]);
      return m ? [{ ID: 1, PROPERTY_ID: PROPERTY, USER_ID: m.userId, ROLE: m.role, EMAIL: `${m.userId}@x`, DISPLAY_NAME: 'X' }] : [];
    }
    return [];
  };
  return { query, withTransaction: async (fn) => fn({ query }), writes };
}

function makeApp(db) {
  const app = express();
  app.use(express.json());
  app.locals.requireAuth = (req, res, next) => { req.user = { id: ME }; next(); };
  app.locals.resolvePropertyRole = resolvePropertyRole(db);
  app.locals.requireRole = requireRole;
  propertiesRoutes({ app, db, logger });
  app.use(errorHandler);
  return app;
}

async function call(app, method, path, body) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

let audits;
test.beforeEach(() => {
  audits = [];
  Audit.init({ db: { query: async (sql, params) => { audits.push(params); return []; } }, logger });
});

const TWO_OWNERS = [{ userId: ME, role: 'owner' }, { userId: 7, role: 'owner' }, { userId: 8, role: 'editor' }];
const ONE_OWNER = [{ userId: ME, role: 'owner' }, { userId: 8, role: 'editor' }];

// ── who may call ──────────────────────────────────────────────────────────

test('an editor cannot remove a member (403, envelope)', async () => {
  const db = fakeDb({ members: TWO_OWNERS, me: 'editor' });
  const { status, body } = await call(makeApp(db), 'DELETE', `/api/properties/_d_/${PROPERTY}/members/8`);
  assert.equal(status, 403);
  assert.equal(body.success, false);
  assert.equal(db.writes.length, 0);
});

test('an editor cannot change a role (403)', async () => {
  const db = fakeDb({ members: TWO_OWNERS, me: 'editor' });
  const { status } = await call(makeApp(db), 'PATCH', `/api/properties/_p_/${PROPERTY}/members/8`, { role: 'owner' });
  assert.equal(status, 403);
  assert.equal(db.writes.length, 0);
});

test('a non-member gets 403, not a hint that the property exists', async () => {
  const db = fakeDb({ members: TWO_OWNERS, me: null });
  const { status } = await call(makeApp(db), 'DELETE', `/api/properties/_d_/${PROPERTY}/members/8`);
  assert.equal(status, 403);
});

// ── last-owner protection ─────────────────────────────────────────────────

test('the only owner cannot be removed (409)', async () => {
  const db = fakeDb({ members: ONE_OWNER, me: 'owner' });
  const { status, body } = await call(makeApp(db), 'DELETE', `/api/properties/_d_/${PROPERTY}/members/${ME}`);
  assert.equal(status, 409);
  assert.match(body.message, /at least one owner/i);
  assert.equal(db.writes.length, 0);
});

test('the only owner cannot be demoted (409)', async () => {
  const db = fakeDb({ members: ONE_OWNER, me: 'owner' });
  const { status } = await call(makeApp(db), 'PATCH', `/api/properties/_p_/${PROPERTY}/members/${ME}`, { role: 'viewer' });
  assert.equal(status, 409);
  assert.equal(db.writes.length, 0);
});

test('an owner can be demoted when another owner remains', async () => {
  const db = fakeDb({ members: TWO_OWNERS, me: 'owner' });
  const { status } = await call(makeApp(db), 'PATCH', `/api/properties/_p_/${PROPERTY}/members/7`, { role: 'editor' });
  assert.equal(status, 200);
  assert.equal(db.writes.length, 1);
  assert.match(db.writes[0].sql, /UPDATE TALLY\.property_members SET ROLE = \?/);
  assert.deepEqual(db.writes[0].params, ['editor', String(PROPERTY), 7]);
});

test('an owner can remove themselves when another owner remains', async () => {
  const db = fakeDb({ members: TWO_OWNERS, me: 'owner' });
  const { status } = await call(makeApp(db), 'DELETE', `/api/properties/_d_/${PROPERTY}/members/${ME}`);
  assert.equal(status, 200);
  assert.match(db.writes[0].sql, /DELETE FROM TALLY\.property_members/);
  assert.deepEqual(db.writes[0].params, [String(PROPERTY), ME]);
});

test('re-asserting owner on the only owner is a no-op 200, not a 409', async () => {
  const db = fakeDb({ members: ONE_OWNER, me: 'owner' });
  const { status } = await call(makeApp(db), 'PATCH', `/api/properties/_p_/${PROPERTY}/members/${ME}`, { role: 'owner' });
  assert.equal(status, 200);
  assert.equal(db.writes.length, 0);
  assert.equal(audits.length, 0, 'unchanged role is not audited');
});

// ── shape ─────────────────────────────────────────────────────────────────

test('a userId that is not a member is 404', async () => {
  const db = fakeDb({ members: ONE_OWNER, me: 'owner' });
  const { status } = await call(makeApp(db), 'DELETE', `/api/properties/_d_/${PROPERTY}/members/555`);
  assert.equal(status, 404);
});

test('a non-numeric userId is 400 before any SQL', async () => {
  const db = fakeDb({ members: ONE_OWNER, me: 'owner' });
  const { status } = await call(makeApp(db), 'DELETE', `/api/properties/_d_/${PROPERTY}/members/bob`);
  assert.equal(status, 400);
});

test('an unknown role is 422', async () => {
  const db = fakeDb({ members: TWO_OWNERS, me: 'owner' });
  const { status } = await call(makeApp(db), 'PATCH', `/api/properties/_p_/${PROPERTY}/members/8`, { role: 'admin' });
  assert.equal(status, 422);
});

// ── audit + add ───────────────────────────────────────────────────────────

test('removing a member writes a property audit row naming who and what role', async () => {
  const db = fakeDb({ members: TWO_OWNERS, me: 'owner' });
  await call(makeApp(db), 'DELETE', `/api/properties/_d_/${PROPERTY}/members/8`);
  assert.equal(audits.length, 1);
  const [userId, entityType, entityId, action, changes] = audits[0];
  assert.equal(userId, ME);
  assert.equal(entityType, 'property');
  assert.equal(entityId, String(PROPERTY));
  assert.equal(action, 'updated');
  assert.deepEqual(JSON.parse(changes), { member: { userId: 8, role: 'editor', removed: true } });
});

test('adding someone who is already a member is 409, not a 500', async () => {
  const db = fakeDb({ members: ONE_OWNER, me: 'owner' });
  db.query = ((orig) => async (sql, params) => {
    if (/^INSERT INTO TALLY\.property_members/.test(sql.trim())) {
      const err = new Error('dup'); err.code = 'ER_DUP_ENTRY'; throw err;
    }
    return orig(sql, params);
  })(db.query);
  const { status, body } = await call(makeApp(db), 'POST', `/api/properties/_y_/${PROPERTY}/members`, { email: 'new@example.com', role: 'viewer' });
  assert.equal(status, 409);
  assert.match(body.message, /already a member/i);
});

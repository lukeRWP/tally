const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const errorHandler = require('../src/middleware/error-handler');
const propertyInvitesRoutes = require('../src/modules/inventory/property-invites.routes');
const { requireRole, resolvePropertyRole } = require('../src/modules/auth/auth.middleware');
const Audit = require('../src/modules/audit/audit.service');

// Owner-gating follows properties.members.test.js's idiom exactly (the same
// route middleware, the same fake-db/HTTP harness). What is new here is the
// pwiam round trip (stubbed fetch, never the network) and the rule that
// nothing is written to TALLY.property_invites unless pwiam's mint succeeds.

const logger = { warn() {}, info() {}, error() {} };
const config = { auth: { iam: { issuer: 'https://id.example.test', clientId: 'tally-web', clientSecret: 's3cret' } } };
const PROPERTY = 3;
const ME = 42;

function fakeFetch(script) {
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push({ url, opts });
    const next = script.shift();
    if (!next) throw new Error('fakeFetch: no scripted response left');
    if (next instanceof Error) throw next;
    return { status: next.status, json: async () => next.body };
  };
  fetch.calls = calls;
  return fetch;
}

function fakeDb({ me, invites = [] }) {
  const writes = [];
  let nextId = invites.reduce((m, i) => Math.max(m, i.ID), 0) + 1;
  const query = async (sql, params) => {
    const s = sql.replace(/\s+/g, ' ').trim();

    if (/^SELECT ROLE FROM TALLY\.property_members WHERE PROPERTY_ID = \? AND USER_ID = \?$/.test(s)) {
      return me ? [{ ROLE: me }] : [];
    }
    if (/^SELECT SUB, DISPLAY_NAME FROM TALLY\.users WHERE ID = \?$/.test(s)) {
      return params[0] === ME ? [{ SUB: '01JOWNER', DISPLAY_NAME: 'Luke' }] : [];
    }
    if (/^INSERT INTO TALLY\.property_invites/.test(s)) {
      writes.push({ sql: s, params });
      const [propertyId, role, displayName, inviteeSub, pwiamId, invitedBy, expiresAt] = params;
      invites.push({
        ID: nextId++, PROPERTY_ID: propertyId, ROLE: role, DISPLAY_NAME: displayName,
        INVITEE_SUB: inviteeSub, PWIAM_INVITE_ID: pwiamId, INVITED_BY: invitedBy, EXPIRES_AT: expiresAt,
        ACCEPTED_AT: null, ACCEPTED_USER_ID: null, REVOKED_AT: null, CREATED_AT: new Date(),
      });
      return { affectedRows: 1 };
    }
    if (/^SELECT \* FROM TALLY\.property_invites WHERE PWIAM_INVITE_ID = \?$/.test(s)) {
      return invites.filter((i) => i.PWIAM_INVITE_ID === params[0]);
    }
    if (/^SELECT \* FROM TALLY\.property_invites WHERE PROPERTY_ID = \? AND ACCEPTED_AT IS NULL AND REVOKED_AT IS NULL AND EXPIRES_AT > NOW\(\) ORDER BY CREATED_AT DESC$/.test(s)) {
      return invites.filter((i) => i.PROPERTY_ID == params[0] && !i.ACCEPTED_AT && !i.REVOKED_AT && i.EXPIRES_AT > new Date());
    }
    if (/^SELECT \* FROM TALLY\.property_invites WHERE ID = \? AND PROPERTY_ID = \?$/.test(s)) {
      return invites.filter((i) => i.ID == params[0] && i.PROPERTY_ID == params[1]);
    }
    if (/^UPDATE TALLY\.property_invites SET REVOKED_AT = NOW\(\) WHERE ID = \?$/.test(s)) {
      writes.push({ sql: s, params });
      const inv = invites.find((i) => i.ID === params[0]);
      if (inv) inv.REVOKED_AT = new Date();
      return { affectedRows: 1 };
    }
    throw new Error(`fakeDb: unexpected statement: ${s}`);
  };
  return { query, invites, writes };
}

function makeApp(db, fetch) {
  const app = express();
  app.use(express.json());
  app.locals.requireAuth = (req, res, next) => { req.user = { id: ME }; next(); };
  app.locals.resolvePropertyRole = resolvePropertyRole(db);
  app.locals.requireRole = requireRole;
  propertyInvitesRoutes({ app, db, logger, config, deps: { fetch } });
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

const MINTED = { id: 'pwinv1', userId: '01JINVITEE', url: 'https://id.example.test/join/tok123', expiresAt: '2026-10-03T00:00:00Z' };

let audits;
test.beforeEach(() => {
  audits = [];
  Audit.init({ db: { query: async (sql, params) => { audits.push(params); return []; } }, logger });
});

// ── who may call ──────────────────────────────────────────────────────────

test('an editor cannot list invites (403)', async () => {
  const db = fakeDb({ me: 'editor' });
  const { status } = await call(makeApp(db, fakeFetch([])), 'GET', `/api/properties/_x_/${PROPERTY}/invites`);
  assert.equal(status, 403);
});

test('an editor cannot create an invite (403), nothing written, pwiam never called', async () => {
  const db = fakeDb({ me: 'editor' });
  const fetch = fakeFetch([]);
  const { status } = await call(makeApp(db, fetch), 'POST', `/api/properties/_y_/${PROPERTY}/invites`, { displayName: 'Ana', role: 'editor' });
  assert.equal(status, 403);
  assert.equal(db.writes.length, 0);
  assert.equal(fetch.calls.length, 0);
});

test('an editor cannot revoke an invite (403)', async () => {
  const db = fakeDb({ me: 'editor', invites: [{ ID: 1, PROPERTY_ID: PROPERTY, ROLE: 'editor', DISPLAY_NAME: 'Ana', INVITEE_SUB: 's', PWIAM_INVITE_ID: 'p1', INVITED_BY: ME, EXPIRES_AT: new Date(Date.now() + 1e9), ACCEPTED_AT: null, REVOKED_AT: null }] });
  const { status } = await call(makeApp(db, fakeFetch([])), 'DELETE', `/api/properties/_d_/${PROPERTY}/invites/1`);
  assert.equal(status, 403);
});

// ── validation ────────────────────────────────────────────────────────────

test('displayName over 120 chars is 400 before pwiam is ever called', async () => {
  const db = fakeDb({ me: 'owner' });
  const fetch = fakeFetch([]);
  const { status, body } = await call(makeApp(db, fetch), 'POST', `/api/properties/_y_/${PROPERTY}/invites`, { displayName: 'x'.repeat(121), role: 'editor' });
  assert.equal(status, 400);
  assert.equal(body.success, false);
  assert.equal(fetch.calls.length, 0);
});

test('an empty displayName is 400', async () => {
  const db = fakeDb({ me: 'owner' });
  const { status } = await call(makeApp(db, fakeFetch([])), 'POST', `/api/properties/_y_/${PROPERTY}/invites`, { displayName: '   ', role: 'editor' });
  assert.equal(status, 400);
});

test('a control character in displayName is 400', async () => {
  const db = fakeDb({ me: 'owner' });
  const { status } = await call(makeApp(db, fakeFetch([])), 'POST', `/api/properties/_y_/${PROPERTY}/invites`, { displayName: 'Ana\u0007', role: 'editor' });
  assert.equal(status, 400);
});

test('role "owner" is rejected — invites can only grant editor or viewer', async () => {
  const db = fakeDb({ me: 'owner' });
  const { status } = await call(makeApp(db, fakeFetch([])), 'POST', `/api/properties/_y_/${PROPERTY}/invites`, { displayName: 'Ana', role: 'owner' });
  assert.equal(status, 400);
});

// ── create: success + pwiam error mapping ────────────────────────────────

test('an owner can create an invite: pwiam is minted first, then the row is inserted, url returned once', async () => {
  const db = fakeDb({ me: 'owner' });
  const fetch = fakeFetch([{ status: 201, body: MINTED }]);
  const { status, body } = await call(makeApp(db, fetch), 'POST', `/api/properties/_y_/${PROPERTY}/invites`, { displayName: 'Ana', role: 'editor' });

  assert.equal(status, 201);
  assert.equal(body.data.url, MINTED.url);
  assert.equal(body.data.invite.displayName, 'Ana');
  assert.equal(db.writes.length, 1);
  assert.match(db.writes[0].sql, /INSERT INTO TALLY\.property_invites/);
  assert.deepEqual(db.invites[0].INVITEE_SUB, MINTED.userId);
  assert.deepEqual(db.invites[0].PWIAM_INVITE_ID, MINTED.id);
  assert.equal(audits.length, 1);
});

test('pwiam 429 (cap reached): 429 to the caller, nothing written', async () => {
  const db = fakeDb({ me: 'owner' });
  const fetch = fakeFetch([{ status: 429, body: { error: 'cap_reached' } }]);
  const { status } = await call(makeApp(db, fetch), 'POST', `/api/properties/_y_/${PROPERTY}/invites`, { displayName: 'Ana', role: 'editor' });
  assert.equal(status, 429);
  assert.equal(db.writes.length, 0);
  assert.equal(audits.length, 0);
});

test('pwiam 403 (not enabled): 503 to the caller, nothing written', async () => {
  const db = fakeDb({ me: 'owner' });
  const fetch = fakeFetch([{ status: 403, body: { error: 'not_enabled' } }]);
  const { status } = await call(makeApp(db, fetch), 'POST', `/api/properties/_y_/${PROPERTY}/invites`, { displayName: 'Ana', role: 'editor' });
  assert.equal(status, 503);
  assert.equal(db.writes.length, 0);
});

test('pwiam unreachable (fetch throws): 502 to the caller, nothing written', async () => {
  const db = fakeDb({ me: 'owner' });
  const fetch = fakeFetch([new Error('ECONNREFUSED')]);
  const { status } = await call(makeApp(db, fetch), 'POST', `/api/properties/_y_/${PROPERTY}/invites`, { displayName: 'Ana', role: 'editor' });
  assert.equal(status, 502);
  assert.equal(db.writes.length, 0);
});

// ── list ──────────────────────────────────────────────────────────────────

test('list excludes accepted, revoked, and expired invites', async () => {
  const now = Date.now();
  const invites = [
    { ID: 1, PROPERTY_ID: PROPERTY, ROLE: 'editor', DISPLAY_NAME: 'Pending', INVITEE_SUB: 's1', PWIAM_INVITE_ID: 'p1', INVITED_BY: ME, EXPIRES_AT: new Date(now + 1e9), ACCEPTED_AT: null, REVOKED_AT: null, CREATED_AT: new Date() },
    { ID: 2, PROPERTY_ID: PROPERTY, ROLE: 'editor', DISPLAY_NAME: 'Accepted', INVITEE_SUB: 's2', PWIAM_INVITE_ID: 'p2', INVITED_BY: ME, EXPIRES_AT: new Date(now + 1e9), ACCEPTED_AT: new Date(), REVOKED_AT: null, CREATED_AT: new Date() },
    { ID: 3, PROPERTY_ID: PROPERTY, ROLE: 'editor', DISPLAY_NAME: 'Revoked', INVITEE_SUB: 's3', PWIAM_INVITE_ID: 'p3', INVITED_BY: ME, EXPIRES_AT: new Date(now + 1e9), ACCEPTED_AT: null, REVOKED_AT: new Date(), CREATED_AT: new Date() },
    { ID: 4, PROPERTY_ID: PROPERTY, ROLE: 'editor', DISPLAY_NAME: 'Expired', INVITEE_SUB: 's4', PWIAM_INVITE_ID: 'p4', INVITED_BY: ME, EXPIRES_AT: new Date(now - 1e9), ACCEPTED_AT: null, REVOKED_AT: null, CREATED_AT: new Date() },
  ];
  const db = fakeDb({ me: 'owner', invites });
  const { status, body } = await call(makeApp(db, fakeFetch([])), 'GET', `/api/properties/_x_/${PROPERTY}/invites`);
  assert.equal(status, 200);
  assert.deepEqual(body.data.invites.map((i) => i.displayName), ['Pending']);
});

// ── revoke ────────────────────────────────────────────────────────────────

function pendingInvite(overrides = {}) {
  return {
    ID: 1, PROPERTY_ID: PROPERTY, ROLE: 'editor', DISPLAY_NAME: 'Ana', INVITEE_SUB: 's1',
    PWIAM_INVITE_ID: 'p1', INVITED_BY: ME, EXPIRES_AT: new Date(Date.now() + 1e9),
    ACCEPTED_AT: null, REVOKED_AT: null, CREATED_AT: new Date(), ...overrides,
  };
}

test('revoke: pwiam 200 marks REVOKED_AT and audits', async () => {
  const db = fakeDb({ me: 'owner', invites: [pendingInvite()] });
  const fetch = fakeFetch([{ status: 200, body: { revoked: true } }]);
  const { status } = await call(makeApp(db, fetch), 'DELETE', `/api/properties/_d_/${PROPERTY}/invites/1`);
  assert.equal(status, 200);
  assert.ok(db.invites[0].REVOKED_AT);
  assert.equal(audits.length, 1);
});

test('revoke: pwiam 404 (ticket already gone) still succeeds tally-side', async () => {
  const db = fakeDb({ me: 'owner', invites: [pendingInvite()] });
  const fetch = fakeFetch([{ status: 404, body: {} }]);
  const { status } = await call(makeApp(db, fetch), 'DELETE', `/api/properties/_d_/${PROPERTY}/invites/1`);
  assert.equal(status, 200);
  assert.ok(db.invites[0].REVOKED_AT);
});

test('revoke: pwiam 409 (already redeemed) still marks tally-side revoked', async () => {
  const db = fakeDb({ me: 'owner', invites: [pendingInvite()] });
  const fetch = fakeFetch([{ status: 409, body: { error: 'redeemed' } }]);
  const { status } = await call(makeApp(db, fetch), 'DELETE', `/api/properties/_d_/${PROPERTY}/invites/1`);
  assert.equal(status, 200);
  assert.ok(db.invites[0].REVOKED_AT);
});

test('revoke: an unknown invite id is 404, pwiam never called', async () => {
  const db = fakeDb({ me: 'owner', invites: [] });
  const fetch = fakeFetch([]);
  const { status } = await call(makeApp(db, fetch), 'DELETE', `/api/properties/_d_/${PROPERTY}/invites/999`);
  assert.equal(status, 404);
  assert.equal(fetch.calls.length, 0);
});

test('revoke: an already-revoked invite is 409, pwiam never called again', async () => {
  const db = fakeDb({ me: 'owner', invites: [pendingInvite({ REVOKED_AT: new Date() })] });
  const fetch = fakeFetch([]);
  const { status } = await call(makeApp(db, fetch), 'DELETE', `/api/properties/_d_/${PROPERTY}/invites/1`);
  assert.equal(status, 409);
  assert.equal(fetch.calls.length, 0);
});

test('a non-numeric invite id is 400 before any SQL', async () => {
  const db = fakeDb({ me: 'owner' });
  const { status } = await call(makeApp(db, fakeFetch([])), 'DELETE', `/api/properties/_d_/${PROPERTY}/invites/bob`);
  assert.equal(status, 400);
});

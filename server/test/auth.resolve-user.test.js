const test = require('node:test');
const assert = require('node:assert');

const AuthService = require('../src/modules/auth/auth.service');
const { fakeUsersDb } = require('./helpers/fake-users-db');

// The one hook @pw/auth-express calls (PW IAM step 4). Driven through a
// scripted in-memory users table — nothing here reaches MySQL or pwiam.

const fakeLogger = { info() {}, warn() {}, error() {} };
const config = { auth: { bypassAuth: false } };
const TOKENS = { accessToken: 'opaque', claims: {} }; // any non-null value: "a real login"
const AUTH_TIME = 1_800_000_000;

function boot(seed) {
  const db = fakeUsersDb(seed);
  AuthService.init({ db, config, logger: fakeLogger });
  return db;
}

const row = (o) => ({ ID: 1, SUB: null, ENTRA_ID: null, EMAIL: 'a@b.test', DISPLAY_NAME: 'Ada', AVATAR_URL: null,
  CREATED_AT: new Date('2026-01-01T00:00:00Z'), LAST_LOGIN_AT: null, ...o });

test('resolveUser: a known SUB resolves the row and returns the projection, not the row', async () => {
  const db = boot({ users: [row({ ID: 3, SUB: '01JSUB' })] });
  const user = await AuthService.resolveUser({ sub: '01JSUB', name: 'Ada', email: 'a@b.test', roles: ['member'], auth_time: AUTH_TIME }, { tokens: TOKENS });
  assert.deepStrictEqual(Object.keys(user).sort(), ['avatarUrl', 'createdAt', 'displayName', 'email', 'id', 'lastLoginAt']);
  assert.strictEqual(user.id, 3);
  assert.strictEqual(db.users.length, 1, 'no second row');
});

test('resolveUser: a pre-pwiam user is matched on entra_oid and gets SUB backfilled, once', async () => {
  const db = boot({ users: [row({ ID: 5, ENTRA_ID: 'oid-123', DISPLAY_NAME: 'Eve' })] });
  const claims = { sub: '01JNEW', name: 'Eve', email: 'e@b.test', entra_oid: 'oid-123', roles: ['member'], auth_time: AUTH_TIME };
  const user = await AuthService.resolveUser(claims, { tokens: TOKENS });
  assert.strictEqual(user.id, 5);
  assert.strictEqual(db.users[0].SUB, '01JNEW', 'SUB written onto the legacy row');
  assert.strictEqual(db.users[0].ENTRA_ID, 'oid-123', 'the Entra id is kept, not cleared');
  assert.strictEqual(db.users.length, 1);

  const before = db.calls.length;
  await AuthService.resolveUser(claims, { tokens: TOKENS });
  const since = db.calls.slice(before).map((c) => c.sql.replace(/\s+/g, ' '));
  assert.ok(!since.some((s) => s.includes('ENTRA_ID = ?')), 'no entra lookup once SUB is set');
  assert.ok(!since.some((s) => s.includes('SET SUB = ?')), 'no second backfill');
});

test('resolveUser: an unknown subject is inserted with no Entra id and a display name from the claims', async () => {
  const db = boot({ users: [] });
  const user = await AuthService.resolveUser({ sub: '01JX', name: 'Xan', email: 'x@b.test', roles: ['admin'], auth_time: AUTH_TIME }, { tokens: TOKENS });
  assert.strictEqual(user.displayName, 'Xan');
  assert.strictEqual(db.users[0].SUB, '01JX');
  assert.strictEqual(db.users[0].ENTRA_ID, null);

  const noName = await AuthService.resolveUser({ sub: '01JNONAME', preferred_username: 'nn', auth_time: AUTH_TIME }, { tokens: TOKENS });
  assert.strictEqual(noName.displayName, 'nn', 'preferred_username stands in for a missing name');
  assert.strictEqual(noName.email, '', 'EMAIL is NOT NULL — an absent email is the empty string, as before');
});

test('resolveUser: under bypass the legacy dev row (ENTRA_ID=dev-user) is reused and backfilled', async () => {
  const db = boot({ users: [row({ ID: 1, ENTRA_ID: 'dev-user', EMAIL: 'dev@tally.local', DISPLAY_NAME: 'Dev User' })] });
  const user = await AuthService.resolveUser({ sub: 'dev', name: 'Dev User', roles: ['admin'], entra_oid: null, auth_time: AUTH_TIME }, { tokens: null });
  assert.strictEqual(user.id, 1);
  assert.strictEqual(db.users[0].SUB, 'dev');
  assert.strictEqual(db.users.length, 1);
});

test('resolveUser: a real login never matches the dev row — only the bypass principal does', async () => {
  const db = boot({ users: [row({ ID: 1, ENTRA_ID: 'dev-user', DISPLAY_NAME: 'Dev User' })] });
  const user = await AuthService.resolveUser({ sub: 'dev', name: 'Impostor', auth_time: AUTH_TIME }, { tokens: TOKENS });
  assert.notStrictEqual(user.id, 1);
  assert.strictEqual(db.users.length, 2);
});

test('resolveUser: LAST_LOGIN_AT is auth_time and only moves forward — a refresh with the same auth_time is a no-op', async () => {
  const db = boot({ users: [row({ ID: 3, SUB: '01JSUB' })] });
  const login = await AuthService.resolveUser({ sub: '01JSUB', auth_time: AUTH_TIME }, { tokens: TOKENS });
  assert.strictEqual(login.lastLoginAt.getTime(), AUTH_TIME * 1000);
  assert.strictEqual(db.users[0].LAST_LOGIN_AT.getTime(), AUTH_TIME * 1000);

  await AuthService.resolveUser({ sub: '01JSUB', auth_time: AUTH_TIME }, { tokens: TOKENS });
  const stamp = db.calls.filter((c) => /SET LAST_LOGIN_AT/.test(c.sql));
  assert.strictEqual(stamp.length, 2);
  assert.strictEqual(stamp[1].params[0].getTime(), AUTH_TIME * 1000, 'the predicate carries auth_time, not NOW()');

  const older = await AuthService.resolveUser({ sub: '01JSUB', auth_time: AUTH_TIME - 3600 }, { tokens: TOKENS });
  assert.strictEqual(older.lastLoginAt.getTime(), AUTH_TIME * 1000, 'an older auth_time never rewinds it');
});

test('resolveUser: losing the unique race on a first login reads the winner\'s row', async () => {
  const db = boot({ users: [] });
  const realQuery = db.query;
  let raced = false;
  db.query = async (sql, params) => {
    if (!raced && /^INSERT INTO TALLY\.users/.test(sql)) {
      raced = true;
      await realQuery(sql, params); // the other request's insert lands first
    }
    return realQuery(sql, params);
  };
  AuthService.init({ db, config, logger: fakeLogger });
  const user = await AuthService.resolveUser({ sub: '01JRACE', name: 'Race', auth_time: AUTH_TIME }, { tokens: TOKENS });
  assert.strictEqual(db.users.length, 1);
  assert.strictEqual(user.id, db.users[0].ID);
});

test('resolveUser: refuses claims with no sub', async () => {
  boot({});
  await assert.rejects(() => AuthService.resolveUser({ name: 'nobody' }, { tokens: TOKENS }), /claims\.sub/);
});

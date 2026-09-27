const test = require('node:test');
const assert = require('node:assert');

const AuthService = require('../src/modules/auth/auth.service');
const PropertyInvitesService = require('../src/modules/inventory/property-invites.service');
const { fakeUsersDb } = require('./helpers/fake-users-db');

// The existing-account redemption half of resolveUser (plan
// 2026-09-27-invites-existing-accounts.md): on a FRESH sign-in only — the
// insert branch, or a returning row whose stored auth_time was older — ask
// pwiam which of its invites this sub redeemed and claim them. A silent
// refresh (same auth_time as already stored) must make NO pwiam call at all.
// A failure anywhere in this path is logged and swallowed, same rule as
// claimPending: it must never turn a good sign-in into a failed one.

const config = { auth: { bypassAuth: false } };
const AUTH_TIME = 1_800_000_000;
const TOKENS = { accessToken: 'opaque', claims: {} };

const row = (o) => ({ ID: 1, SUB: null, ENTRA_ID: null, EMAIL: 'a@b.test', DISPLAY_NAME: 'Ada', AVATAR_URL: null,
  CREATED_AT: new Date('2026-01-01T00:00:00Z'), LAST_LOGIN_AT: null, ...o });

let originalClaimPending;
let originalRedeemedBy;
let originalClaimRedeemed;
let redeemedByCalls;
let claimRedeemedCalls;
let loggedErrors;
const logger = { info() {}, warn() {}, error: (...a) => loggedErrors.push(a) };

test.beforeEach(() => {
  originalClaimPending = PropertyInvitesService.claimPending;
  originalRedeemedBy = PropertyInvitesService.redeemedBy;
  originalClaimRedeemed = PropertyInvitesService.claimRedeemed;
  PropertyInvitesService.claimPending = async () => {}; // not under test here
  redeemedByCalls = [];
  claimRedeemedCalls = [];
  loggedErrors = [];
});

test.afterEach(() => {
  PropertyInvitesService.claimPending = originalClaimPending;
  PropertyInvitesService.redeemedBy = originalRedeemedBy;
  PropertyInvitesService.claimRedeemed = originalClaimRedeemed;
});

test('a fresh sign-in (brand-new user, insert branch) asks pwiam and claims what it redeemed', async () => {
  PropertyInvitesService.redeemedBy = async (sub) => { redeemedByCalls.push(sub); return ['inv1', 'inv2']; };
  PropertyInvitesService.claimRedeemed = async (ids, userId) => { claimRedeemedCalls.push([ids, userId]); };
  const db = fakeUsersDb({ users: [] });
  AuthService.init({ db, config, logger });

  const user = await AuthService.resolveUser({ sub: '01JNEW', name: 'Xan', roles: ['user'], auth_time: AUTH_TIME }, { tokens: TOKENS });

  assert.deepEqual(redeemedByCalls, ['01JNEW']);
  assert.equal(claimRedeemedCalls.length, 1);
  assert.deepEqual(claimRedeemedCalls[0], [['inv1', 'inv2'], user.id]);
});

test('a fresh sign-in (returning user, newer auth_time than stored) also asks pwiam', async () => {
  PropertyInvitesService.redeemedBy = async (sub) => { redeemedByCalls.push(sub); return []; };
  PropertyInvitesService.claimRedeemed = async (ids, userId) => { claimRedeemedCalls.push([ids, userId]); };
  const db = fakeUsersDb({ users: [row({ ID: 3, SUB: '01JSUB', LAST_LOGIN_AT: new Date((AUTH_TIME - 3600) * 1000) })] });
  AuthService.init({ db, config, logger });

  await AuthService.resolveUser({ sub: '01JSUB', roles: ['user'], auth_time: AUTH_TIME }, { tokens: TOKENS });

  assert.deepEqual(redeemedByCalls, ['01JSUB']);
  assert.equal(claimRedeemedCalls.length, 1);
});

test('a silent refresh (same auth_time already stored) makes NO pwiam call', async () => {
  PropertyInvitesService.redeemedBy = async (sub) => { redeemedByCalls.push(sub); return []; };
  PropertyInvitesService.claimRedeemed = async (ids, userId) => { claimRedeemedCalls.push([ids, userId]); };
  const db = fakeUsersDb({ users: [row({ ID: 3, SUB: '01JSUB', LAST_LOGIN_AT: new Date(AUTH_TIME * 1000) })] });
  AuthService.init({ db, config, logger });

  await AuthService.resolveUser({ sub: '01JSUB', roles: ['user'], auth_time: AUTH_TIME }, { tokens: TOKENS });

  assert.equal(redeemedByCalls.length, 0, 'redeemedBy was never called on a silent refresh');
  assert.equal(claimRedeemedCalls.length, 0);
});

test('a refresh with an OLDER auth_time (never rewinds LAST_LOGIN_AT) is also not a fresh sign-in', async () => {
  PropertyInvitesService.redeemedBy = async (sub) => { redeemedByCalls.push(sub); return []; };
  PropertyInvitesService.claimRedeemed = async () => {};
  const db = fakeUsersDb({ users: [row({ ID: 3, SUB: '01JSUB', LAST_LOGIN_AT: new Date(AUTH_TIME * 1000) })] });
  AuthService.init({ db, config, logger });

  await AuthService.resolveUser({ sub: '01JSUB', roles: ['user'], auth_time: AUTH_TIME - 3600 }, { tokens: TOKENS });

  assert.equal(redeemedByCalls.length, 0);
});

test('a redeemedBy failure (pwiam unreachable) is logged at error and never blocks sign-in', async () => {
  PropertyInvitesService.redeemedBy = async () => { throw new Error('boom'); };
  PropertyInvitesService.claimRedeemed = async (ids, userId) => { claimRedeemedCalls.push([ids, userId]); };
  const db = fakeUsersDb({ users: [] });
  AuthService.init({ db, config, logger });

  const user = await AuthService.resolveUser({ sub: '01JNEW', roles: ['user'], auth_time: AUTH_TIME }, { tokens: TOKENS });

  assert.ok(user, 'sign-in still succeeds');
  assert.equal(claimRedeemedCalls.length, 0, 'claimRedeemed never runs once redeemedBy has thrown');
  assert.equal(loggedErrors.length, 1);
  assert.match(loggedErrors[0][0], /existing-account redeemed invites failed/);
  assert.equal(loggedErrors[0][1].error, 'boom');
});

test('a claimRedeemed failure (e.g. a malformed/empty pwiam body upstream) is logged at error and never blocks sign-in', async () => {
  PropertyInvitesService.redeemedBy = async () => [];
  PropertyInvitesService.claimRedeemed = async () => { throw new Error('db exploded'); };
  const db = fakeUsersDb({ users: [] });
  AuthService.init({ db, config, logger });

  const user = await AuthService.resolveUser({ sub: '01JNEW', roles: ['user'], auth_time: AUTH_TIME }, { tokens: TOKENS });

  assert.ok(user, 'sign-in still succeeds');
  assert.equal(loggedErrors.length, 1);
  assert.match(loggedErrors[0][0], /existing-account redeemed invites failed/);
});

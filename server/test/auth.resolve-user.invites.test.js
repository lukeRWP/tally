const test = require('node:test');
const assert = require('node:assert');

const AuthService = require('../src/modules/auth/auth.service');
const PropertyInvitesService = require('../src/modules/inventory/property-invites.service');
const { fakeUsersDb } = require('./helpers/fake-users-db');

// The resolveUser ↔ PropertyInvitesService wiring (plan
// 2026-09-26-property-invites.md, "Contract → tally"): resolveUser claims
// pending invites for BOTH a brand-new user and a returning one, and a claim
// failure is swallowed — logged, never thrown — so it can never turn a good
// sign-in into a failed one. claimPending's own behaviour (never downgrades,
// skips revoked, idempotent) is covered directly in
// property-invites.claim.test.js; this file only proves the hook fires and
// fails safely.

const config = { auth: { bypassAuth: false } };
const AUTH_TIME = 1_800_000_000;
const TOKENS = { accessToken: 'opaque', claims: {} };

const row = (o) => ({ ID: 1, SUB: null, ENTRA_ID: null, EMAIL: 'a@b.test', DISPLAY_NAME: 'Ada', AVATAR_URL: null,
  CREATED_AT: new Date('2026-01-01T00:00:00Z'), LAST_LOGIN_AT: null, ...o });

let originalClaimPending;
let originalRedeemedBy;
let originalClaimRedeemed;
let calls;
let loggedErrors;
const logger = { info() {}, warn() {}, error: (...a) => loggedErrors.push(a) };

test.beforeEach(() => {
  originalClaimPending = PropertyInvitesService.claimPending;
  originalRedeemedBy = PropertyInvitesService.redeemedBy;
  originalClaimRedeemed = PropertyInvitesService.claimRedeemed;
  // This file's own subject is claimPending's wiring; the existing-account
  // redemption path (plan 2026-09-27-invites-existing-accounts.md) fires on
  // the same fresh sign-ins and is covered separately in
  // auth.resolve-user.redeemed.test.js — stubbed to a no-op here so it can't
  // add its own log entries to these assertions.
  PropertyInvitesService.redeemedBy = async () => [];
  PropertyInvitesService.claimRedeemed = async () => {};
  calls = [];
  loggedErrors = [];
});

test.afterEach(() => {
  PropertyInvitesService.claimPending = originalClaimPending;
  PropertyInvitesService.redeemedBy = originalRedeemedBy;
  PropertyInvitesService.claimRedeemed = originalClaimRedeemed;
});

test('resolveUser claims pending invites for a brand-new user (insert branch)', async () => {
  PropertyInvitesService.claimPending = async (sub, userId) => { calls.push([sub, userId]); };
  const db = fakeUsersDb({ users: [] });
  AuthService.init({ db, config, logger });

  const user = await AuthService.resolveUser({ sub: '01JNEW', name: 'Xan', email: 'x@b.test', roles: ['user'], auth_time: AUTH_TIME }, { tokens: TOKENS });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['01JNEW', user.id]);
});

test('resolveUser claims pending invites for a RETURNING user (matched-by-SUB branch)', async () => {
  PropertyInvitesService.claimPending = async (sub, userId) => { calls.push([sub, userId]); };
  const db = fakeUsersDb({ users: [row({ ID: 3, SUB: '01JSUB' })] });
  AuthService.init({ db, config, logger });

  const user = await AuthService.resolveUser({ sub: '01JSUB', roles: ['user'], auth_time: AUTH_TIME }, { tokens: TOKENS });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['01JSUB', 3]);
  assert.equal(user.id, 3);
});

test('resolveUser is never called for a refused (no-role) claim — nothing to claim for a session that never starts', async () => {
  PropertyInvitesService.claimPending = async (sub, userId) => { calls.push([sub, userId]); };
  const db = fakeUsersDb({ users: [] });
  AuthService.init({ db, config, logger });

  const user = await AuthService.resolveUser({ sub: '01JNOROLE', roles: [], auth_time: AUTH_TIME }, { tokens: TOKENS });

  assert.equal(user, null);
  assert.equal(calls.length, 0);
});

test('a claimPending failure is logged at error and never blocks sign-in', async () => {
  PropertyInvitesService.claimPending = async () => { throw new Error('boom'); };
  const db = fakeUsersDb({ users: [row({ ID: 3, SUB: '01JSUB' })] });
  AuthService.init({ db, config, logger });

  const user = await AuthService.resolveUser({ sub: '01JSUB', roles: ['user'], auth_time: AUTH_TIME }, { tokens: TOKENS });

  assert.equal(user.id, 3, 'sign-in still succeeds');
  assert.equal(loggedErrors.length, 1);
  assert.match(loggedErrors[0][0], /claiming pending property invites failed/);
  assert.equal(loggedErrors[0][1].error, 'boom');
});

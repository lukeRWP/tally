const test = require('node:test');
const assert = require('node:assert');
const AuthService = require('../src/modules/auth/auth.service');
const { oauthCallback } = require('../src/modules/auth/auth.schema');

// #356: the OAuth state consume must be atomic. Two callbacks replaying the
// same `state` inside its 5-minute window both SELECT the verifier; only the
// one whose DELETE reports affectedRows === 1 may go on to exchange the code.
// These drive exchangeCode() through a scripted _db and stop it at the claim —
// nothing here reaches Entra.

const noopLogger = { warn() {}, error() {}, info() {} };

function initWith(queryImpl) {
  const calls = [];
  AuthService.init({
    db: {
      query: async (sql, params) => {
        calls.push({ sql, params });
        return queryImpl(sql, params);
      },
    },
    config: { auth: { bypassAuth: false, entraTenantId: 'tenant' } },
    logger: noopLogger,
  });
  return calls;
}

test('exchangeCode rejects an unknown or expired state before touching the code', async () => {
  initWith(() => []);
  await assert.rejects(
    () => AuthService.exchangeCode('code', 'nope'),
    /Invalid or expired state/
  );
});

test('exchangeCode claims the state with a guarded DELETE and stops when the claim loses', async () => {
  const calls = initWith((sql) => {
    if (sql.startsWith('SELECT CODE_VERIFIER')) return [{ CODE_VERIFIER: 'v' }];
    if (sql.startsWith('DELETE FROM TALLY.oauth_state WHERE STATE_KEY')) return { affectedRows: 0 };
    return [];
  });
  await assert.rejects(
    () => AuthService.exchangeCode('code', 'replayed'),
    /already consumed/
  );
  const del = calls.find((c) => c.sql.startsWith('DELETE FROM TALLY.oauth_state WHERE STATE_KEY'));
  assert.ok(del, 'issues the claim DELETE');
  assert.match(del.sql, /EXPIRES_AT > NOW\(\)/, 'the claim re-checks expiry, not just the key');
  assert.deepEqual(del.params, ['replayed']);
});

test('exchangeCode proceeds past the claim when the DELETE wins', async () => {
  // Winning the claim means the next step is the token exchange. We make that
  // step fail deterministically by pointing fetch at a stub, and assert we got
  // there — i.e. the claim did not throw.
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error('reached token exchange'); };
  try {
    initWith((sql) => {
      if (sql.startsWith('SELECT CODE_VERIFIER')) return [{ CODE_VERIFIER: 'v' }];
      if (sql.startsWith('DELETE FROM TALLY.oauth_state WHERE STATE_KEY')) return { affectedRows: 1 };
      return [];
    });
    await assert.rejects(
      () => AuthService.exchangeCode('code', 'fresh'),
      /reached token exchange/
    );
  } finally {
    global.fetch = realFetch;
  }
});

// ── callback query schema ───────────────────────────────────────────────────

test('oauthCallback schema requires code and state but tolerates Entra extras', () => {
  assert.equal(
    oauthCallback.validate({ code: 'c', state: 's', session_state: 'x' }).error,
    undefined
  );
  assert.ok(oauthCallback.validate({ state: 's' }).error, 'missing code is rejected');
  assert.ok(oauthCallback.validate({ code: 'c' }).error, 'missing state is rejected');
  assert.ok(oauthCallback.validate({ code: '', state: 's' }).error, 'empty code is rejected');
});

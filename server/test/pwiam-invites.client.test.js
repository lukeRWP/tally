const test = require('node:test');
const assert = require('node:assert');

const { pwiamInvitesClient } = require('../src/modules/auth/pwiam-invites.client');

// Everything here is against a stubbed `fetch` — no network, no pwiam. What
// matters is the status-code mapping (plan 2026-09-26-property-invites.md,
// "Contract → pwiam") and that a network failure never reaches the caller as
// a raw exception.

const config = { auth: { iam: { issuer: 'https://id.example.test', clientId: 'tally-web', clientSecret: 's3cret' } } };

function fakeFetch(responses) {
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push({ url, opts });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return {
      status: next.status,
      json: async () => next.body,
    };
  };
  fetch.calls = calls;
  return fetch;
}

const logs = [];
const logger = { error: (...a) => logs.push(a) };

test.beforeEach(() => { logs.length = 0; });

test('createInvite: 201 returns the minted ticket and sends Basic auth + the body', async () => {
  const fetch = fakeFetch([{ status: 201, body: { id: 'inv1', userId: 'u1', url: 'https://id.example.test/join/tok', expiresAt: '2026-10-03T00:00:00Z' } }]);
  const client = pwiamInvitesClient({ config, logger, fetch });

  const out = await client.createInvite({ displayName: 'Ana', invitedBy: { sub: '01JOWNER', name: 'Luke' } });
  assert.deepStrictEqual(out, { id: 'inv1', userId: 'u1', url: 'https://id.example.test/join/tok', expiresAt: '2026-10-03T00:00:00Z' });

  assert.strictEqual(fetch.calls.length, 1);
  assert.strictEqual(fetch.calls[0].url, 'https://id.example.test/rp/invites');
  assert.strictEqual(fetch.calls[0].opts.headers.Authorization, `Basic ${Buffer.from('tally-web:s3cret').toString('base64')}`);
  assert.deepStrictEqual(JSON.parse(fetch.calls[0].opts.body), { displayName: 'Ana', invitedBy: { sub: '01JOWNER', name: 'Luke' } });
});

test('createInvite: 429 cap_reached maps to a 429 with a caller-facing message', async () => {
  const client = pwiamInvitesClient({ config, logger, fetch: fakeFetch([{ status: 429, body: { error: 'cap_reached' } }]) });
  await assert.rejects(
    () => client.createInvite({ displayName: 'Ana', invitedBy: { sub: 'x', name: 'y' } }),
    (err) => { assert.strictEqual(err.statusCode, 429); assert.match(err.message, /limit reached/i); return true; }
  );
});

test('createInvite: 403 not_enabled maps to 502 for the caller, logged at error', async () => {
  const client = pwiamInvitesClient({ config, logger, fetch: fakeFetch([{ status: 403, body: { error: 'not_enabled' } }]) });
  await assert.rejects(
    () => client.createInvite({ displayName: 'Ana', invitedBy: { sub: 'x', name: 'y' } }),
    (err) => { assert.strictEqual(err.statusCode, 503); return true; }
  );
  assert.strictEqual(logs.length, 1);
});

test('createInvite: 401 invalid_client (bad credentials) maps to 502, never exposes the pwiam body', async () => {
  const client = pwiamInvitesClient({ config, logger, fetch: fakeFetch([{ status: 401, body: { error: 'invalid_client' } }]) });
  await assert.rejects(
    () => client.createInvite({ displayName: 'Ana', invitedBy: { sub: 'x', name: 'y' } }),
    (err) => { assert.strictEqual(err.statusCode, 502); assert.doesNotMatch(err.message, /invalid_client/); return true; }
  );
});

test('createInvite: a network failure (fetch throws) maps to 502, logged without the URL', async () => {
  const client = pwiamInvitesClient({ config, logger, fetch: fakeFetch([new Error('ECONNREFUSED')]) });
  await assert.rejects(
    () => client.createInvite({ displayName: 'Ana', invitedBy: { sub: 'x', name: 'y' } }),
    (err) => { assert.strictEqual(err.statusCode, 502); return true; }
  );
  assert.strictEqual(logs.length, 1);
  const loggedContext = logs[0][1];
  assert.strictEqual(loggedContext.path, '/rp/invites');
  assert.ok(!('url' in loggedContext), 'the join URL never reaches a log line');
});

test('revokeInvite: 200 returns { revoked: true }', async () => {
  const client = pwiamInvitesClient({ config, logger, fetch: fakeFetch([{ status: 200, body: { revoked: true } }]) });
  assert.deepStrictEqual(await client.revokeInvite('inv1'), { revoked: true });
});

test('revokeInvite: 404 is a value, not a throw', async () => {
  const client = pwiamInvitesClient({ config, logger, fetch: fakeFetch([{ status: 404, body: {} }]) });
  assert.deepStrictEqual(await client.revokeInvite('inv1'), { revoked: false, reason: 'not_found' });
});

test('revokeInvite: 409 redeemed is a value, not a throw', async () => {
  const client = pwiamInvitesClient({ config, logger, fetch: fakeFetch([{ status: 409, body: { error: 'redeemed' } }]) });
  assert.deepStrictEqual(await client.revokeInvite('inv1'), { revoked: false, reason: 'redeemed' });
});

test('revokeInvite: 5xx maps to 502', async () => {
  const client = pwiamInvitesClient({ config, logger, fetch: fakeFetch([{ status: 500, body: {} }]) });
  await assert.rejects(
    () => client.revokeInvite('inv1'),
    (err) => { assert.strictEqual(err.statusCode, 502); return true; }
  );
});

// redeemedBy — the existing-account half (plan
// 2026-09-27-invites-existing-accounts.md): "which of this app's invites did
// this sub redeem". Contract: POST /rp/invites/redeemed { sub } → 200
// { invites: [{ id }] }; 401/403/429/5xx/network are all failures.

test('redeemedBy: 200 returns the invite ids, sending Basic auth + { sub }', async () => {
  const fetch = fakeFetch([{ status: 200, body: { invites: [{ id: 'inv1' }, { id: 'inv2' }] } }]);
  const client = pwiamInvitesClient({ config, logger, fetch });

  const ids = await client.redeemedBy('01JEXISTING');
  assert.deepStrictEqual(ids, ['inv1', 'inv2']);

  assert.strictEqual(fetch.calls.length, 1);
  assert.strictEqual(fetch.calls[0].url, 'https://id.example.test/rp/invites/redeemed');
  assert.strictEqual(fetch.calls[0].opts.headers.Authorization, `Basic ${Buffer.from('tally-web:s3cret').toString('base64')}`);
  assert.deepStrictEqual(JSON.parse(fetch.calls[0].opts.body), { sub: '01JEXISTING' });
});

test('redeemedBy: 200 with no invites returns an empty list', async () => {
  const client = pwiamInvitesClient({ config, logger, fetch: fakeFetch([{ status: 200, body: { invites: [] } }]) });
  assert.deepStrictEqual(await client.redeemedBy('01JEXISTING'), []);
});

test('redeemedBy: a malformed 200 body (invites missing / not an array / bad shape) is a failure, not an empty list', async () => {
  for (const body of [{}, { invites: null }, { invites: [{ notId: 'x' }] }, { invites: 'inv1' }]) {
    const client = pwiamInvitesClient({ config, logger, fetch: fakeFetch([{ status: 200, body }]) });
    await assert.rejects(() => client.redeemedBy('01JEXISTING'), (err) => { assert.strictEqual(err.statusCode, 502); return true; });
  }
});

test('redeemedBy: 401 maps to 502, never exposes the pwiam body', async () => {
  const client = pwiamInvitesClient({ config, logger, fetch: fakeFetch([{ status: 401, body: { error: 'invalid_client' } }]) });
  await assert.rejects(
    () => client.redeemedBy('01JEXISTING'),
    (err) => { assert.strictEqual(err.statusCode, 502); assert.doesNotMatch(err.message, /invalid_client/); return true; }
  );
});

test('redeemedBy: 403 maps to 503', async () => {
  const client = pwiamInvitesClient({ config, logger, fetch: fakeFetch([{ status: 403, body: { error: 'not_enabled' } }]) });
  await assert.rejects(() => client.redeemedBy('01JEXISTING'), (err) => { assert.strictEqual(err.statusCode, 503); return true; });
});

test('redeemedBy: 429 maps to 429', async () => {
  const client = pwiamInvitesClient({ config, logger, fetch: fakeFetch([{ status: 429, body: { error: 'cap_reached' } }]) });
  await assert.rejects(() => client.redeemedBy('01JEXISTING'), (err) => { assert.strictEqual(err.statusCode, 429); return true; });
});

test('redeemedBy: 5xx maps to 502', async () => {
  const client = pwiamInvitesClient({ config, logger, fetch: fakeFetch([{ status: 500, body: {} }]) });
  await assert.rejects(() => client.redeemedBy('01JEXISTING'), (err) => { assert.strictEqual(err.statusCode, 502); return true; });
});

test('redeemedBy: a network failure (fetch throws) maps to 502, logged without the sub in a URL', async () => {
  const client = pwiamInvitesClient({ config, logger, fetch: fakeFetch([new Error('ECONNREFUSED')]) });
  await assert.rejects(() => client.redeemedBy('01JEXISTING'), (err) => { assert.strictEqual(err.statusCode, 502); return true; });
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(logs[0][1].path, '/rp/invites/redeemed');
});

// The abort timer must stay armed for the whole request, including reading
// the response body — not just until fetch() resolves headers. A slow or
// stalled body read (pwiam hangs after sending status 200) must still be
// abortable by the 10s timeout; clearing it right after fetch() resolves
// leaves nothing to abort a hang that happens while awaiting res.json().
test('createInvite: the timer is not cleared until AFTER the body has been read, not right after fetch() resolves', async () => {
  const order = [];
  const realClearTimeout = global.clearTimeout;
  global.clearTimeout = (...args) => { order.push('clearTimeout'); return realClearTimeout(...args); };
  try {
    const fetch = async () => ({
      status: 201,
      json: async () => {
        order.push('json');
        return { id: '1', userId: '2', url: 'https://id.example.test/join/tok', expiresAt: new Date().toISOString() };
      },
    });
    const client = pwiamInvitesClient({ config, logger, fetch });
    await client.createInvite({ displayName: 'Ana', invitedBy: { sub: 'x', name: 'y' } });
  } finally {
    global.clearTimeout = realClearTimeout;
  }
  assert.deepEqual(order, ['json', 'clearTimeout']);
});

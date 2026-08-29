const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const MatchesService = require('../src/modules/products/matches.service');
const matchesRoutes = require('../src/modules/products/matches.routes');

// Route-level tests for the three /api/products/**/matches routes (#208),
// filed as #209 because they only existed at the service layer
// (matches.service.test.js). This layer is dispatch/validation/auth/envelope
// ONLY — service logic (ownership joins, the daily spend cap, the sweep, the
// resolve transaction) is exercised there and not repeated here.
//
// Idiom copied from labels.routes.test.js: a real Express app with the real
// matches.routes.js and the real Joi `validate` middleware wired in, served
// over an ephemeral HTTP listener so requests go through actual routing —
// only MatchesService's methods are mocked, per test, with t.mock.method.
//
// The GH issue's specific worries, each pinned below:
//  - guard ordering: requireAuth before the rate limiters, so `perUser`
//    keying sees req.user.id rather than falling back to the shared IP.
//  - the config.match.enabled kill-switch is a 503 on queue ONLY — list and
//    resolve have no such gate (you can still triage/dismiss while paused).
//  - err.status (400/404/409/429) from the service must reach the response,
//    not flatten to 500 — except list()'s catch, which intentionally masks
//    the real error behind a generic message (pinned as an asymmetry, not a
//    bug to "fix" here).

const logger = { warn() {}, info() {}, error() {} };
const baseConfig = () => ({ match: { enabled: true, dailyPerUser: 30, maxAttempts: 3, staleMinutes: 5 } });

function makeApp({ db = { query: async () => [] }, config = baseConfig(), authed = true } = {}) {
  const app = express();
  app.use(express.json());
  // The real requireAuth (auth.middleware.js) 401s via the same error()
  // envelope before req.user exists; authed:false reproduces that shape.
  // authed:true keys off an x-test-user header (default 42) so the
  // guard-ordering test below can drive two distinct users through the same
  // IP without needing a real session store.
  app.locals.requireAuth = authed
    ? (req, res, next) => { req.user = { id: Number(req.headers['x-test-user'] || 42) }; next(); }
    : (req, res) => res.status(401).json({ success: false, message: 'Authentication required' });
  matchesRoutes({ app, db, logger, config });
  return app;
}

/** Run fn against a live ephemeral listener, always closing it after. */
async function withServer(fn, opts) {
  const server = makeApp(opts).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

function call(base, method, path, body, headers = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const queueBody = { itemId: 1, brand: 'DeWalt', name: 'Drill' };
const QUEUE = ['POST', '/api/products/_y_/matches', queueBody];
const LIST = ['GET', '/api/products/_x_/matches?propertyId=1', undefined];
const RESOLVE = ['POST', '/api/products/_y_/matches/1/resolve', { dismiss: true }];

// ── auth enforcement (401 probe, one per route) ──────────────────────────────

test('every route 401s an unauthenticated caller before the service ever runs', async (t) => {
  const queue = t.mock.method(MatchesService, 'queue', async () => { throw new Error('must not run'); });
  const list = t.mock.method(MatchesService, 'list', async () => { throw new Error('must not run'); });
  const resolve = t.mock.method(MatchesService, 'resolve', async () => { throw new Error('must not run'); });

  await withServer(async (base) => {
    for (const [method, path, body] of [QUEUE, LIST, RESOLVE]) {
      const res = await call(base, method, path, body);
      assert.equal(res.status, 401, `${method} ${path} must 401 when unauthenticated`);
      const json = await res.json();
      assert.equal(json.success, false);
    }
  }, { authed: false });

  assert.equal(queue.mock.callCount(), 0, 'queue must never run for an unauthenticated caller');
  assert.equal(list.mock.callCount(), 0, 'list must never run for an unauthenticated caller');
  assert.equal(resolve.mock.callCount(), 0, 'resolve must never run for an unauthenticated caller');
});

// ── guard ordering: requireAuth must precede the rate limiters ──────────────

test('the queue rate limiters key on req.user.id, proving requireAuth runs first', async (t) => {
  // If requireAuth ran AFTER matchBurst/matchDaily (or were skipped), the
  // limiters' perUser keyGenerator would find no req.user yet and fall back
  // to ipKeyGenerator(req.ip) — every request in this test shares one IP
  // (127.0.0.1), so two distinct users would collide into the same bucket
  // and the second user's very first request would already be capped.
  // dailyPerUser: 1 makes that collision observable in a single extra call.
  t.mock.method(MatchesService, 'queue', async () => ({ id: 1, status: 'none' }));
  const config = { match: { enabled: true, dailyPerUser: 1, maxAttempts: 3, staleMinutes: 5 } };

  await withServer(async (base) => {
    const first = await call(base, 'POST', '/api/products/_y_/matches', queueBody, { 'x-test-user': '1' });
    assert.equal(first.status, 200, 'user 1s first request is under the cap');

    const repeat = await call(base, 'POST', '/api/products/_y_/matches', queueBody, { 'x-test-user': '1' });
    assert.equal(repeat.status, 429, 'user 1s second request in the window is capped');

    const other = await call(base, 'POST', '/api/products/_y_/matches', queueBody, { 'x-test-user': '2' });
    assert.equal(other.status, 200,
      'a DIFFERENT user from the same IP must not inherit user 1s exhausted budget');
  }, { config });
});

// ── Joi validation (400, before the service runs) ───────────────────────────

test('queue rejects a missing/malformed body with 400 and never calls the service', async (t) => {
  const queue = t.mock.method(MatchesService, 'queue', async () => { throw new Error('must not run'); });

  await withServer(async (base) => {
    for (const bad of [
      {},                                                 // nothing at all
      { brand: 'DeWalt', name: 'Drill' },                  // missing itemId
      { itemId: 1, name: 'Drill' },                        // missing brand
      { itemId: 1, brand: 'DeWalt' },                      // missing name
      { itemId: 'abc', brand: 'DeWalt', name: 'Drill' },   // non-numeric id
      { itemId: -1, brand: 'DeWalt', name: 'Drill' },      // non-positive id
      { itemId: 0, brand: 'DeWalt', name: 'Drill' },
    ]) {
      const res = await call(base, 'POST', '/api/products/_y_/matches', bad);
      assert.equal(res.status, 400, `${JSON.stringify(bad)} must be rejected`);
      const json = await res.json();
      assert.equal(json.success, false);
      assert.ok(Array.isArray(json.errors) && json.errors.length > 0, 'the envelope carries field errors');
    }
  });
  assert.equal(queue.mock.callCount(), 0);
});

test('list rejects a missing or non-numeric propertyId with 400', async (t) => {
  const list = t.mock.method(MatchesService, 'list', async () => { throw new Error('must not run'); });

  await withServer(async (base) => {
    for (const qs of ['', '?propertyId=abc', '?propertyId=-1', '?propertyId=0']) {
      const res = await call(base, 'GET', `/api/products/_x_/matches${qs}`);
      assert.equal(res.status, 400, `propertyId ${qs || '(missing)'} must be rejected`);
      assert.equal((await res.json()).success, false);
    }
  });
  assert.equal(list.mock.callCount(), 0);
});

test('resolve requires exactly one of candidateIndex/dismiss (Joi xor)', async (t) => {
  const resolve = t.mock.method(MatchesService, 'resolve', async () => { throw new Error('must not run'); });

  await withServer(async (base) => {
    for (const bad of [
      {},                                       // neither
      { candidateIndex: 0, dismiss: true },      // both — xor forbids this too
      { candidateIndex: -1 },                    // below min
      { candidateIndex: 10 },                    // above max (0-9)
      { dismiss: 'yes' },                        // wrong type
    ]) {
      const res = await call(base, 'POST', '/api/products/_y_/matches/1/resolve', bad);
      assert.equal(res.status, 400, `${JSON.stringify(bad)} must be rejected`);
      assert.equal((await res.json()).success, false);
    }
  });
  assert.equal(resolve.mock.callCount(), 0);
});

// ── happy paths — envelope + dispatch, service mocked ───────────────────────

test('queue happy path returns the {success,data} envelope and fires runNow only when queued', async (t) => {
  const queue = t.mock.method(MatchesService, 'queue', async () => ({ id: 5, status: 'queued' }));
  const runNow = t.mock.method(MatchesService, 'runNow', async () => {});

  await withServer(async (base) => {
    const res = await call(base, 'POST', '/api/products/_y_/matches', queueBody);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.deepEqual(json.data, { id: 5, status: 'queued' });
  });

  assert.equal(queue.mock.callCount(), 1);
  assert.deepEqual(queue.mock.calls[0].arguments, [queueBody, 42]);
  assert.equal(runNow.mock.callCount(), 1, 'a freshly queued row must trigger the runner');
  assert.deepEqual(runNow.mock.calls[0].arguments, [5]);
});

test('queue does NOT re-fire the runner for an already-decided re-queue', async (t) => {
  t.mock.method(MatchesService, 'queue', async () => ({ id: 5, status: 'resolved' }));
  const runNow = t.mock.method(MatchesService, 'runNow', async () => {});

  await withServer(async (base) => {
    const res = await call(base, 'POST', '/api/products/_y_/matches', queueBody);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).data, { id: 5, status: 'resolved' });
  });
  assert.equal(runNow.mock.callCount(), 0,
    'a re-queue of a resolved/dismissed row must not re-run a search over the decision');
});

test('list happy path returns the worklist for the authenticated user and requested property', async (t) => {
  const rows = [{ id: 1, itemId: 7, status: 'ready', candidates: [], lastError: null, createdAt: '2026-08-29' }];
  const list = t.mock.method(MatchesService, 'list', async () => rows);

  await withServer(async (base) => {
    const res = await call(base, 'GET', '/api/products/_x_/matches?propertyId=3');
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.deepEqual(json.data, rows);
  });
  assert.deepEqual(list.mock.calls[0].arguments, [3, 42], 'propertyId is coerced to a Number, userId follows');
});

test('resolve happy path (candidateIndex) returns the linked product envelope', async (t) => {
  const resolve = t.mock.method(MatchesService, 'resolve',
    async () => ({ product: { id: 9, name: 'Drill', brand: 'DeWalt', barcode: '012345' }, duplicates: [] }));

  await withServer(async (base) => {
    const res = await call(base, 'POST', '/api/products/_y_/matches/1/resolve', { candidateIndex: 2 });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.data.product.id, 9);
  });
  assert.deepEqual(resolve.mock.calls[0].arguments, [1, 42, { candidateIndex: 2 }]);
});

test('resolve happy path (dismiss) returns a null product', async (t) => {
  const resolve = t.mock.method(MatchesService, 'resolve', async () => ({ product: null, duplicates: [] }));

  await withServer(async (base) => {
    const res = await call(base, 'POST', '/api/products/_y_/matches/1/resolve', { dismiss: true });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).data, { product: null, duplicates: [] });
  });
  assert.deepEqual(resolve.mock.calls[0].arguments, [1, 42, { dismiss: true }]);
});

// ── err.status survives (400/404/409/429), except list()'s masked 500 ──────

test('resolve/dismiss of a non-ready row surfaces the service 409, not a flattened 500', async (t) => {
  t.mock.method(MatchesService, 'resolve', async () => {
    const err = new Error('Match is already resolved');
    err.status = 409;
    throw err;
  });

  await withServer(async (base) => {
    const res = await call(base, 'POST', '/api/products/_y_/matches/1/resolve', { dismiss: true });
    assert.equal(res.status, 409, 'a stale-status resolve/dismiss must surface 409, the client relies on it');
    const json = await res.json();
    assert.equal(json.success, false);
    assert.equal(json.message, 'Match is already resolved');
  });
});

test('resolve surfaces the service 404 (unowned/missing match)', async (t) => {
  t.mock.method(MatchesService, 'resolve', async () => {
    const err = new Error('Match not found');
    err.status = 404;
    throw err;
  });
  await withServer(async (base) => {
    const res = await call(base, 'POST', '/api/products/_y_/matches/1/resolve', { candidateIndex: 0 });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).message, 'Match not found');
  });
});

test('resolve surfaces the service 400 (no such candidate index)', async (t) => {
  t.mock.method(MatchesService, 'resolve', async () => {
    const err = new Error('No such candidate');
    err.status = 400;
    throw err;
  });
  await withServer(async (base) => {
    const res = await call(base, 'POST', '/api/products/_y_/matches/1/resolve', { candidateIndex: 9 });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).message, 'No such candidate');
  });
});

test('resolve falls back to 500 only when the service error carries no status', async (t) => {
  t.mock.method(MatchesService, 'resolve', async () => { throw new Error('boom'); });
  await withServer(async (base) => {
    const res = await call(base, 'POST', '/api/products/_y_/matches/1/resolve', { dismiss: true });
    assert.equal(res.status, 500);
  });
});

test('queue surfaces the service 404 (item not owned/found) and 429 (daily cap)', async (t) => {
  t.mock.method(MatchesService, 'queue', async () => {
    const err = new Error('Item not found');
    err.status = 404;
    throw err;
  });
  await withServer(async (base) => {
    const res = await call(base, 'POST', '/api/products/_y_/matches', queueBody);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).message, 'Item not found');
  });

  t.mock.method(MatchesService, 'queue', async () => {
    const err = new Error('Daily product-match limit reached');
    err.status = 429;
    throw err;
  });
  await withServer(async (base) => {
    const res = await call(base, 'POST', '/api/products/_y_/matches', queueBody);
    assert.equal(res.status, 429, 'the service-level daily cap must survive too, not just the HTTP limiter');
  });
});

test('list masks the real error behind a generic 500 message (asymmetric with queue/resolve, by design)', async (t) => {
  t.mock.method(MatchesService, 'list', async () => { throw new Error('ER_LOCK_WAIT_TIMEOUT some internal detail'); });
  await withServer(async (base) => {
    const res = await call(base, 'GET', '/api/products/_x_/matches?propertyId=1');
    assert.equal(res.status, 500);
    const json = await res.json();
    assert.equal(json.message, 'Could not load product matches', 'the raw db error must not leak to the client');
  });
});

// ── config.match.enabled kill-switch: queue only ────────────────────────────

test('queue 503s while matching is disabled, without ever reaching the service', async (t) => {
  const queue = t.mock.method(MatchesService, 'queue', async () => { throw new Error('must not run'); });
  const config = { match: { enabled: false, dailyPerUser: 30, maxAttempts: 3, staleMinutes: 5 } };

  await withServer(async (base) => {
    const res = await call(base, 'POST', '/api/products/_y_/matches', queueBody);
    assert.equal(res.status, 503);
    const json = await res.json();
    assert.equal(json.success, false);
    assert.equal(json.message, 'Product matching is disabled');
  }, { config });
  assert.equal(queue.mock.callCount(), 0, 'the kill-switch must short-circuit before the service is called');
});

test('list and resolve are NOT gated by config.match.enabled — triage stays available while paused', async (t) => {
  t.mock.method(MatchesService, 'list', async () => []);
  t.mock.method(MatchesService, 'resolve', async () => ({ product: null, duplicates: [] }));
  const config = { match: { enabled: false, dailyPerUser: 30, maxAttempts: 3, staleMinutes: 5 } };

  await withServer(async (base) => {
    const listRes = await call(base, 'GET', '/api/products/_x_/matches?propertyId=1');
    assert.equal(listRes.status, 200, 'listing existing matches must work even while queueing is disabled');

    const resolveRes = await call(base, 'POST', '/api/products/_y_/matches/1/resolve', { dismiss: true });
    assert.equal(resolveRes.status, 200, 'resolving/dismissing an existing match must work even while disabled');
  }, { config });
});

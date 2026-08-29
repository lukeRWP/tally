const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const rateLimit = require('express-rate-limit');
const errorHandler = require('../src/middleware/error-handler');
const validate = require('../src/middleware/validate');
const Joi = require('joi');

// Express 5 migration pins (#20). Three behaviours the migration guide calls
// out as changed, each load-bearing here:
//
//  1. Rejected async handlers/middleware forward to the error handler
//     NATIVELY — index.js no longer loads the express-async-errors
//     monkey-patch, so this is the only thing standing between an async throw
//     and a hung request.
//  2. app.use(path) mount matching stays segment-aware — index.js's rate
//     limiter exemption (AGENT_PATHS) depends on '/api/print/_y_/agent'
//     NOT matching the user-facing '/api/print/_y_/agents' (token issuance
//     must stay under the global limiter — see the comment in index.js).
//  3. req.query is a prototype getter with no setter, so validate()'s old
//     `req.query = value` would be a silent sloppy-mode no-op — the
//     defineProperty fix must actually land the Joi-coerced value.

/** Run fn against a live ephemeral listener, always closing it after. */
async function withServer(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

// ── 1. native async error forwarding (express-async-errors removed) ─────────

test('a rejected async handler reaches the real error handler as a 500 envelope', async () => {
  const app = express();
  app.get('/boom', async () => {
    throw new Error('async kaboom');
  });
  app.use(errorHandler);

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/boom`);
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.success, false);
    // NODE_ENV is not production under the test runner, so the message passes through
    assert.equal(body.message, 'async kaboom');
  });
});

test('an async err.status 4xx passes through the error handler, not flattened to 500', async () => {
  const app = express();
  app.get('/conflict', async () => {
    const err = new Error('already resolved');
    err.status = 409;
    throw err;
  });
  app.use(errorHandler);

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/conflict`);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.message, 'already resolved');
  });
});

test('a rejected async MIDDLEWARE (not just handlers) forwards to the error handler', async () => {
  const app = express();
  app.use(async () => {
    throw new Error('middleware kaboom');
  });
  app.get('/never', (req, res) => res.json({ reached: true }));
  app.use(errorHandler);

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/never`);
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.message, 'middleware kaboom');
  });
});

// ── 2. segment-aware limiter exemption (index.js AGENT_PATHS pattern) ───────

// Mirrors index.js exactly: a global limiter that SKIPs the agent paths, plus
// a higher-budget limiter mounted AT those paths. The two invariants:
//  - '/api/print/_y_/agents' (printer registration — issues tokens) must stay
//    under the GLOBAL limiter: skipped by neither a bare prefix match nor a
//    swallowing app.use mount.
//  - '/api/print/_y_/agent/claim' must be exempt from the global limiter and
//    bound by the agent one.
function agentLimiterApp() {
  const app = express();
  const AGENT_PATHS = ['/api/print/_y_/agent', '/api/print/_x_/agent'];
  const isAgentPath = (req) => AGENT_PATHS.some(p => req.path === p || req.path.startsWith(`${p}/`));
  app.use(rateLimit({
    windowMs: 60 * 1000, max: 2, standardHeaders: true, legacyHeaders: false,
    skip: isAgentPath,
  }));
  const agentLimiter = rateLimit({ windowMs: 60 * 1000, max: 4, standardHeaders: true, legacyHeaders: false });
  AGENT_PATHS.forEach(p => app.use(p, agentLimiter));

  app.post('/api/print/_y_/agents', (req, res) => res.json({ route: 'register' }));
  app.post('/api/print/_y_/agent/claim', (req, res) => res.json({ route: 'claim' }));
  return app;
}

test('user-facing /agents stays under the global limiter (segment-aware skip holds in express 5)', async () => {
  await withServer(agentLimiterApp(), async (base) => {
    const codes = [];
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${base}/api/print/_y_/agents`, { method: 'POST' });
      codes.push(res.status);
    }
    // global max is 2 — the third registration call must 429
    assert.deepEqual(codes, [200, 200, 429]);
  });
});

test('agent /claim is exempt from the global limiter but bound by the agent budget', async () => {
  await withServer(agentLimiterApp(), async (base) => {
    const codes = [];
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${base}/api/print/_y_/agent/claim`, { method: 'POST' });
      codes.push(res.status);
    }
    // past the global max of 2 (exempt), stopped only by the agent max of 4
    assert.deepEqual(codes, [200, 200, 200, 200, 429]);
  });
});

// ── 3. validate(schema, 'query') lands the coerced value on req.query ───────

test('query validation coerces, defaults and strips onto req.query despite the v5 getter', async () => {
  const schema = Joi.object({
    propertyId: Joi.number().integer().required(),
    limit: Joi.number().integer().default(25),
  });
  const app = express();
  app.get('/q', validate(schema, 'query'), (req, res) => res.json(req.query));
  app.use(errorHandler);

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/q?propertyId=7&rogue=1`);
    assert.equal(res.status, 200);
    const q = await res.json();
    assert.strictEqual(q.propertyId, 7, 'Joi coercion to number must actually land');
    assert.strictEqual(q.limit, 25, 'Joi defaults must actually land');
    assert.equal('rogue' in q, false, 'stripUnknown must actually land');
  });
});

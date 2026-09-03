const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const errorHandler = require('../src/middleware/error-handler');
const logger = require('../src/utils/logger');

/**
 * #354: every error the handler maps, asserted end to end through Express —
 * the status, the client-facing message, the Retry-After hint on lock
 * errors, and that credentials in the request never reach winston.
 */
async function requestFailingWith(t, makeErr, { method = 'get', path = '/x', body, env } = {}) {
  const captured = [];
  t.mock.method(logger, 'warn', (msg, ctx) => captured.push({ level: 'warn', msg, ctx }));
  t.mock.method(logger, 'error', (msg, ctx) => captured.push({ level: 'error', msg, ctx }));
  const savedEnv = process.env.NODE_ENV;
  if (env !== undefined) process.env.NODE_ENV = env;

  const app = express();
  app.use(express.json());
  app[method]('/x', (req, res, next) => next(makeErr()));
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: method.toUpperCase(),
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, retryAfter: res.headers.get('retry-after'), json: await res.json(), log: captured[0] };
  } finally {
    server.close();
    process.env.NODE_ENV = savedEnv;
  }
}

const mysqlErr = (code) => () => Object.assign(new Error(`mysql ${code}`), { code });

test('ER_LOCK_DEADLOCK → 409 with a retry hint, not a 500', async (t) => {
  const r = await requestFailingWith(t, mysqlErr('ER_LOCK_DEADLOCK'));
  assert.equal(r.status, 409);
  assert.equal(r.retryAfter, '1');
  assert.match(r.json.message, /please retry/);
  assert.equal(r.log.level, 'warn', 'a retryable conflict is not an error-level event');
  assert.equal(r.log.msg, 'MySQL lock error');
});

test('ER_LOCK_WAIT_TIMEOUT → 409 with a longer retry hint', async (t) => {
  const r = await requestFailingWith(t, mysqlErr('ER_LOCK_WAIT_TIMEOUT'));
  assert.equal(r.status, 409);
  assert.equal(r.retryAfter, '2');
});

test('constraint errors keep their mapping and carry no Retry-After', async (t) => {
  for (const [code, status] of [['ER_DUP_ENTRY', 409], ['ER_NO_REFERENCED_ROW', 400], ['ER_NO_REFERENCED_ROW_2', 400]]) {
    const r = await requestFailingWith(t, mysqlErr(code));
    assert.equal(r.status, status, code);
    assert.equal(r.retryAfter, null, `${code} is not retryable`);
  }
});

test('unknown MySQL codes still fall through to 500', async (t) => {
  const r = await requestFailingWith(t, mysqlErr('ER_BAD_FIELD_ERROR'));
  assert.equal(r.status, 500);
});

test('a 500 hides the internal message in production and shows it otherwise', async (t) => {
  const boom = () => new Error('table TALLY.ITEMS is corrupt');
  const prod = await requestFailingWith(t, boom, { env: 'production' });
  assert.equal(prod.status, 500);
  assert.equal(prod.json.message, 'Internal Server Error');
  const dev = await requestFailingWith(t, boom, { env: 'development' });
  assert.equal(dev.json.message, 'table TALLY.ITEMS is corrupt');
});

test('credentials in the body and query are redacted before they reach the log', async (t) => {
  const r = await requestFailingWith(t, () => Object.assign(new Error('nope'), { statusCode: 400 }), {
    method: 'post',
    path: '/x?access_token=qry-leak&page=3',
    body: {
      name: 'agent-1',
      apiKey: 'body-leak-1',
      authorization: 'Bearer body-leak-2',
      nested: { client_secret: 'body-leak-3', refreshToken: 'body-leak-4', idToken: 'body-leak-5', keep: 'visible' },
    },
  });
  const ctx = r.log.ctx;
  assert.equal(ctx.body.apiKey, '[REDACTED]');
  assert.equal(ctx.body.authorization, '[REDACTED]');
  assert.equal(ctx.body.nested.client_secret, '[REDACTED]');
  assert.equal(ctx.body.nested.refreshToken, '[REDACTED]');
  assert.equal(ctx.body.nested.idToken, '[REDACTED]');
  assert.equal(ctx.body.nested.keep, 'visible', 'only credential keys are touched');
  assert.equal(ctx.body.name, 'agent-1');
  assert.equal(ctx.query.access_token, '[REDACTED]');
  assert.equal(ctx.query.page, '3');
  assert.equal(ctx.url, '/x?access_token=[REDACTED]&page=3');
  assert.doesNotMatch(JSON.stringify(ctx), /leak/, 'no credential anywhere in the log context');
});

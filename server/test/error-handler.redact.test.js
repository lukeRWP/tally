const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const errorHandler = require('../src/middleware/error-handler');
const logger = require('../src/utils/logger');

/**
 * #349: the error handler logged `req.url` verbatim, and the public share
 * route puts the token — the whole credential for the page — in its path. A
 * failed share request wrote a working bearer to winston. (`params` was never
 * the leak: Express has emptied it by the time an app-level error handler
 * runs, which is why the URL has to be masked by shape.) `body` already went
 * through redactSensitive; query and the URL now do too.
 */
async function failWith(t, path) {
  const captured = [];
  t.mock.method(logger, 'warn', (msg, ctx) => captured.push(ctx));
  t.mock.method(logger, 'error', (msg, ctx) => captured.push(ctx));

  const app = express();
  app.get('/api/sharing/_x_/view/:token', (req, res, next) => {
    const err = new Error('boom');
    err.statusCode = 404;
    next(err);
  });
  app.use(errorHandler);

  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    await fetch(`http://127.0.0.1:${server.address().port}${path}`);
  } finally {
    server.close();
  }
  return captured[0];
}

test('the share token is masked in the logged URL and query, path and query string alike', async (t) => {
  const ctx = await failWith(t, '/api/sharing/_x_/view/s3cr3t-token-value?token=s3cr3t-token-value&page=2');
  assert.equal(ctx.url, '/api/sharing/_x_/view/[REDACTED]?token=[REDACTED]&page=2');
  assert.equal(ctx.query.token, '[REDACTED]');
  assert.equal(ctx.query.page, '2', 'only the sensitive keys are touched');
  assert.doesNotMatch(JSON.stringify(ctx), /s3cr3t/, 'nowhere in the log context');
});

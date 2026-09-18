const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const cookieParser = require('cookie-parser');
const pwAuth = require('@pw/auth-express');

const authRoutes = require('../src/modules/auth/auth.routes');
const csrfProtection = require('../src/middleware/csrf');
const { fakeUsersDb } = require('./helpers/fake-users-db');

// The real wiring (auth.routes.js → @pw/auth-express → AuthService.resolveUser)
// under BYPASS_AUTH, with the shim's in-memory session adapter: what local
// dev runs, and the one configuration that needs no pwiam. The OIDC flow
// itself (PKCE, code exchange, refresh, back-channel logout) is the shim's
// contract and is proven by its own suite against a fake issuer — not
// re-tested here.
const COOKIE_SECRET = 'test-cookie-secret-at-least-32-characters';
const CLIENT_URL = 'http://localhost:8080';
const fakeLogger = { info() {}, warn() {}, error() {} };

// Bypass gets what local dev has — no credentials at all; real mode gets the
// pair the deploy renders from Vault (never dialled here: discovery is lazy).
function buildConfig({ bypassAuth, credentials = !bypassAuth }) {
  return {
    isProduction: false,
    clientUrl: CLIENT_URL,
    auth: {
      bypassAuth,
      cookieSecret: COOKIE_SECRET,
      iam: {
        issuer: 'https://id.test',
        clientId: credentials ? 'tally-test' : '',
        clientSecret: credentials ? 'test-client-secret' : '',
      },
    },
  };
}

async function startApp({ bypassAuth = true } = {}) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(COOKIE_SECRET));
  app.use(csrfProtection());
  const db = fakeUsersDb({ users: [] });
  authRoutes({ app, db, logger: fakeLogger, config: buildConfig({ bypassAuth }), deps: { session: pwAuth.memorySession() } });
  app.get('/api/guarded', app.locals.requireAuth, (req, res) => res.json({ id: req.user.id, sub: req.auth.sub, roles: req.auth.roles }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}`, db };
}

test('bypass: GET /api/auth/session serves the dev principal through resolveUser', async (t) => {
  const { server, baseUrl, db } = await startApp();
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/api/auth/session`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.strictEqual(body.user.displayName, 'Dev User');
  assert.strictEqual(typeof body.user.id, 'number');
  assert.strictEqual(body.auth.bypass, true);
  assert.strictEqual(db.users[0].SUB, 'dev');
});

test('bypass: a route behind app.locals.requireAuth sees req.user and req.auth', async (t) => {
  const { server, baseUrl } = await startApp();
  t.after(() => server.close());
  const res = await fetch(`${baseUrl}/api/guarded`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.sub, 'dev');
  assert.deepStrictEqual(body.roles, ['admin']);
  assert.strictEqual(typeof body.id, 'number');
});

test('bypass: GET /api/auth/login is 503 and POST /api/auth/logout is a local redirect — nothing dials an issuer', async (t) => {
  const { server, baseUrl } = await startApp();
  t.after(() => server.close());
  const login = await fetch(`${baseUrl}/api/auth/login`, { redirect: 'manual' });
  assert.strictEqual(login.status, 503);
  assert.strictEqual((await login.json()).error, 'bypass');
  const logout = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST' });
  assert.strictEqual(logout.status, 200);
  assert.strictEqual((await logout.json()).redirect, `${CLIENT_URL}/`);
});

test('real mode: no session cookie is a 401 with the login URL for a JSON client, a 302 to it for a browser', async (t) => {
  const { server, baseUrl } = await startApp({ bypassAuth: false });
  t.after(() => server.close());
  const api = await fetch(`${baseUrl}/api/auth/session`);
  assert.strictEqual(api.status, 401);
  const body = await api.json();
  assert.strictEqual(body.error, 'unauthorized');
  assert.strictEqual(body.loginUrl, '/api/auth/login?return_to=%2Fapi%2Fauth%2Fsession');
  const browser = await fetch(`${baseUrl}/api/guarded`, { redirect: 'manual', headers: { Accept: 'text/html' } });
  assert.strictEqual(browser.status, 302);
  assert.strictEqual(browser.headers.get('location'), '/api/auth/login?return_to=%2Fapi%2Fguarded');
});

test('real mode: the shim refuses to boot without client credentials — a misconfigured prod cannot come up half-authenticated', () => {
  const app = express();
  const config = buildConfig({ bypassAuth: false, credentials: false });
  assert.throws(
    () => authRoutes({ app, db: fakeUsersDb({}), logger: fakeLogger, config, deps: { session: pwAuth.memorySession() } }),
    /clientId/
  );
});

test('csrf: the session cookie\'s PRESENCE arms the double-submit check (the shim signs it, cookie-parser does not)', async (t) => {
  const app = express();
  app.use(cookieParser(COOKIE_SECRET));
  app.use(csrfProtection());
  app.post('/api/thing', (req, res) => res.json({ ok: true }));
  app.post('/api/auth/backchannel-logout', (req, res) => res.json({ ok: true }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // The shim's cookie shape: value.signature, no cookie-parser `s:` prefix.
  // Built from repeats so the secret scanner does not mistake a fixture for
  // a credential — the middleware only looks at presence, never the value.
  const session = `session_token=${'a'.repeat(32)}.${'b'.repeat(16)}`;

  assert.strictEqual((await fetch(`${baseUrl}/api/thing`, { method: 'POST' })).status, 200, 'no session → nothing to protect');
  assert.strictEqual((await fetch(`${baseUrl}/api/thing`, { method: 'POST', headers: { Cookie: `${session}; csrf_token=tok` } })).status, 403, 'session present, header missing → refused');
  assert.strictEqual((await fetch(`${baseUrl}/api/thing`, { method: 'POST', headers: { Cookie: `${session}; csrf_token=tok`, 'X-CSRF-Token': 'other' } })).status, 403);
  assert.strictEqual((await fetch(`${baseUrl}/api/thing`, { method: 'POST', headers: { Cookie: `${session}; csrf_token=tok`, 'X-CSRF-Token': 'tok' } })).status, 200);

  const minted = await fetch(`${baseUrl}/api/thing`, { method: 'GET', headers: { Cookie: session } });
  assert.ok(minted.headers.getSetCookie().some((c) => c.startsWith('csrf_token=')), 'an authenticated GET mints the csrf cookie the client echoes back');

  const bcl = await fetch(`${baseUrl}/api/auth/backchannel-logout`, { method: 'POST', headers: { Cookie: `${session}; csrf_token=tok` } });
  assert.strictEqual(bcl.status, 200, 'back-channel logout is exempt: the issuer has no cookie and no header');
});

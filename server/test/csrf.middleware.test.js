const test = require('node:test');
const assert = require('node:assert');
const csrfProtection = require('../src/middleware/csrf');

// pw-auth-express v0.4.0 renames the session cookie to `__Host-session_token`
// in production (cookie.secure: true — see auth.routes.js). hasSession must
// recognise that name too, or CSRF validation silently stops running on every
// state-changing request once the shim is upgraded past 0.4.0 — see csrf.js.

function mockReq({ method = 'POST', path = '/api/items', cookies = {}, signedCookies = {}, headers = {} } = {}) {
  return { method, path, cookies, signedCookies, headers };
}

function mockRes() {
  return {
    statusCode: null,
    body: null,
    headersSent: false,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    cookie() { return this; },
  };
}

test('a mutating request carrying only __Host-session_token is authenticated and rejected without X-CSRF-Token', () => {
  const mw = csrfProtection();
  const req = mockReq({ cookies: { '__Host-session_token': 'abc' } });
  const res = mockRes();
  let nexted = false;
  mw(req, res, () => { nexted = true; });
  assert.equal(nexted, false, 'CSRF validation must run, not be skipped');
  assert.equal(res.statusCode, 403);
});

test('__Host-session_token in req.signedCookies is also recognised as authenticated', () => {
  const mw = csrfProtection();
  const req = mockReq({ signedCookies: { '__Host-session_token': 'abc' } });
  const res = mockRes();
  let nexted = false;
  mw(req, res, () => { nexted = true; });
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 403);
});

test('a mutating request carrying only the bare session_token is authenticated and rejected without X-CSRF-Token', () => {
  const mw = csrfProtection();
  const req = mockReq({ cookies: { session_token: 'abc' } });
  const res = mockRes();
  let nexted = false;
  mw(req, res, () => { nexted = true; });
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 403);
});

test('a mutating request with neither session cookie passes through unauthenticated, as today', () => {
  const mw = csrfProtection();
  const req = mockReq({ cookies: {} });
  const res = mockRes();
  let nexted = false;
  mw(req, res, () => { nexted = true; });
  assert.equal(nexted, true);
  assert.equal(res.statusCode, null);
});

test('a matching X-CSRF-Token header is accepted when __Host-session_token is present', () => {
  const mw = csrfProtection();
  const req = mockReq({
    cookies: { '__Host-session_token': 'abc', csrf_token: 'tok-1' },
    headers: { 'x-csrf-token': 'tok-1' },
  });
  const res = mockRes();
  let nexted = false;
  mw(req, res, () => { nexted = true; });
  assert.equal(nexted, true);
  assert.equal(res.statusCode, null);
});

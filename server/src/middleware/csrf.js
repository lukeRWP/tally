const crypto = require('crypto');
const { error } = require('../utils/response');

/**
 * Double-submit cookie CSRF protection.
 *
 * On every authenticated response, sets a `csrf_token` cookie (readable by JS).
 * On state-changing requests (POST/PUT/PATCH/DELETE), validates that the
 * X-CSRF-Token header matches the csrf_token cookie.
 *
 * "Authenticated" means a session cookie is PRESENT, not that cookie-parser
 * verified it: @pw/auth-express signs that cookie with its own HMAC
 * (`value.signature`), which cookie-parser does not recognise as one of its
 * `s:` signed cookies — so `req.signedCookies` alone would always be empty
 * and this check would silently never run. cookie-parser moves an `s:` cookie
 * out of req.cookies into req.signedCookies, so both are read. The shim
 * verifies the signature itself in requireAuth; presence is all the
 * double-submit needs to decide whether a session is at stake.
 *
 * pw-auth-express v0.4.0+ names the cookie `__Host-session_token` whenever
 * it's issued with `secure: true` (production, here — auth.routes.js), and
 * only falls back to the bare `session_token` name in dev (`secure: false`).
 * Both names are checked so this keeps working either way, and so a session
 * cookie set by a pre-0.4.0 deploy is still honoured for CSRF purposes until
 * it expires. Missing either name here would make hasSession always false in
 * production and skip CSRF validation entirely — see hasSessionCookie.
 *
 * Safe methods (GET/HEAD/OPTIONS) and the paths below are exempt.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const EXEMPT_PATHS = [
  '/api/auth/backchannel-logout',  // OIDC back-channel logout: pwiam POSTs a
                                    // logout_token with no browser, no cookie,
                                    // no header. Verified by the shim against
                                    // the issuer's JWKS, which is the guard.
  '/api/sharing/_x_/view/',        // Public share links — no auth
];

// Both names must be recognised: the __Host- prefixed name pw-auth-express
// v0.4.0+ uses in production, and the bare name it still uses in dev (or that
// a pre-upgrade session cookie was set with).
const SESSION_COOKIE_NAMES = ['__Host-session_token', 'session_token'];

function hasSessionCookie(req) {
  return SESSION_COOKIE_NAMES.some(
    (name) => req.cookies?.[name] || req.signedCookies?.[name]
  );
}

function csrfProtection() {
  return (req, res, next) => {
    const hasSession = hasSessionCookie(req);

    // Always set/refresh the CSRF cookie on authenticated requests
    if (hasSession && !res.headersSent) {
      let token = req.cookies?.csrf_token;
      if (!token) {
        token = crypto.randomBytes(32).toString('hex');
      }
      res.cookie('csrf_token', token, {
        httpOnly: false,   // JS must read this
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000,
        path: '/',
      });
    }

    // Skip validation for safe methods
    if (SAFE_METHODS.has(req.method)) return next();

    // Skip exempt paths
    if (EXEMPT_PATHS.some(p => req.path.startsWith(p))) return next();

    // Skip if no session cookie (unauthenticated requests)
    if (!hasSession) return next();

    // Validate: X-CSRF-Token header must match csrf_token cookie
    const headerToken = req.headers['x-csrf-token'];
    const cookieToken = req.cookies?.csrf_token;

    if (!headerToken || !cookieToken || headerToken !== cookieToken) {
      return error(res, 'CSRF token missing or invalid', 403);
    }

    next();
  };
}

module.exports = csrfProtection;

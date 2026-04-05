const crypto = require('crypto');
const { error } = require('../utils/response');

/**
 * Double-submit cookie CSRF protection.
 *
 * On every authenticated response, sets a `csrf_token` cookie (readable by JS).
 * On state-changing requests (POST/PUT/PATCH/DELETE), validates that the
 * X-CSRF-Token header matches the csrf_token cookie.
 *
 * Safe methods (GET/HEAD/OPTIONS) and the OAuth callback are exempt.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const EXEMPT_PATHS = [
  '/api/auth/_x_/oauth/callback',  // OAuth redirect — no JS to set header
  '/api/sharing/_x_/view/',        // Public share links — no auth
];

function csrfProtection() {
  return (req, res, next) => {
    // Always set/refresh the CSRF cookie on authenticated requests
    if (req.signedCookies?.session_token && !res.headersSent) {
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
    if (!req.signedCookies?.session_token) return next();

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

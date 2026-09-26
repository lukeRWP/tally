const pwAuth = require('@pw/auth-express');

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Authentication is pwiam's (PW IAM step 4, spec §7): @pw/auth-express owns
 * login (`GET /api/auth/login`), the OIDC callback (`/api/auth/callback` —
 * the redirect URI pw.json declares), the session cookie + silent refresh,
 * `GET /api/auth/session`, `POST /api/auth/logout` (RP-initiated end-session
 * at pwiam) and `POST /api/auth/backchannel-logout`. Tally contributes one
 * hook, `AuthService.resolveUser`, and keeps `resolvePropertyRole` /
 * `requireRole` — property_members is still the authority on every request.
 *
 * Those five paths are the package's contract, not tally's `_x_`/`_y_`
 * convention, and their bodies are not the `{ success, data }` envelope —
 * the client's auth store reads them with a raw fetch (auth-store.ts).
 *
 * `deps.session` lets a test hand in `pwAuth.memorySession()` instead of the
 * MySQL adapter.
 */
module.exports = function authRoutes({ app, db, logger, config, deps }) {
  const AuthService = require('./auth.service');
  AuthService.init({ db, config, logger });

  const { resolvePropertyRole, requireRole } = require('./auth.middleware');

  const bypass = config.auth.bypassAuth === true;
  const { issuer, clientId, clientSecret } = config.auth.iam;

  // The shim logs login/callback failures and back-channel logout rejections
  // at warn (pw-auth-express lib/routes.js, lib/middleware.js). Production's
  // console transport is error-only by default (LOG_LEVEL unset in pw.json —
  // utils/logger.js), so those lines would never reach `docker compose logs`.
  // Raising LOG_LEVEL globally would also surface tally's OWN routine warns
  // (a "Validation error" line on every 400, MySQL lock/constraint warns on
  // every 409 — error-handler.js) — noise that has nothing to do with sign-in.
  // Remap just the logger the SHIM sees, and only in production; dev's console
  // already shows warn (LOG_LEVEL defaults to 'debug' there).
  const shimLogger = config.isProduction
    ? { info: (...a) => logger.info(...a), warn: (...a) => logger.error(...a), error: (...a) => logger.error(...a) }
    : logger;

  const auth = pwAuth({
    issuer,
    // The shim insists on client credentials even under bypass (where it
    // never dials the issuer); local dev has none, so give it placeholders
    // there and nowhere else — config.js already forces bypass off in prod.
    clientId: clientId || (bypass ? 'bypass' : clientId),
    clientSecret: clientSecret || (bypass ? 'bypass' : clientSecret),
    baseUrl: config.clientUrl,
    secret: config.auth.cookieSecret,
    session: (deps && deps.session) || pwAuth.mysqlSession(db, { table: 'TALLY.sessions' }),
    resolveUser: (claims, ctx) => AuthService.resolveUser(claims, ctx),
    bypassAuth: bypass,
    // Local dev is plain http; a Secure cookie would never come back.
    cookie: { secure: config.isProduction },
    logger: shimLogger,
  });

  app.use(auth.routes());

  // The shim never deletes expired rows on its own. Same cadence as before;
  // unref so a test that wires this module can still exit (PW #807).
  const sweep = () =>
    auth.sweepExpiredSessions().catch((err) => logger.warn('[auth] session sweep failed', { error: err.message }));
  sweep();
  setInterval(sweep, SWEEP_INTERVAL_MS).unref();

  // Export middleware for other modules to use
  app.locals.requireAuth = auth.requireAuth;
  app.locals.resolvePropertyRole = resolvePropertyRole(db);
  app.locals.requireRole = requireRole;

  return auth;
};

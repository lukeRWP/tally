module.exports = function authRoutes({ app, db, logger, config }) {
  const AuthService = require('./auth.service');
  AuthService.init({ db, config, logger });

  const { requireAuth, resolvePropertyRole, requireRole } = require('./auth.middleware');
  const { success, error } = require('../../utils/response');

  // GET /api/auth/_x_/session — get current user
  app.get('/api/auth/_x_/session', requireAuth(AuthService), (req, res) => {
    success(res, { user: req.user });
  });

  // GET /api/auth/_x_/oauth/init — start OAuth flow
  app.get('/api/auth/_x_/oauth/init', (req, res) => {
    const { url } = AuthService.getAuthorizationUrl();
    res.redirect(url);
  });

  // GET /api/auth/_x_/oauth/callback — Entra ID callback
  app.get('/api/auth/_x_/oauth/callback', async (req, res) => {
    try {
      const { code, state } = req.query;
      const profile = await AuthService.exchangeCode(code, state);
      const user = await AuthService.findOrCreateUser(profile);
      const session = await AuthService.createSession(user.id);

      res.cookie('session_token', session.token, {
        httpOnly: true,
        secure: config.isProduction,
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000,
        signed: true,
      });

      res.redirect(config.clientUrl);
    } catch (err) {
      logger.error('OAuth callback failed', { error: err.message });
      res.redirect(`${config.clientUrl}/login?error=auth_failed`);
    }
  });

  // POST /api/auth/_y_/logout — destroy session
  app.post('/api/auth/_y_/logout', requireAuth(AuthService), async (req, res) => {
    const token = req.signedCookies?.session_token;
    if (token) await AuthService.destroySession(token);
    res.clearCookie('session_token');
    success(res, null, 'Logged out');
  });

  // Export middleware for other modules to use
  app.locals.requireAuth = requireAuth(AuthService);
  app.locals.resolvePropertyRole = resolvePropertyRole(db);
  app.locals.requireRole = requireRole;
};

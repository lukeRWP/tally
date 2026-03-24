const { error } = require('../../utils/response');

function requireAuth(authService) {
  return async (req, res, next) => {
    // BYPASS_AUTH: auto-attach dev user
    if (authService.isBypassAuth()) {
      const devUser = await authService.getOrCreateDevUser();
      req.user = devUser;
      return next();
    }

    const token = req.signedCookies?.session_token;
    if (!token) return error(res, 'Authentication required', 401);

    const session = await authService.validateSession(token);
    if (!session) return error(res, 'Session expired', 401);

    req.user = session.user;
    next();
  };
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.propertyRole) return error(res, 'No property context', 403);
    if (!roles.includes(req.propertyRole)) return error(res, 'Insufficient permissions', 403);
    next();
  };
}

function resolvePropertyRole(db) {
  return async (req, res, next) => {
    const propertyId = req.params.propertyId || req.body?.propertyId;
    if (!propertyId) return next();

    const rows = await db.query(
      'SELECT ROLE FROM TALLY.property_members WHERE PROPERTY_ID = ? AND USER_ID = ?',
      [propertyId, req.user.id]
    );
    req.propertyRole = rows[0]?.ROLE || null;
    next();
  };
}

module.exports = { requireAuth, requireRole, resolvePropertyRole };

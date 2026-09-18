const { error } = require('../../utils/response');

// requireAuth is @pw/auth-express's (auth.routes.js sets app.locals.requireAuth
// from it); what stays here is tally's own resource-level authority — a
// property membership, and its role.

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

module.exports = { requireRole, resolvePropertyRole };

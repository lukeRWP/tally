module.exports = function auditRoutes({ app, db, logger }) {
  const AuditService = require('./audit.service');
  AuditService.init({ db, logger });

  const { queryLog } = require('./audit.schema');
  const { success, error } = require('../../utils/response');

  // ── Activity log for a property ──────────────────────────────────────────

  // GET /api/audit/_x_/property/:propertyId
  app.get(
    '/api/audit/_x_/property/:propertyId',
    app.locals.requireAuth,
    app.locals.resolvePropertyRole,
    async (req, res) => {
      if (!req.propertyRole) return error(res, 'Property not found or access denied', 404);

      const { error: validationError, value } = queryLog.validate(req.query, { abortEarly: false, stripUnknown: true });
      if (validationError) {
        return error(res, 'Validation failed', 400, validationError.details.map(d => d.message));
      }

      const entries = await AuditService.getByProperty(req.params.propertyId, value);
      success(res, { entries });
    }
  );

  // ── Activity for a specific entity ───────────────────────────────────────

  // GET /api/audit/_x_/entity/:entityType/:entityId
  app.get(
    '/api/audit/_x_/entity/:entityType/:entityId',
    app.locals.requireAuth,
    async (req, res) => {
      const { error: validationError, value } = queryLog.validate(req.query, { abortEarly: false, stripUnknown: true });
      if (validationError) {
        return error(res, 'Validation failed', 400, validationError.details.map(d => d.message));
      }

      // Verify user has access to the entity's property
      const propertyId = await AuditService.getPropertyIdForEntity(req.params.entityType, req.params.entityId);
      if (!propertyId) return error(res, 'Entity not found', 404);
      const membership = await AuditService.checkMembership(propertyId, req.user.id);
      if (!membership) return error(res, 'Access denied', 403);

      const entries = await AuditService.getByEntity(req.params.entityType, req.params.entityId, value);
      success(res, { entries });
    }
  );

  // ── Recent activity across user's properties ─────────────────────────────

  // GET /api/audit/_x_/recent
  app.get(
    '/api/audit/_x_/recent',
    app.locals.requireAuth,
    async (req, res) => {
      const { error: validationError, value } = queryLog.validate(req.query, { abortEarly: false, stripUnknown: true });
      if (validationError) {
        return error(res, 'Validation failed', 400, validationError.details.map(d => d.message));
      }

      const entries = await AuditService.getRecent(req.user.id, value.limit);
      success(res, { entries });
    }
  );
};

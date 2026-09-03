module.exports = function areasRoutes({ app, db, logger }) {
  const AreasService = require('./areas.service');
  AreasService.init({ db, logger });

  const { createArea, updateArea } = require('./areas.schema');
  const { success, error } = require('../../utils/response');

  // ── Middleware ─────────────────────────────────────────────────────────────

  // For routes that take :areaId — resolve the area's property first so
  // resolvePropertyRole can pick it up from req.params.propertyId
  async function resolvePropertyFromArea(req, res, next) {
    const areaId = req.params.areaId;
    const propertyId = await AreasService.getPropertyIdForArea(areaId);
    if (!propertyId) return error(res, 'Area not found', 404);
    req.params.propertyId = propertyId;
    next();
  }

  // ── List ───────────────────────────────────────────────────────────────────

  // GET /api/areas/_x_/property/:propertyId — all areas for a property
  app.get(
    '/api/areas/_x_/property/:propertyId',
    app.locals.requireAuth,
    app.locals.resolvePropertyRole,
    async (req, res) => {
      if (!req.propertyRole) return error(res, 'Property not found or access denied', 404);
      const areas = await AreasService.getByProperty(req.params.propertyId);
      success(res, { areas });
    }
  );

  // ── Read ───────────────────────────────────────────────────────────────────

  // GET /api/areas/_x_/:areaId — single area detail
  app.get(
    '/api/areas/_x_/:areaId',
    app.locals.requireAuth,
    resolvePropertyFromArea,
    app.locals.resolvePropertyRole,
    async (req, res) => {
      if (!req.propertyRole) return error(res, 'Area not found or access denied', 404);
      const area = await AreasService.getById(req.params.areaId);
      if (!area) return error(res, 'Area not found', 404);
      success(res, { area });
    }
  );

  // ── Create ─────────────────────────────────────────────────────────────────

  // POST /api/areas/_y_/create
  app.post(
    '/api/areas/_y_/create',
    app.locals.requireAuth,
    async (req, res, next) => {
      // Validate first so we can use body.propertyId
      const { error: validationError, value } = createArea.validate(req.body, { abortEarly: false });
      if (validationError) {
        return error(res, 'Validation failed', 400, validationError.details.map(d => d.message));
      }
      req.validatedBody = value;
      next();
    },
    app.locals.resolvePropertyRole,
    app.locals.requireRole('owner', 'editor'),
    async (req, res) => {
      const value = req.validatedBody;
      const area = await AreasService.create(value, value.propertyId, req.user.id);
      success(res, { area }, 'Area created', 201);
    }
  );

  // ── Update ─────────────────────────────────────────────────────────────────

  // PUT /api/areas/_u_/:areaId
  app.put(
    '/api/areas/_u_/:areaId',
    app.locals.requireAuth,
    resolvePropertyFromArea,
    app.locals.resolvePropertyRole,
    app.locals.requireRole('owner', 'editor'),
    async (req, res) => {
      const { error: validationError, value } = updateArea.validate(req.body, { abortEarly: false });
      if (validationError) {
        return error(res, 'Validation failed', 400, validationError.details.map(d => d.message));
      }
      const area = await AreasService.update(req.params.areaId, value, req.user.id);
      success(res, { area });
    }
  );

  // ── Delete ─────────────────────────────────────────────────────────────────

  // DELETE /api/areas/_d_/:areaId
  app.delete(
    '/api/areas/_d_/:areaId',
    app.locals.requireAuth,
    resolvePropertyFromArea,
    app.locals.resolvePropertyRole,
    app.locals.requireRole('owner'),
    async (req, res) => {
      await AreasService.softDelete(req.params.areaId, req.user.id);
      success(res, null, 'Area deleted');
    }
  );
};

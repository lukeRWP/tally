module.exports = function containersRoutes({ app, db, logger }) {
  const ContainersService = require('./containers.service');
  ContainersService.init({ db, logger });

  const AreasService = require('./areas.service');

  const { createContainer, updateContainer, moveContainer } = require('./containers.schema');
  const { success, error } = require('../../utils/response');

  // ── Middleware ─────────────────────────────────────────────────────────────

  async function resolvePropertyFromContainer(req, res, next) {
    const containerId = req.params.containerId;
    const propertyId = await ContainersService.getPropertyIdForContainer(containerId);
    if (!propertyId) return error(res, 'Container not found', 404);
    req.params.propertyId = propertyId;
    next();
  }

  async function resolvePropertyFromArea(req, res, next) {
    const areaId = req.params.areaId;
    const propertyId = await AreasService.getPropertyIdForArea(areaId);
    if (!propertyId) return error(res, 'Area not found', 404);
    req.params.propertyId = propertyId;
    next();
  }

  // ── List by Area ──────────────────────────────────────────────────────────

  // GET /api/containers/_x_/area/:areaId — top-level containers for an area
  app.get(
    '/api/containers/_x_/area/:areaId',
    app.locals.requireAuth,
    resolvePropertyFromArea,
    app.locals.resolvePropertyRole,
    async (req, res) => {
      if (!req.propertyRole) return error(res, 'Area not found or access denied', 404);
      const containers = await ContainersService.getByArea(req.params.areaId);
      success(res, { containers });
    }
  );

  // ── Read ──────────────────────────────────────────────────────────────────

  // GET /api/containers/_x_/:containerId — single container detail
  app.get(
    '/api/containers/_x_/:containerId',
    app.locals.requireAuth,
    resolvePropertyFromContainer,
    app.locals.resolvePropertyRole,
    async (req, res) => {
      if (!req.propertyRole) return error(res, 'Container not found or access denied', 404);
      const container = await ContainersService.getById(req.params.containerId);
      if (!container) return error(res, 'Container not found', 404);
      success(res, { container });
    }
  );

  // ── Children ──────────────────────────────────────────────────────────────

  // GET /api/containers/_x_/:containerId/children — direct child containers
  app.get(
    '/api/containers/_x_/:containerId/children',
    app.locals.requireAuth,
    resolvePropertyFromContainer,
    app.locals.resolvePropertyRole,
    async (req, res) => {
      if (!req.propertyRole) return error(res, 'Container not found or access denied', 404);
      const containers = await ContainersService.getByParent(req.params.containerId);
      success(res, { containers });
    }
  );

  // ── All Descendant Items ──────────────────────────────────────────────────

  // GET /api/containers/_x_/:containerId/all-items — items in this + nested
  app.get(
    '/api/containers/_x_/:containerId/all-items',
    app.locals.requireAuth,
    resolvePropertyFromContainer,
    app.locals.resolvePropertyRole,
    async (req, res) => {
      if (!req.propertyRole) return error(res, 'Container not found or access denied', 404);
      const items = await ContainersService.getAllDescendantItems(req.params.containerId);
      success(res, { items });
    }
  );

  // ── Create ────────────────────────────────────────────────────────────────

  // POST /api/containers/_y_/create
  app.post(
    '/api/containers/_y_/create',
    app.locals.requireAuth,
    async (req, res, next) => {
      const { error: validationError, value } = createContainer.validate(req.body, { abortEarly: false });
      if (validationError) {
        return error(res, 'Validation failed', 422, validationError.details.map(d => d.message));
      }
      req.validatedBody = value;
      // Resolve property from the area in body
      const propertyId = await AreasService.getPropertyIdForArea(value.areaId);
      if (!propertyId) return error(res, 'Area not found', 404);
      // If nesting under a parent, it must be a LIVE container in the SAME area
      // (a container's area always equals its parent's). Blocks cross-area /
      // cross-property nesting and nesting under a recycled container.
      if (value.parentContainerId != null) {
        const parentAreaId = await ContainersService.getActiveAreaId(value.parentContainerId);
        if (parentAreaId == null) return error(res, 'Parent container not found', 404);
        if (String(parentAreaId) !== String(value.areaId)) {
          return error(res, 'Parent container must be in the same area', 400);
        }
      }
      req.params.propertyId = propertyId;
      next();
    },
    app.locals.resolvePropertyRole,
    app.locals.requireRole('owner', 'editor'),
    async (req, res) => {
      const value = req.validatedBody;
      const container = await ContainersService.create(value, req.user.id);
      success(res, { container }, 'Container created', 201);
    }
  );

  // ── Update ────────────────────────────────────────────────────────────────

  // PUT /api/containers/_u_/:containerId
  app.put(
    '/api/containers/_u_/:containerId',
    app.locals.requireAuth,
    resolvePropertyFromContainer,
    app.locals.resolvePropertyRole,
    app.locals.requireRole('owner', 'editor'),
    async (req, res) => {
      const { error: validationError, value } = updateContainer.validate(req.body, { abortEarly: false });
      if (validationError) {
        return error(res, 'Validation failed', 422, validationError.details.map(d => d.message));
      }
      const container = await ContainersService.update(req.params.containerId, value, req.user.id);
      success(res, { container });
    }
  );

  // ── Move ──────────────────────────────────────────────────────────────────

  // PATCH /api/containers/_p_/:containerId/move
  app.patch(
    '/api/containers/_p_/:containerId/move',
    app.locals.requireAuth,
    resolvePropertyFromContainer,
    app.locals.resolvePropertyRole,
    app.locals.requireRole('owner', 'editor'),
    async (req, res) => {
      const { error: validationError, value } = moveContainer.validate(req.body, { abortEarly: false });
      if (validationError) {
        return error(res, 'Validation failed', 422, validationError.details.map(d => d.message));
      }
      // Destination must be in the same property as the source — block cross-property
      // moves (a property editor must not relocate a container into another tenant's
      // property). The source property is resolved by resolvePropertyFromContainer.
      const srcPropertyId = req.params.propertyId;
      if (value.areaId !== undefined && value.areaId !== null) {
        const destAreaProperty = await AreasService.getPropertyIdForArea(value.areaId);
        if (!destAreaProperty || String(destAreaProperty) !== String(srcPropertyId)) {
          return error(res, 'Destination area must be in the same property', 400);
        }
      }
      if (value.parentContainerId !== undefined && value.parentContainerId !== null) {
        const destParentProperty = await ContainersService.getPropertyIdForContainer(value.parentContainerId);
        if (!destParentProperty || String(destParentProperty) !== String(srcPropertyId)) {
          return error(res, 'Destination container must be in the same property', 400);
        }
      }
      const container = await ContainersService.move(req.params.containerId, value.parentContainerId, value.areaId, req.user.id);
      success(res, { container });
    }
  );

  // ── Delete ────────────────────────────────────────────────────────────────

  // DELETE /api/containers/_d_/:containerId
  app.delete(
    '/api/containers/_d_/:containerId',
    app.locals.requireAuth,
    resolvePropertyFromContainer,
    app.locals.resolvePropertyRole,
    app.locals.requireRole('owner'),
    async (req, res) => {
      await ContainersService.softDelete(req.params.containerId, req.user.id);
      success(res, null, 'Container deleted');
    }
  );
};

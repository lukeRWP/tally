module.exports = function containersRoutes({ app, db, logger }) {
  const ContainersService = require('./containers.service');
  ContainersService.init({ db, logger });

  const AreasService = require('./areas.service');
  const Reconcile = require('./move-reconcile.service');

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

  // ── Whole-property tree ───────────────────────────────────────────────────

  // GET /api/containers/_x_/tree/:propertyId — every container, every depth
  // NOTE: registered before /:containerId, or "tree" is matched as an id.
  app.get(
    '/api/containers/_x_/tree/:propertyId',
    app.locals.requireAuth,
    app.locals.resolvePropertyRole,
    async (req, res) => {
      if (!req.propertyRole) return error(res, 'Property not found or access denied', 404);
      const containers = await ContainersService.getPropertyTree(req.params.propertyId, req.user.id);
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
      // Resolve the destination property. Nesting under a parent container
      // decides the effective area (and so the property) in the service —
      // areaId is only advisory there and must agree with the parent's area —
      // so a parentContainerId takes priority; a root move (no parent) falls
      // back to the areaId, if any. Neither present means "stays put".
      const srcPropertyId = req.params.propertyId;
      let destPropertyId = srcPropertyId;
      if (value.parentContainerId !== undefined && value.parentContainerId !== null) {
        destPropertyId = await ContainersService.getPropertyIdForContainer(value.parentContainerId);
        if (!destPropertyId) return error(res, 'Destination container not found', 404);
      } else if (value.areaId !== undefined && value.areaId !== null) {
        destPropertyId = await AreasService.getPropertyIdForArea(value.areaId);
        if (!destPropertyId) return error(res, 'Destination area not found', 404);
      }

      let crossProperty = null;
      if (String(destPropertyId) !== String(srcPropertyId)) {
        // Cross-property: the caller must be editor/owner THERE too — checked
        // BEFORE any preview runs, so a user without destination access never
        // gets a peek at what the move would do (that would leak the
        // destination's tag/accessory shape to someone with no right to see it).
        const destRole = await db.query(
          'SELECT ROLE FROM TALLY.property_members WHERE PROPERTY_ID = ? AND USER_ID = ?',
          [destPropertyId, req.user.id]
        );
        if (!['owner', 'editor'].includes(destRole[0]?.ROLE)) {
          return error(res, 'You need editor access to the destination property', 403);
        }
        crossProperty = { srcPropertyId: Number(srcPropertyId), destPropertyId: Number(destPropertyId) };

        // Liveness next, BEFORE the confirm gate below — a destination that
        // was recycled must 404 up front, not after the caller has already
        // confirmed a lossy move only to hit a dead end. ContainersService.move
        // re-checks this itself (under a FOR UPDATE lock, so it stays
        // authoritative against a same-instant delete), but that check runs
        // deep inside the transaction the preview below would otherwise sit
        // in front of — the same-property path is left alone; it already
        // relies solely on that deeper check, unchanged.
        if (value.parentContainerId !== undefined && value.parentContainerId !== null) {
          if (await ContainersService.getActiveAreaId(value.parentContainerId) == null) {
            return error(res, 'Destination parent container not found', 404);
          }
        } else if (value.areaId !== undefined && value.areaId !== null) {
          const liveArea = await db.query(
            'SELECT ID FROM TALLY.areas WHERE ID = ? AND DELETED_AT IS NULL',
            [value.areaId]
          );
          if (!liveArea.length) {
            return error(res, 'Destination area not found', 404);
          }
        }

        // Lossy moves need an explicit confirm; clean ones keep the scan rhythm.
        if (!value.confirm) {
          const preview = await db.withTransaction(async (tx) => {
            const set = await Reconcile.movingSet(tx, 'container', req.params.containerId);
            return Reconcile.previewConsequences(tx, set, destPropertyId);
          });
          if (Reconcile.needsConfirm(preview, value.confirm)) {
            return error(res, 'This move unlinks accessories', 409, preview);
          }
        }
      }

      const out = await ContainersService.move(
        req.params.containerId, value.parentContainerId, value.areaId, req.user.id, { crossProperty }
      );
      success(res, out);
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

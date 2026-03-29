module.exports = function itemsRoutes({ app, db, logger }) {
  const ItemsService = require('./items.service');
  ItemsService.init({ db, logger });

  const ContainersService = require('./containers.service');

  const { createItem, updateItem, moveItem, searchItems } = require('./items.schema');
  const { success, error } = require('../../utils/response');

  // ── Middleware ─────────────────────────────────────────────────────────────

  async function resolvePropertyFromItem(req, res, next) {
    const itemId = req.params.itemId;
    const propertyId = await ItemsService.getPropertyIdForItem(itemId);
    if (!propertyId) return error(res, 'Item not found', 404);
    req.params.propertyId = propertyId;
    next();
  }

  async function resolvePropertyFromContainer(req, res, next) {
    const containerId = req.params.containerId;
    const propertyId = await ContainersService.getPropertyIdForContainer(containerId);
    if (!propertyId) return error(res, 'Container not found', 404);
    req.params.propertyId = propertyId;
    next();
  }

  // ── List by Container ──────────────────────────────────────────────────────

  // GET /api/items/_x_/container/:containerId
  app.get(
    '/api/items/_x_/container/:containerId',
    app.locals.requireAuth,
    resolvePropertyFromContainer,
    app.locals.resolvePropertyRole,
    async (req, res) => {
      if (!req.propertyRole) return error(res, 'Container not found or access denied', 404);
      const items = await ItemsService.getByContainer(req.params.containerId);
      success(res, { items });
    }
  );

  // ── Search ────────────────────────────────────────────────────────────────

  // GET /api/items/_x_/search
  app.get(
    '/api/items/_x_/search',
    app.locals.requireAuth,
    async (req, res) => {
      // Normalise tagIds: may arrive as "1,2,3" CSV string or already as array
      const rawQuery = { ...req.query };
      if (typeof rawQuery.tagIds === 'string' && rawQuery.tagIds.length > 0) {
        rawQuery.tagIds = rawQuery.tagIds.split(',').map(Number).filter(n => !isNaN(n));
      }
      const { error: validationError, value } = searchItems.validate(rawQuery, { abortEarly: false });
      if (validationError) {
        return error(res, 'Validation failed', 422, validationError.details.map(d => d.message));
      }
      const items = await ItemsService.search(value.q, req.user.id, {
        tagIds: value.tagIds || null,
        condition: value.condition || null,
        status: value.status || null,
      });
      success(res, { items });
    }
  );

  // ── Recycle Bin ───────────────────────────────────────────────────────────

  // GET /api/items/_x_/deleted
  app.get(
    '/api/items/_x_/deleted',
    app.locals.requireAuth,
    async (req, res) => {
      const limit  = Math.min(parseInt(req.query.limit,  10) || 50, 200);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0,  0);
      const items = await ItemsService.getDeleted(req.user.id, { limit, offset });
      success(res, { items });
    }
  );

  // DELETE /api/items/_d_/:itemId/permanent
  app.delete(
    '/api/items/_d_/:itemId/permanent',
    app.locals.requireAuth,
    resolvePropertyFromItem,
    app.locals.resolvePropertyRole,
    app.locals.requireRole('owner'),
    async (req, res) => {
      await ItemsService.permanentDelete(req.params.itemId);
      success(res, null, 'Item permanently deleted');
    }
  );

  // POST /api/items/_y_/purge-expired
  app.post(
    '/api/items/_y_/purge-expired',
    app.locals.requireAuth,
    async (req, res) => {
      const count = await ItemsService.purgeExpired(req.user.id);
      success(res, { purged: count }, `Purged ${count} expired item(s)`);
    }
  );

  // ── Read ──────────────────────────────────────────────────────────────────

  // GET /api/items/_x_/:itemId
  app.get(
    '/api/items/_x_/:itemId',
    app.locals.requireAuth,
    resolvePropertyFromItem,
    app.locals.resolvePropertyRole,
    async (req, res) => {
      if (!req.propertyRole) return error(res, 'Item not found or access denied', 404);
      const item = await ItemsService.getById(req.params.itemId);
      if (!item) return error(res, 'Item not found', 404);
      success(res, { item });
    }
  );

  // ── Create ────────────────────────────────────────────────────────────────

  // POST /api/items/_y_/create
  app.post(
    '/api/items/_y_/create',
    app.locals.requireAuth,
    async (req, res, next) => {
      const { error: validationError, value } = createItem.validate(req.body, { abortEarly: false });
      if (validationError) {
        return error(res, 'Validation failed', 422, validationError.details.map(d => d.message));
      }
      req.validatedBody = value;
      // Resolve property from the container in body
      const propertyId = await ContainersService.getPropertyIdForContainer(value.containerId);
      if (!propertyId) return error(res, 'Container not found', 404);
      req.params.propertyId = propertyId;
      next();
    },
    app.locals.resolvePropertyRole,
    app.locals.requireRole('owner', 'editor'),
    async (req, res) => {
      const value = req.validatedBody;
      const item = await ItemsService.create(value, req.user.id);
      success(res, { item }, 'Item created', 201);
    }
  );

  // ── Update ────────────────────────────────────────────────────────────────

  // PUT /api/items/_u_/:itemId
  app.put(
    '/api/items/_u_/:itemId',
    app.locals.requireAuth,
    resolvePropertyFromItem,
    app.locals.resolvePropertyRole,
    app.locals.requireRole('owner', 'editor'),
    async (req, res) => {
      const { error: validationError, value } = updateItem.validate(req.body, { abortEarly: false });
      if (validationError) {
        return error(res, 'Validation failed', 422, validationError.details.map(d => d.message));
      }
      const item = await ItemsService.update(req.params.itemId, value, req.user.id);
      success(res, { item });
    }
  );

  // ── Move ──────────────────────────────────────────────────────────────────

  // PATCH /api/items/_p_/:itemId/move
  app.patch(
    '/api/items/_p_/:itemId/move',
    app.locals.requireAuth,
    resolvePropertyFromItem,
    app.locals.resolvePropertyRole,
    app.locals.requireRole('owner', 'editor'),
    async (req, res) => {
      const { error: validationError, value } = moveItem.validate(req.body, { abortEarly: false });
      if (validationError) {
        return error(res, 'Validation failed', 422, validationError.details.map(d => d.message));
      }
      // Verify destination container is in the same property
      const destPropertyId = await ContainersService.getPropertyIdForContainer(value.containerId);
      const srcPropertyId = req.params.propertyId;
      if (!destPropertyId || String(destPropertyId) !== String(srcPropertyId)) {
        return error(res, 'Destination container must be in the same property', 400);
      }
      const item = await ItemsService.move(req.params.itemId, value.containerId, req.user.id);
      success(res, { item });
    }
  );

  // ── Delete ────────────────────────────────────────────────────────────────

  // DELETE /api/items/_d_/:itemId
  app.delete(
    '/api/items/_d_/:itemId',
    app.locals.requireAuth,
    resolvePropertyFromItem,
    app.locals.resolvePropertyRole,
    app.locals.requireRole('owner'),
    async (req, res) => {
      await ItemsService.softDelete(req.params.itemId, req.user.id);
      success(res, null, 'Item deleted');
    }
  );
};

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
      const { error: validationError, value } = searchItems.validate(req.query, { abortEarly: false });
      if (validationError) {
        return error(res, 'Validation failed', 422, validationError.details.map(d => d.message));
      }
      const items = await ItemsService.search(value.q, req.user.id);
      success(res, { items });
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
      const item = await ItemsService.create(value);
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
      const item = await ItemsService.update(req.params.itemId, value);
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
      const item = await ItemsService.move(req.params.itemId, value.containerId);
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
      await ItemsService.softDelete(req.params.itemId);
      success(res, null, 'Item deleted');
    }
  );
};

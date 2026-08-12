module.exports = function itemsRoutes({ app, db, logger }) {
  const ItemsService = require('./items.service');
  ItemsService.init({ db, logger });

  const ContainersService = require('./containers.service');
  // Initialised here as well as in tags.routes.js. init() only assigns db and
  // logger, so the second call is a no-op — but tags.routes.js registers AFTER
  // this module, and relying on "the write only happens at request time, by
  // which point everything is registered" is an ordering assumption nobody
  // would think to preserve.
  const TagsService = require('../tags/tags.service');
  TagsService.init({ db, logger });

  // Categories arrive from photo identification, not from a person choosing a
  // colour, so they get one neutral from the thermal palette. Never
  // client-supplied: tags.COLOR is NOT NULL with no default.
  const CATEGORY_TAG_COLOR = '#8A8578';

  const { createItem, updateItem, moveItem, searchItems, recentItems } = require('./items.schema');
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

  // ── Recently Added ────────────────────────────────────────────────────────

  // GET /api/items/_x_/recent
  // Must stay above /_x_/:itemId or Express reads "recent" as an item id and
  // answers 404 forever — the same reason /search and /deleted sit up here.
  app.get(
    '/api/items/_x_/recent',
    app.locals.requireAuth,
    async (req, res) => {
      const { error: validationError, value } = recentItems.validate(req.query, { abortEarly: false });
      if (validationError) {
        return error(res, 'Validation failed', 422, validationError.details.map(d => d.message));
      }
      // There is no single property to resolve here, so no resolvePropertyRole:
      // the membership join inside the query IS the access check.
      const items = await ItemsService.getRecent(req.user.id, { limit: value.limit });
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
      // The target container must be LIVE — creating an item inside a recycled
      // container makes phantom inventory (active row hidden under a deleted
      // parent, invisible in navigation but still counted in reports/search).
      if (await ContainersService.getActiveAreaId(value.containerId) == null) {
        return error(res, 'Container not found', 404);
      }
      req.params.propertyId = propertyId;
      next();
    },
    app.locals.resolvePropertyRole,
    app.locals.requireRole('owner', 'editor'),
    async (req, res) => {
      const value = req.validatedBody;
      const { category, ...itemFields } = value;
      const item = await ItemsService.create(itemFields, req.user.id);

      // An approved category becomes a property-scoped tag. This lives here, in
      // the handler that already resolved propertyId FROM THE CONTAINER and
      // already passed requireRole('owner','editor'), so scoping and
      // authorization are structural rather than re-derived — a second endpoint
      // would be a fresh place to get the privacy invariant wrong.
      //
      // A tag failure must never fail the item: the row is written, the user's
      // own data was valid, and a collision on shared property vocabulary must
      // not surface to them as "Could not save the item".
      if (category) {
        try {
          const tag = await TagsService.findOrCreate({
            name: category,
            color: CATEGORY_TAG_COLOR,
            propertyId: req.params.propertyId,
          });
          await TagsService.addToEntity(tag.id, 'item', item.id);
        } catch (err) {
          logger.warn('Category tag write failed; item kept', {
            itemId: item.id, propertyId: req.params.propertyId,
            category, code: err?.code ?? null, message: err?.message ?? null,
          });
        }
      }

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
      // ...and it must be LIVE — moving an item into a recycled container would
      // hide it (phantom inventory), the same trap as create.
      if (await ContainersService.getActiveAreaId(value.containerId) == null) {
        return error(res, 'Destination container not found', 404);
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

  // PATCH /api/items/_p_/:itemId/restore — recover a soft-deleted item from the
  // recycle bin. resolvePropertyFromItem works on soft-deleted rows (its
  // property lookup doesn't filter DELETED_AT), same as the /permanent route.
  app.patch(
    '/api/items/_p_/:itemId/restore',
    app.locals.requireAuth,
    resolvePropertyFromItem,
    app.locals.resolvePropertyRole,
    app.locals.requireRole('owner'),
    async (req, res) => {
      // Don't restore an item into a still-recycled container — it would become
      // phantom inventory (active row hidden under a deleted parent). Require
      // the container be restored first. (Completes the create/move/restore
      // phantom-prevention set.)
      const rows = await db.query('SELECT CONTAINER_ID FROM TALLY.items WHERE ID = ?', [req.params.itemId]);
      const containerId = rows[0]?.CONTAINER_ID;
      if (containerId && (await ContainersService.getActiveAreaId(containerId)) == null) {
        return error(res, 'Restore the container this item was in before restoring the item', 409);
      }
      const item = await ItemsService.restore(req.params.itemId, req.user.id);
      success(res, { item }, 'Item restored');
    }
  );
};

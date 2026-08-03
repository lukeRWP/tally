module.exports = function accessoriesRoutes({ app, db, logger }) {
  const AccessoriesService = require('./accessories.service');
  AccessoriesService.init({ db, logger });

  const ItemsService = require('../inventory/items.service');

  const { linkAccessory } = require('./accessories.schema');
  const { success, error } = require('../../utils/response');

  // ── Middleware ─────────────────────────────────────────────────────────────

  async function resolvePropertyFromItem(req, res, next) {
    const itemId = req.params.itemId;
    const propertyId = await ItemsService.getPropertyIdForItem(itemId);
    if (!propertyId) return error(res, 'Item not found', 404);
    req.params.propertyId = propertyId;
    next();
  }

  // ── List Accessories for Item ──────────────────────────────────────────────

  // GET /api/accessories/_x_/item/:itemId
  app.get(
    '/api/accessories/_x_/item/:itemId',
    app.locals.requireAuth,
    resolvePropertyFromItem,
    app.locals.resolvePropertyRole,
    async (req, res) => {
      if (!req.propertyRole) return error(res, 'Item not found or access denied', 404);
      const accessories = await AccessoriesService.getForItem(req.params.itemId);
      success(res, { accessories });
    }
  );

  // ── Link Accessory ─────────────────────────────────────────────────────────

  // POST /api/accessories/_y_/item/:itemId/link
  app.post(
    '/api/accessories/_y_/item/:itemId/link',
    app.locals.requireAuth,
    resolvePropertyFromItem,
    app.locals.resolvePropertyRole,
    app.locals.requireRole('owner', 'editor'),
    async (req, res) => {
      const { error: validationError, value } = linkAccessory.validate(req.body, { abortEarly: false });
      if (validationError) {
        return error(res, 'Validation failed', 422, validationError.details.map(d => d.message));
      }
      // The accessory must live in the SAME property as the source item.
      // Without this, an owner/editor of their own item could link a victim
      // item ID from another household and then read its name/QR/condition
      // back via GET .../item/:itemId (getForItem JOINs items on ACCESSORY_ID).
      // Mirrors the same-property guard on item move (items.routes.js).
      const accessoryPropertyId = await ItemsService.getPropertyIdForItem(value.accessoryId);
      if (!accessoryPropertyId || String(accessoryPropertyId) !== String(req.params.propertyId)) {
        return error(res, 'Accessory must be in the same property', 400);
      }
      await AccessoriesService.link(req.params.itemId, value.accessoryId);
      success(res, null, 'Accessory linked', 201);
    }
  );

  // ── Unlink Accessory ───────────────────────────────────────────────────────

  // DELETE /api/accessories/_d_/item/:itemId/unlink/:accessoryId
  app.delete(
    '/api/accessories/_d_/item/:itemId/unlink/:accessoryId',
    app.locals.requireAuth,
    resolvePropertyFromItem,
    app.locals.resolvePropertyRole,
    app.locals.requireRole('owner', 'editor'),
    async (req, res) => {
      await AccessoriesService.unlink(req.params.itemId, req.params.accessoryId);
      success(res, null, 'Accessory unlinked');
    }
  );
};

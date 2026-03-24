module.exports = function lendingRoutes({ app, db, logger }) {
  const LendingService = require('./lending.service');
  LendingService.init({ db, logger });

  const ItemsService = require('../inventory/items.service');

  const { lendItem } = require('./lending.schema');
  const { success, error } = require('../../utils/response');

  // ── Middleware ─────────────────────────────────────────────────────────────

  async function resolvePropertyFromItem(req, res, next) {
    const itemId = req.params.itemId;
    const propertyId = await ItemsService.getPropertyIdForItem(itemId);
    if (!propertyId) return error(res, 'Item not found', 404);
    req.params.propertyId = propertyId;
    next();
  }

  async function resolvePropertyFromLending(req, res, next) {
    const lendingId = req.params.lendingId;
    const itemId = await LendingService.getItemIdForLending(lendingId);
    if (!itemId) return error(res, 'Lending record not found', 404);
    const propertyId = await ItemsService.getPropertyIdForItem(itemId);
    if (!propertyId) return error(res, 'Item not found', 404);
    req.params.propertyId = propertyId;
    next();
  }

  // ── Lend Item ─────────────────────────────────────────────────────────────

  // POST /api/lending/_y_/item/:itemId/lend
  app.post(
    '/api/lending/_y_/item/:itemId/lend',
    app.locals.requireAuth,
    resolvePropertyFromItem,
    app.locals.resolvePropertyRole,
    app.locals.requireRole('owner', 'editor'),
    async (req, res) => {
      const { error: validationError, value } = lendItem.validate(req.body, { abortEarly: false });
      if (validationError) {
        return error(res, 'Validation failed', 422, validationError.details.map(d => d.message));
      }
      const lending = await LendingService.lend(req.params.itemId, value, req.user.id);
      success(res, { lending }, 'Item lent', 201);
    }
  );

  // ── Return Item ───────────────────────────────────────────────────────────

  // PATCH /api/lending/_p_/:lendingId/return
  app.patch(
    '/api/lending/_p_/:lendingId/return',
    app.locals.requireAuth,
    resolvePropertyFromLending,
    app.locals.resolvePropertyRole,
    app.locals.requireRole('owner', 'editor'),
    async (req, res) => {
      const lending = await LendingService.return(req.params.lendingId, req.user.id);
      if (!lending) return error(res, 'Lending record not found', 404);
      success(res, { lending }, 'Item returned');
    }
  );

  // ── Get History ───────────────────────────────────────────────────────────

  // GET /api/lending/_x_/item/:itemId
  app.get(
    '/api/lending/_x_/item/:itemId',
    app.locals.requireAuth,
    resolvePropertyFromItem,
    app.locals.resolvePropertyRole,
    async (req, res) => {
      if (!req.propertyRole) return error(res, 'Item not found or access denied', 404);
      const history = await LendingService.getHistory(req.params.itemId);
      success(res, { history });
    }
  );

  // ── Get Active Lending ────────────────────────────────────────────────────

  // GET /api/lending/_x_/item/:itemId/active
  app.get(
    '/api/lending/_x_/item/:itemId/active',
    app.locals.requireAuth,
    resolvePropertyFromItem,
    app.locals.resolvePropertyRole,
    async (req, res) => {
      if (!req.propertyRole) return error(res, 'Item not found or access denied', 404);
      const lending = await LendingService.getActive(req.params.itemId);
      success(res, { lending });
    }
  );

  // ── Get Overdue ───────────────────────────────────────────────────────────

  // GET /api/lending/_x_/overdue
  app.get(
    '/api/lending/_x_/overdue',
    app.locals.requireAuth,
    async (req, res) => {
      const overdue = await LendingService.getOverdue(req.user.id);
      success(res, { overdue });
    }
  );
};

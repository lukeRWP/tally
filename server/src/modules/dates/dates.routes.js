module.exports = function datesRoutes({ app, db, logger }) {
  const DatesService = require('./dates.service');
  DatesService.init({ db, logger });

  const ItemsService = require('../inventory/items.service');

  const { createDate, updateDate } = require('./dates.schema');
  const { success, error } = require('../../utils/response');

  // ── Middleware ─────────────────────────────────────────────────────────────

  async function resolvePropertyFromItem(req, res, next) {
    const itemId = req.params.itemId;
    const propertyId = await ItemsService.getPropertyIdForItem(itemId);
    if (!propertyId) return error(res, 'Item not found', 404);
    req.params.propertyId = propertyId;
    next();
  }

  async function resolvePropertyFromDate(req, res, next) {
    const dateId = req.params.dateId;
    const itemId = await DatesService.getItemIdForDate(dateId);
    if (!itemId) return error(res, 'Date record not found', 404);
    const propertyId = await ItemsService.getPropertyIdForItem(itemId);
    if (!propertyId) return error(res, 'Item not found', 404);
    req.params.propertyId = propertyId;
    next();
  }

  // ── List Dates for Item ────────────────────────────────────────────────────

  // GET /api/dates/_x_/item/:itemId
  app.get(
    '/api/dates/_x_/item/:itemId',
    app.locals.requireAuth,
    resolvePropertyFromItem,
    app.locals.resolvePropertyRole,
    async (req, res) => {
      if (!req.propertyRole) return error(res, 'Item not found or access denied', 404);
      const dates = await DatesService.getByItem(req.params.itemId);
      success(res, { dates });
    }
  );

  // ── Create Date ───────────────────────────────────────────────────────────

  // POST /api/dates/_y_/item/:itemId
  app.post(
    '/api/dates/_y_/item/:itemId',
    app.locals.requireAuth,
    resolvePropertyFromItem,
    app.locals.resolvePropertyRole,
    app.locals.requireRole('owner', 'editor'),
    async (req, res) => {
      const { error: validationError, value } = createDate.validate(req.body, { abortEarly: false });
      if (validationError) {
        return error(res, 'Validation failed', 400, validationError.details.map(d => d.message));
      }
      const date = await DatesService.create(req.params.itemId, value);
      success(res, { date }, 'Date created', 201);
    }
  );

  // ── Update Date ───────────────────────────────────────────────────────────

  // PUT /api/dates/_u_/:dateId
  app.put(
    '/api/dates/_u_/:dateId',
    app.locals.requireAuth,
    resolvePropertyFromDate,
    app.locals.resolvePropertyRole,
    app.locals.requireRole('owner', 'editor'),
    async (req, res) => {
      const { error: validationError, value } = updateDate.validate(req.body, { abortEarly: false });
      if (validationError) {
        return error(res, 'Validation failed', 400, validationError.details.map(d => d.message));
      }
      const date = await DatesService.update(req.params.dateId, value);
      if (!date) return error(res, 'Date record not found', 404);
      success(res, { date }, 'Date updated');
    }
  );

  // ── Delete Date ───────────────────────────────────────────────────────────

  // DELETE /api/dates/_d_/:dateId
  app.delete(
    '/api/dates/_d_/:dateId',
    app.locals.requireAuth,
    resolvePropertyFromDate,
    app.locals.resolvePropertyRole,
    app.locals.requireRole('owner', 'editor'),
    async (req, res) => {
      await DatesService.delete(req.params.dateId);
      success(res, null, 'Date deleted');
    }
  );

  // ── Get Upcoming Dates ────────────────────────────────────────────────────

  // GET /api/dates/_x_/upcoming
  app.get(
    '/api/dates/_x_/upcoming',
    app.locals.requireAuth,
    async (req, res) => {
      const days = parseInt(req.query.days, 10) || 30;
      const dates = await DatesService.getUpcoming(req.user.id, days);
      success(res, { dates });
    }
  );
};

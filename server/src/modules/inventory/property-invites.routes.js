// Property invites through pwiam (plan
// docs/superpowers/plans/2026-09-26-property-invites.md, "Contract → tally").
// Owner-gated exactly like properties.routes.js's membership routes — this
// is a separate module (not folded into properties.routes.js) because it
// also owns talking to pwiam, not just TALLY.

// `deps.fetch` lets a test hand PropertyInvitesService a stub instead of the
// real network — same idiom as auth.routes.js's `deps.session`.
module.exports = function propertyInvitesRoutes({ app, db, logger, config, deps }) {
  const PropertyInvitesService = require('./property-invites.service');
  PropertyInvitesService.init({ db, logger, config, fetch: deps && deps.fetch });

  const { createInvite } = require('./property-invites.schema');
  const { success, error } = require('../../utils/response');

  // GET /api/properties/_x_/:propertyId/invites — pending invites only
  app.get(
    '/api/properties/_x_/:propertyId/invites',
    app.locals.requireAuth,
    app.locals.resolvePropertyRole,
    app.locals.requireRole('owner'),
    async (req, res) => {
      const invites = await PropertyInvitesService.listPending(req.params.propertyId);
      success(res, { invites });
    }
  );

  // POST /api/properties/_y_/:propertyId/invites
  app.post(
    '/api/properties/_y_/:propertyId/invites',
    app.locals.requireAuth,
    app.locals.resolvePropertyRole,
    app.locals.requireRole('owner'),
    async (req, res) => {
      const { error: validationError, value } = createInvite.validate(req.body, { abortEarly: false });
      if (validationError) {
        return error(res, 'Validation failed', 400, validationError.details.map((d) => d.message));
      }
      try {
        const { invite, url } = await PropertyInvitesService.create(req.params.propertyId, value, req.user.id);
        success(res, { invite, url }, 'Invite created', 201);
      } catch (err) {
        // pwiam's cap/not-enabled/unreachable outcomes carry their own
        // statusCode (pwiam-invites.client.js) — surfaced as-is, not folded
        // into the generic error handler, which would flatten every 5xx to
        // a masked 500 in production (middleware/error-handler.js only
        // trusts an explicit statusCode in the 4xx range).
        logger.warn('create invite failed', { error: err.message });
        error(res, err.message, err.statusCode || 500);
      }
    }
  );

  // DELETE /api/properties/_d_/:propertyId/invites/:inviteId
  app.delete(
    '/api/properties/_d_/:propertyId/invites/:inviteId',
    app.locals.requireAuth,
    app.locals.resolvePropertyRole,
    app.locals.requireRole('owner'),
    async (req, res) => {
      const inviteId = Number(req.params.inviteId);
      if (!Number.isInteger(inviteId) || inviteId <= 0) {
        return error(res, 'Invalid invite id', 400);
      }
      try {
        await PropertyInvitesService.revoke(req.params.propertyId, inviteId, req.user.id);
        success(res, null, 'Invite revoked');
      } catch (err) {
        logger.warn('revoke invite failed', { error: err.message });
        error(res, err.message, err.statusCode || 500);
      }
    }
  );
};

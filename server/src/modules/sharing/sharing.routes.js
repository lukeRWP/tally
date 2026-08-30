module.exports = function sharingRoutes({ app, db, logger, config }) {
  const SharingService = require('./sharing.service');
  SharingService.init({ db, logger, config });

  const ItemsService = require('../inventory/items.service');
  const ContainersService = require('../inventory/containers.service');
  const AreasService = require('../inventory/areas.service');

  const { createShareLink } = require('./sharing.schema');
  const { success, error } = require('../../utils/response');

  const { requireAuth, resolvePropertyRole, requireRole } = app.locals;

  // ── POST /api/sharing/_y_/create ───────────────────────────────────────────
  // Authenticated: create a share link

  app.post(
    '/api/sharing/_y_/create',
    requireAuth,
    async (req, res, next) => {
      const { error: validationError, value } = createShareLink.validate(req.body, { abortEarly: false });
      if (validationError) {
        return error(res, 'Validation failed', 422, validationError.details.map(d => d.message));
      }
      req.validatedBody = value;

      // Resolve property ID from entity
      const { entityType, entityId } = value;
      let propertyId = null;

      if (entityType === 'property') {
        propertyId = entityId;
      } else if (entityType === 'area') {
        propertyId = await AreasService.getPropertyIdForArea(entityId);
      } else if (entityType === 'container') {
        propertyId = await ContainersService.getPropertyIdForContainer(entityId);
      } else if (entityType === 'item') {
        propertyId = await ItemsService.getPropertyIdForItem(entityId);
      }

      if (!propertyId) {
        return error(res, 'Entity not found', 404);
      }

      req.params.propertyId = propertyId;
      next();
    },
    resolvePropertyRole,
    requireRole('owner', 'editor'),
    async (req, res) => {
      const { entityType, entityId, expiresInDays } = req.validatedBody;
      const link = await SharingService.create(entityType, entityId, req.user.id, expiresInDays);
      success(res, { link }, 'Share link created', 201);
    }
  );

  // ── GET /api/sharing/_x_/my-links ─────────────────────────────────────────
  // Authenticated: list current user's share links

  app.get(
    '/api/sharing/_x_/my-links',
    requireAuth,
    async (req, res) => {
      const links = await SharingService.getByUser(req.user.id);
      success(res, { links });
    }
  );

  // ── DELETE /api/sharing/_d_/:linkId ───────────────────────────────────────
  // Authenticated: revoke a share link

  app.delete(
    '/api/sharing/_d_/:linkId',
    requireAuth,
    async (req, res) => {
      await SharingService.revoke(req.params.linkId, req.user.id);
      success(res, null, 'Share link revoked');
    }
  );

  // ── GET /api/sharing/_x_/view/:token ──────────────────────────────────────
  // Public: NO auth middleware — validate token and return entity data

  app.get(
    '/api/sharing/_x_/view/:token',
    async (req, res) => {
      const tokenData = await SharingService.validate(req.params.token);
      if (!tokenData) {
        return error(res, 'Share link not found or expired', 404);
      }

      const entity = await SharingService.getEntityForShare(tokenData.entityType, tokenData.entityId);
      if (!entity) {
        return error(res, 'Entity not found', 404);
      }

      // `share` is framing, not inventory: it is what lets the page tell a
      // stranger who sent this and when it stops working. Deliberately the
      // sharer's DISPLAY NAME only — no email, no user id, no property roster.
      success(res, {
        entity,
        share: {
          entityType: tokenData.entityType,
          sharedByName: tokenData.createdByName,
          expiresAt: tokenData.expiresAt,
          createdAt: tokenData.createdAt,
        },
      });
    }
  );
};

module.exports = function propertiesRoutes({ app, db, logger }) {
  const PropertiesService = require('./properties.service');
  PropertiesService.init({ db, logger });

  const { createProperty, updateProperty, addMember, updateMemberRole } = require('./properties.schema');
  const { success, error } = require('../../utils/response');

  // ── List & Read ────────────────────────────────────────────────────────────

  // GET /api/properties/_x_/list — all properties for current user
  app.get(
    '/api/properties/_x_/list',
    app.locals.requireAuth,
    async (req, res) => {
      const properties = await PropertiesService.getAll(req.user.id);
      success(res, { properties });
    }
  );

  // GET /api/properties/_x_/:propertyId — single property detail
  app.get(
    '/api/properties/_x_/:propertyId',
    app.locals.requireAuth,
    app.locals.resolvePropertyRole,
    async (req, res) => {
      if (!req.propertyRole) return error(res, 'Property not found or access denied', 404);
      const property = await PropertiesService.getById(req.params.propertyId);
      if (!property) return error(res, 'Property not found', 404);
      success(res, { property });
    }
  );

  // ── Create ─────────────────────────────────────────────────────────────────

  // POST /api/properties/_y_/create
  app.post(
    '/api/properties/_y_/create',
    app.locals.requireAuth,
    async (req, res) => {
      const { error: validationError, value } = createProperty.validate(req.body, { abortEarly: false });
      if (validationError) {
        return error(res, 'Validation failed', 422, validationError.details.map(d => d.message));
      }
      const property = await PropertiesService.create(value, req.user.id);
      success(res, { property }, 'Property created', 201);
    }
  );

  // ── Update ─────────────────────────────────────────────────────────────────

  // PUT /api/properties/_u_/:propertyId
  app.put(
    '/api/properties/_u_/:propertyId',
    app.locals.requireAuth,
    app.locals.resolvePropertyRole,
    app.locals.requireRole('owner', 'editor'),
    async (req, res) => {
      const { error: validationError, value } = updateProperty.validate(req.body, { abortEarly: false });
      if (validationError) {
        return error(res, 'Validation failed', 422, validationError.details.map(d => d.message));
      }
      const property = await PropertiesService.update(req.params.propertyId, value, req.user.id);
      success(res, { property });
    }
  );

  // ── Delete ─────────────────────────────────────────────────────────────────

  // DELETE /api/properties/_d_/:propertyId
  app.delete(
    '/api/properties/_d_/:propertyId',
    app.locals.requireAuth,
    app.locals.resolvePropertyRole,
    app.locals.requireRole('owner'),
    async (req, res) => {
      await PropertiesService.softDelete(req.params.propertyId, req.user.id);
      success(res, null, 'Property deleted');
    }
  );

  // ── Members ────────────────────────────────────────────────────────────────

  // GET /api/properties/_x_/:propertyId/members
  app.get(
    '/api/properties/_x_/:propertyId/members',
    app.locals.requireAuth,
    app.locals.resolvePropertyRole,
    app.locals.requireRole('owner'),
    async (req, res) => {
      const members = await PropertiesService.getMembers(req.params.propertyId);
      success(res, { members });
    }
  );

  // POST /api/properties/_y_/:propertyId/members
  app.post(
    '/api/properties/_y_/:propertyId/members',
    app.locals.requireAuth,
    app.locals.resolvePropertyRole,
    app.locals.requireRole('owner'),
    async (req, res) => {
      const { error: validationError, value } = addMember.validate(req.body, { abortEarly: false });
      if (validationError) {
        return error(res, 'Validation failed', 422, validationError.details.map(d => d.message));
      }
      const member = await PropertiesService.addMember(req.params.propertyId, value, req.user.id);
      success(res, { member }, 'Member added', 201);
    }
  );
  // Both member mutations are owner-only, like add. The service refuses to
  // leave a property with no owner (409) and answers 404 for a userId that
  // is not a member, so the routes only need to reject a non-numeric id
  // before it reaches SQL (#345).
  function memberUserId(req, res) {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      error(res, 'Invalid member id', 400);
      return null;
    }
    return userId;
  }

  // PATCH /api/properties/_p_/:propertyId/members/:userId — change a role
  app.patch(
    '/api/properties/_p_/:propertyId/members/:userId',
    app.locals.requireAuth,
    app.locals.resolvePropertyRole,
    app.locals.requireRole('owner'),
    async (req, res) => {
      const userId = memberUserId(req, res);
      if (userId === null) return;
      const { error: validationError, value } = updateMemberRole.validate(req.body, { abortEarly: false });
      if (validationError) {
        return error(res, 'Validation failed', 422, validationError.details.map(d => d.message));
      }
      const member = await PropertiesService.updateMemberRole(req.params.propertyId, userId, value.role, req.user.id);
      success(res, { member }, 'Member role updated');
    }
  );

  // DELETE /api/properties/_d_/:propertyId/members/:userId — remove a member
  app.delete(
    '/api/properties/_d_/:propertyId/members/:userId',
    app.locals.requireAuth,
    app.locals.resolvePropertyRole,
    app.locals.requireRole('owner'),
    async (req, res) => {
      const userId = memberUserId(req, res);
      if (userId === null) return;
      await PropertiesService.removeMember(req.params.propertyId, userId, req.user.id);
      success(res, null, 'Member removed');
    }
  );
};

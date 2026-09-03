module.exports = function tagsRoutes({ app, db, logger }) {
  const TagsService = require('./tags.service');
  TagsService.init({ db, logger });

  const { createTag, updateTag, tagEntity } = require('./tags.schema');
  const { success, error } = require('../../utils/response');

  // ── Property Resolution Helpers ────────────────────────────────────────────

  async function resolvePropertyFromTag(req, res, next) {
    const tagId = req.params.tagId || req.body?.tagId;
    const propertyId = await TagsService.getPropertyIdForTag(tagId);
    if (!propertyId) return error(res, 'Tag not found', 404);
    req.params.propertyId = propertyId;
    next();
  }

  // ── List by Property ───────────────────────────────────────────────────────

  // GET /api/tags/_x_/property/:propertyId
  app.get(
    '/api/tags/_x_/property/:propertyId',
    app.locals.requireAuth,
    app.locals.resolvePropertyRole,
    async (req, res) => {
      if (!req.propertyRole) return error(res, 'Property not found or access denied', 404);
      const tags = await TagsService.getByProperty(req.params.propertyId);
      success(res, { tags });
    }
  );

  // ── Create ────────────────────────────────────────────────────────────────

  // POST /api/tags/_y_/create
  app.post(
    '/api/tags/_y_/create',
    app.locals.requireAuth,
    async (req, res, next) => {
      const { error: validationError, value } = createTag.validate(req.body, { abortEarly: false });
      if (validationError) {
        return error(res, 'Validation failed', 400, validationError.details.map(d => d.message));
      }
      req.validatedBody = value;
      req.params.propertyId = value.propertyId;
      next();
    },
    app.locals.resolvePropertyRole,
    app.locals.requireRole('owner', 'editor'),
    async (req, res) => {
      const tag = await TagsService.create(req.validatedBody);
      success(res, { tag }, 'Tag created', 201);
    }
  );

  // ── Update ────────────────────────────────────────────────────────────────

  // PUT /api/tags/_u_/:tagId
  app.put(
    '/api/tags/_u_/:tagId',
    app.locals.requireAuth,
    resolvePropertyFromTag,
    app.locals.resolvePropertyRole,
    app.locals.requireRole('owner', 'editor'),
    async (req, res) => {
      const { error: validationError, value } = updateTag.validate(req.body, { abortEarly: false });
      if (validationError) {
        return error(res, 'Validation failed', 400, validationError.details.map(d => d.message));
      }
      const tag = await TagsService.update(req.params.tagId, value);
      success(res, { tag });
    }
  );

  // ── Delete ────────────────────────────────────────────────────────────────

  // DELETE /api/tags/_d_/:tagId
  app.delete(
    '/api/tags/_d_/:tagId',
    app.locals.requireAuth,
    resolvePropertyFromTag,
    app.locals.resolvePropertyRole,
    app.locals.requireRole('owner'),
    async (req, res) => {
      await TagsService.delete(req.params.tagId);
      success(res, null, 'Tag deleted');
    }
  );

  // ── Get Tags for Entity ────────────────────────────────────────────────────

  async function resolvePropertyFromEntity(req, res, next) {
    const { entityType, entityId } = req.params;
    const AuditService = require('../audit/audit.service');
    const propertyId = await AuditService.getPropertyIdForEntity(entityType, entityId);
    if (!propertyId) return error(res, 'Entity not found', 404);
    req.params.propertyId = propertyId;
    next();
  }

  // GET /api/tags/_x_/entity/:entityType/:entityId
  app.get(
    '/api/tags/_x_/entity/:entityType/:entityId',
    app.locals.requireAuth,
    resolvePropertyFromEntity,
    app.locals.resolvePropertyRole,
    async (req, res) => {
      if (!req.propertyRole) return error(res, 'Access denied', 403);
      const tags = await TagsService.getForEntity(req.params.entityType, req.params.entityId);
      success(res, { tags });
    }
  );

  // ── Add Tag to Entity ─────────────────────────────────────────────────────

  // POST /api/tags/_y_/entity
  app.post(
    '/api/tags/_y_/entity',
    app.locals.requireAuth,
    async (req, res, next) => {
      const { error: validationError, value } = tagEntity.validate(req.body, { abortEarly: false });
      if (validationError) {
        return error(res, 'Validation failed', 400, validationError.details.map(d => d.message));
      }
      req.validatedBody = value;
      next();
    },
    resolvePropertyFromTag,
    app.locals.resolvePropertyRole,
    app.locals.requireRole('owner', 'editor'),
    async (req, res) => {
      const { tagId, entityType, entityId } = req.validatedBody;
      // resolvePropertyFromTag set req.params.propertyId to the TAG's property.
      // The target entity must belong to that same property — otherwise an
      // owner/editor could tag (and, via the tag report's entity join, read)
      // an entity in another household.
      const AuditService = require('../audit/audit.service');
      const entityPropertyId = await AuditService.getPropertyIdForEntity(entityType, entityId);
      if (!entityPropertyId || String(entityPropertyId) !== String(req.params.propertyId)) {
        return error(res, 'Entity must be in the same property as the tag', 400);
      }
      await TagsService.addToEntity(tagId, entityType, entityId);
      success(res, null, 'Tag added to entity', 201);
    }
  );

  // ── Remove Tag from Entity ────────────────────────────────────────────────

  // DELETE /api/tags/_d_/entity/:tagId/:entityType/:entityId
  app.delete(
    '/api/tags/_d_/entity/:tagId/:entityType/:entityId',
    app.locals.requireAuth,
    resolvePropertyFromTag,
    app.locals.resolvePropertyRole,
    app.locals.requireRole('owner', 'editor'),
    async (req, res) => {
      const { tagId, entityType, entityId } = req.params;
      // Same-property guard as attach: the entity must belong to the tag's
      // property (req.params.propertyId, set by resolvePropertyFromTag).
      const AuditService = require('../audit/audit.service');
      const entityPropertyId = await AuditService.getPropertyIdForEntity(entityType, entityId);
      if (!entityPropertyId || String(entityPropertyId) !== String(req.params.propertyId)) {
        return error(res, 'Entity must be in the same property as the tag', 400);
      }
      await TagsService.removeFromEntity(tagId, entityType, entityId);
      success(res, null, 'Tag removed from entity');
    }
  );
};

module.exports = function notificationsRoutes({ app, db, logger }) {
  const NotificationsService = require('./notifications.service');
  NotificationsService.init({ db, logger });

  const { queryNotifications, updatePreference } = require('./notifications.schema');
  const { success, error } = require('../../utils/response');

  // ── List Notifications ───────────────────────────────────────────────────────

  // GET /api/notifications/_x_/list
  app.get(
    '/api/notifications/_x_/list',
    app.locals.requireAuth,
    async (req, res) => {
      const { error: validationError, value } = queryNotifications.validate(req.query, {
        abortEarly: false,
        stripUnknown: true,
      });
      if (validationError) {
        return error(res, 'Validation failed', 400, validationError.details.map(d => d.message));
      }

      // Fire-and-forget: trigger lazy date notification check without blocking
      NotificationsService.checkDateNotifications(req.user.id);

      const notifications = await NotificationsService.getForUser(req.user.id, value);
      success(res, { notifications });
    }
  );

  // ── Unread Count ─────────────────────────────────────────────────────────────

  // GET /api/notifications/_x_/unread-count
  app.get(
    '/api/notifications/_x_/unread-count',
    app.locals.requireAuth,
    async (req, res) => {
      const count = await NotificationsService.getUnreadCount(req.user.id);
      success(res, { count });
    }
  );

  // ── Mark Single Read ─────────────────────────────────────────────────────────

  // PATCH /api/notifications/_p_/:notificationId/read
  app.patch(
    '/api/notifications/_p_/:notificationId/read',
    app.locals.requireAuth,
    async (req, res) => {
      await NotificationsService.markRead(req.params.notificationId, req.user.id);
      success(res, null, 'Notification marked as read');
    }
  );

  // ── Mark All Read ────────────────────────────────────────────────────────────

  // PATCH /api/notifications/_p_/read-all
  app.patch(
    '/api/notifications/_p_/read-all',
    app.locals.requireAuth,
    async (req, res) => {
      await NotificationsService.markAllRead(req.user.id);
      success(res, null, 'All notifications marked as read');
    }
  );

  // ── Dismiss ──────────────────────────────────────────────────────────────────

  // DELETE /api/notifications/_d_/:notificationId
  app.delete(
    '/api/notifications/_d_/:notificationId',
    app.locals.requireAuth,
    async (req, res) => {
      await NotificationsService.dismiss(req.params.notificationId, req.user.id);
      success(res, null, 'Notification dismissed');
    }
  );

  // ── Get Preferences ──────────────────────────────────────────────────────────

  // GET /api/notifications/_x_/preferences
  app.get(
    '/api/notifications/_x_/preferences',
    app.locals.requireAuth,
    async (req, res) => {
      const preferences = await NotificationsService.getPreferences(req.user.id);
      success(res, { preferences });
    }
  );

  // ── Update Preference ────────────────────────────────────────────────────────

  // PUT /api/notifications/_u_/preferences
  app.put(
    '/api/notifications/_u_/preferences',
    app.locals.requireAuth,
    async (req, res) => {
      const { error: validationError, value } = updatePreference.validate(req.body, {
        abortEarly: false,
        stripUnknown: true,
      });
      if (validationError) {
        return error(res, 'Validation failed', 400, validationError.details.map(d => d.message));
      }

      await NotificationsService.updatePreference(req.user.id, value.type, value.enabled);
      success(res, null, 'Preference updated');
    }
  );
};

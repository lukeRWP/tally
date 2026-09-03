module.exports = function recycleRoutes({ app, db, logger }) {
  const RecycleService = require('./recycle.service');
  RecycleService.init({ db, logger });

  const { success, error } = require('../../utils/response');

  // GET /api/recycle/_x_/list — what is in the bin, one row per deletion.
  //
  // No property scoping in the path: the bin is inherently cross-property, and
  // the query is scoped by membership so it can only ever return the caller's
  // own deletions.
  //
  // Opening the bin is also what enforces its 30-day retention (#347): the
  // sweep is lazy, throttled, and not awaited — the list hides expired rows
  // regardless, so the response is the same either way and never waits on a
  // purge. There is no scheduler in this app; see RecycleService.sweepIfDue.
  app.get(
    '/api/recycle/_x_/list',
    app.locals.requireAuth,
    async (req, res) => {
      RecycleService.sweepIfDue();
      const limit = Math.min(parseInt(req.query.limit, 10) || 100, 200);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const batches = await RecycleService.list(req.user.id, { limit, offset });
      success(res, { batches });
    }
  );

  // POST /api/recycle/_y_/restore/:batchId — put a deletion back. Owner only.
  //
  // No requireRole here: there is no :propertyId in the path for
  // resolvePropertyRole to read — the batch is what names the property. The
  // service reads the caller's role on the same locked SELECT that finds the
  // batch and answers 403 for anything but an owner (#347). (This comment used
  // to claim the service checked the role when it did not.)
  app.post(
    '/api/recycle/_y_/restore/:batchId',
    app.locals.requireAuth,
    async (req, res) => {
      const batchId = Number(req.params.batchId);
      if (!Number.isInteger(batchId) || batchId < 1) {
        return error(res, 'Invalid batch id', 400);
      }
      try {
        const restored = await RecycleService.restore(batchId, req.user.id);
        success(res, { restored }, `${restored.rootName} restored`);
      } catch (err) {
        // The service raises 404 for "not yours / not there / aged out", 403
        // for "not an owner" and 409 for "its parent is still deleted" — all
        // expected answers, not faults.
        if (err.statusCode) return error(res, err.message, err.statusCode);
        throw err;
      }
    }
  );
};

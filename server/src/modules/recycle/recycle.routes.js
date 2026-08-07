module.exports = function recycleRoutes({ app, db, logger }) {
  const RecycleService = require('./recycle.service');
  RecycleService.init({ db, logger });

  const { success, error } = require('../../utils/response');

  // GET /api/recycle/_x_/list — what is in the bin, one row per deletion.
  //
  // No property scoping in the path: the bin is inherently cross-property, and
  // the query is scoped by membership so it can only ever return the caller's
  // own deletions.
  app.get(
    '/api/recycle/_x_/list',
    app.locals.requireAuth,
    async (req, res) => {
      const limit = Math.min(parseInt(req.query.limit, 10) || 100, 200);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const batches = await RecycleService.list(req.user.id, { limit, offset });
      success(res, { batches });
    }
  );

  // POST /api/recycle/_y_/restore/:batchId — put a deletion back.
  //
  // Role is checked inside the service against the batch's own property, since
  // the batch is what names the property — there is no :propertyId in the path
  // for resolvePropertyRole to read.
  app.post(
    '/api/recycle/_y_/restore/:batchId',
    app.locals.requireAuth,
    async (req, res) => {
      const batchId = Number(req.params.batchId);
      if (!Number.isInteger(batchId) || batchId < 1) {
        return error(res, 'Invalid batch id', 422);
      }
      try {
        const restored = await RecycleService.restore(batchId, req.user.id);
        success(res, { restored }, `${restored.rootName} restored`);
      } catch (err) {
        // The service raises 404 for "not yours / not there" and 409 for
        // "its parent is still deleted" — both are expected answers, not faults.
        if (err.statusCode) return error(res, err.message, err.statusCode);
        throw err;
      }
    }
  );
};

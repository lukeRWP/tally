const rateLimit = require('express-rate-limit');
const MatchesService = require('./matches.service');
// success(res, data) and error(res, message, status) take res FIRST and send
// the response themselves — they do not return a body to be passed to json().
const { success, error } = require('../../utils/response');
const validate = require('../../middleware/validate');
const { queueSchema, listQuerySchema, resolveSchema } = require('./matches.schema');

module.exports = ({ app, db, logger, config }) => {
  MatchesService.init({ db, logger, config });

  const matchBurst = rateLimit({ windowMs: 60 * 1000, max: 30,
    message: { success: false, message: 'Too many product matches, slow down' } });
  const matchDaily = rateLimit({ windowMs: 24 * 60 * 60 * 1000, max: config.match.dailyPerUser,
    message: { success: false, message: 'Daily product-match limit reached' } });

  // POST /api/products/_y_/matches — queue and return immediately.
  app.post('/api/products/_y_/matches',
    app.locals.requireAuth, matchBurst, matchDaily, validate(queueSchema),
    async (req, res) => {
      if (!config.match.enabled) {
        return error(res, 'Product matching is disabled', 503);
      }
      try {
        const out = await MatchesService.queue(req.body, req.user.id);
        // Fire and forget, and only when the row actually queued: queue() can
        // return an already-'resolved'/'dismissed' status on a re-queue, and
        // firing the runner then would re-run a search for a decision someone
        // already made and overwrite it. NOT awaited: the client must not
        // wait for a web search, and there is deliberately no
        // abort-on-disconnect wiring — that pattern aborted every vision call
        // at 0ms.
        if (out.status === 'queued') {
          void MatchesService.runNow(out.id);
        }
        return success(res, out);
      } catch (err) {
        logger.warn('queue match failed', { error: err.message });
        return error(res, err.message, err.status || 500);
      }
    });

  // GET /api/products/_x_/matches?propertyId=1
  app.get('/api/products/_x_/matches',
    app.locals.requireAuth, validate(listQuerySchema, 'query'),
    async (req, res) => {
      try {
        const matches = await MatchesService.list(
          Number(req.query.propertyId), req.user.id);
        return success(res, matches);
      } catch (err) {
        logger.error('list matches failed', { error: err.message });
        return error(res, 'Could not load product matches', 500);
      }
    });

  // POST /api/products/_y_/matches/:id/resolve
  app.post('/api/products/_y_/matches/:id/resolve',
    app.locals.requireAuth, validate(resolveSchema),
    async (req, res) => {
      try {
        const out = await MatchesService.resolve(
          Number(req.params.id), req.user.id, req.body);
        return success(res, out);
      } catch (err) {
        // err.status carries 404 (not found), 409 (already resolved/dismissed)
        // and 400 (no such candidate) from the service — must not flatten to 500.
        logger.warn('resolve match failed', { error: err.message });
        return error(res, err.message, err.status || 500);
      }
    });
};

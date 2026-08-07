const { error } = require('../../utils/response');

/**
 * Role gate for the print module.
 *
 * The shared `resolvePropertyRole` only looks at `req.params.propertyId` and
 * `req.body.propertyId`, but the print routes carry the property in four
 * different places — body, query string, the job row, or the agent row — so
 * using the global `requireRole` here would 403 legitimate calls. This resolves
 * the property per route shape, then applies the same role check every other
 * module gets.
 *
 * Without it the whole module was `requireAuth` only, which let a VIEWER mint a
 * printer bearer token and use it to pull contents manifests for the property.
 *
 * @param {object}   deps          { db }
 * @param {string[]} roles         allowed roles, e.g. ['owner', 'editor']
 * @param {'body'|'query'|'job'|'agent'} from  where the property id comes from
 */
function requirePrintRole({ db }, roles, from) {
  return async (req, res, next) => {
    try {
      let propertyId = null;

      if (from === 'body') {
        propertyId = Number(req.body?.propertyId) || null;
      } else if (from === 'query') {
        propertyId = Number(req.query?.propertyId) || null;
      } else if (from === 'job') {
        const rows = await db.query('SELECT PROPERTY_ID FROM TALLY.print_jobs WHERE ID = ?', [
          Number(req.params.id),
        ]);
        propertyId = rows[0]?.PROPERTY_ID ?? null;
      } else if (from === 'agent') {
        const rows = await db.query('SELECT PROPERTY_ID FROM TALLY.printer_agents WHERE ID = ?', [
          Number(req.params.id),
        ]);
        propertyId = rows[0]?.PROPERTY_ID ?? null;
      }

      // A missing row is reported as "not found" by the handler itself; do not
      // leak existence through a 403 here.
      if (!propertyId) return next();

      const rows = await db.query(
        'SELECT ROLE FROM TALLY.property_members WHERE PROPERTY_ID = ? AND USER_ID = ?',
        [propertyId, req.user.id],
      );
      const role = rows[0]?.ROLE || null;
      if (!role) return error(res, 'Not found', 404);
      if (!roles.includes(role)) return error(res, 'Insufficient permissions', 403);

      req.propertyRole = role;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { requirePrintRole };

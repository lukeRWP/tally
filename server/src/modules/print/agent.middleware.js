const crypto = require('crypto');
const { error } = require('../../utils/response');

/**
 * Bearer-token auth for the Pi print agent.
 *
 * The agent is not a browser: no session cookie, no CSRF. (The global CSRF
 * middleware already skips requests without a session cookie, and bearer auth
 * is CSRF-immune by construction, so no exemption is needed.)
 *
 * Two credential shapes are accepted during the pwiam dual-accept window
 * (tally #388, PW service-accounts plan phase 2):
 *
 *  - `tp_...`  — the legacy tally-minted token, unique-indexed by its
 *                SHA-256 hash. Only the hash is stored, so a database leak
 *                does not hand an attacker a working printing credential.
 *  - `pwk_...` — a pwiam service-account API key, verified by the
 *                `@pw/auth-express` shim (`requireApiKey`) and bound to a
 *                printer row by `printer_agents.SERVICE_ACCOUNT_ID`.
 *
 * `requireAgentAny` dispatches on the bearer's PREFIX before either path
 * runs any lookup. This is deliberate, not cosmetic: a `pwk_` token is never
 * hashed and compared against TOKEN_HASH (a 64-hex sha256 digest could in
 * principle collide with a well-formed pwk_ key's shape, but never does in
 * practice — the point is that the dispatch is shape-first either way), and
 * — the sharper reason — a `tp_` token is never sent to the shim, which would
 * 503 every legacy Pi the moment pwiam has an outage. A bearer matching
 * neither shape is refused outright: the shim is a network call, and a junk
 * credential must never spend one.
 */

function hashToken(plaintext) {
  return crypto.createHash('sha256').update(String(plaintext)).digest('hex');
}

function generateToken() {
  return `tp_${crypto.randomBytes(32).toString('hex')}`;
}

function requireAgent({ db }) {
  return async (req, res, next) => {
    const header = req.headers?.authorization || '';
    const match = /^Bearer\s+(\S+)$/.exec(header);
    if (!match) return error(res, 'Agent authentication required', 401);

    // A unique index on TOKEN_HASH makes this an equality seek. Comparing the
    // hash (not the token) in SQL is itself the constant-time-safe path: the
    // hash is a fixed-length digest and reveals nothing about the plaintext.
    //
    // The join tethers the token to the LIVE membership of the user who minted
    // it (#122). Hash-only validation meant a token outlived its minter:
    // revoking the member left every agent they registered fully working. Now
    // the minting user must still be a member of the agent's property AND
    // still hold the role agent registration requires (owner — the routes'
    // OWNER gate). That second condition also retires tokens grandfathered in
    // from before the role gates existed, when any member could mint one. The
    // real Pi's token was owner-minted, so it passes this join untouched.
    const rows = await db.query(
      `SELECT a.ID, a.PROPERTY_ID, a.LOADED_MEDIA, a.NAME
         FROM TALLY.printer_agents a
         JOIN TALLY.property_members pm
           ON pm.PROPERTY_ID = a.PROPERTY_ID
          AND pm.USER_ID = a.CREATED_BY
        WHERE a.TOKEN_HASH = ?
          AND pm.ROLE = 'owner'`,
      [hashToken(match[1])]
    );
    if (rows.length === 0) return error(res, 'Invalid agent token', 401);

    req.agent = {
      id: rows[0].ID,
      propertyId: rows[0].PROPERTY_ID,
      loadedMedia: rows[0].LOADED_MEDIA,
      name: rows[0].NAME,
    };
    next();
  };
}

// `pwk_<16 hex>_<43 base64url>` — the exact shape pwiam mints (PW
// service-accounts plan). Matched before the token ever reaches the shim, so
// a merely pwk_-PREFIXED junk value falls through to the 401 branch below
// instead of spending an introspection call.
const PWK_RE = /^pwk_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/;

// The shim's fixed BYPASS_AUTH principal id (`@pw/auth-express`'s
// DEV_CLAIMS-equivalent for requireApiKey: `req.principal.id === 'dev'`).
// BYPASS_AUTH is a local-dev-only setting and is forced off in production
// (config.js), but this module has no way to see that from here — so this
// id must never be treated as bound to a printer, full stop, regardless of
// what any row in the table says. Binding it would mean that turning
// BYPASS_AUTH on anywhere authenticates as every printer bound to 'dev' at
// once.
const BYPASS_SERVICE_ACCOUNT_ID = 'dev';

// The pwk_ half of the dispatch: run the shim's introspection, then resolve
// the resulting service-account id to a printer row with the SAME
// owner-tether join requireAgent uses (#122), plus a check requireAgent has
// never had — properties.DELETED_AT IS NULL. A soft-deleted property leaves
// its property_members rows in place (the delete is a marker, not a
// cascade), so without this a printer whose property was "deleted" from the
// UI would go on authenticating forever. Only closing this for the new path:
// backporting it to `tp_` is a separate, riskier change to a path this
// migration is trying to retire, not extend.
function requireServiceAccountAgent({ db, requireApiKey }) {
  return (req, res, next) => {
    requireApiKey(req, res, async (err) => {
      if (err) return next(err);

      const principal = req.principal;
      // Belt and suspenders: bindServiceAccount() already refuses to bind
      // this id (print.service.js), so no row should ever carry it — but the
      // consequence of that guard ever lapsing is total, so it is checked
      // again here, before the query, rather than trusted.
      if (!principal || principal.id === BYPASS_SERVICE_ACCOUNT_ID) {
        return error(res, 'This printer key is not paired with a property yet.', 403);
      }

      try {
        const rows = await db.query(
          `SELECT a.ID, a.PROPERTY_ID, a.LOADED_MEDIA, a.NAME
             FROM TALLY.printer_agents a
             JOIN TALLY.property_members pm
               ON pm.PROPERTY_ID = a.PROPERTY_ID
              AND pm.USER_ID = a.CREATED_BY
             JOIN TALLY.properties p
               ON p.ID = a.PROPERTY_ID
              AND p.DELETED_AT IS NULL
            WHERE a.SERVICE_ACCOUNT_ID = ?
              AND pm.ROLE = 'owner'`,
          [principal.id]
        );
        if (rows.length === 0) {
          return error(res, 'This printer key is not paired with a property yet.', 403);
        }

        req.agent = {
          id: rows[0].ID,
          propertyId: rows[0].PROPERTY_ID,
          loadedMedia: rows[0].LOADED_MEDIA,
          name: rows[0].NAME,
        };
        next();
      } catch (e) {
        next(e);
      }
    });
  };
}

// The combined dispatcher print.routes.js mounts on the three agent routes.
// Built once per process (like requireAgent), closing over both sub-handlers
// so the per-request cost is the prefix check, not reconstruction.
function requireAgentAny({ db, requireApiKey }) {
  const tpAgent = requireAgent({ db });
  const pwkAgent = requireServiceAccountAgent({ db, requireApiKey });
  return (req, res, next) => {
    const header = req.headers?.authorization || '';
    const match = /^Bearer\s+(\S+)$/.exec(header);
    const token = match ? match[1] : '';
    if (PWK_RE.test(token)) return pwkAgent(req, res, next);
    if (token.startsWith('tp_')) return tpAgent(req, res, next);
    return error(res, 'Agent authentication required', 401);
  };
}

module.exports = {
  hashToken, generateToken, requireAgent, requireAgentAny,
  PWK_RE, BYPASS_SERVICE_ACCOUNT_ID,
};

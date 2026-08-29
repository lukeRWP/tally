const crypto = require('crypto');
const { error } = require('../../utils/response');

/**
 * Bearer-token auth for the Pi print agent.
 *
 * The agent is not a browser: no session cookie, no CSRF. (The global CSRF
 * middleware already skips requests without a session cookie, and bearer auth
 * is CSRF-immune by construction, so no exemption is needed.)
 *
 * Only the SHA-256 hash of a token is stored, so a database leak does not hand
 * an attacker a working printing credential. Lookup is BY HASH — the plaintext
 * never reaches a query.
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

module.exports = { hashToken, generateToken, requireAgent };

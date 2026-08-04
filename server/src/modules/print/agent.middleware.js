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
    const rows = await db.query(
      `SELECT ID, PROPERTY_ID, LOADED_MEDIA, NAME
         FROM TALLY.printer_agents
        WHERE TOKEN_HASH = ?`,
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

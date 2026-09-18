// The one app hook @pw/auth-express calls (plan 2c, spec §7): map a pwiam
// principal onto TALLY.users. Everything else that used to live here — the
// Entra OIDC round trip, oauth_state, session rows, the session cookie — is
// the shim's (see auth.routes.js). This module never touches TALLY.sessions.
//
// Property authority is untouched: property_members.ROLE, resolved per
// request by resolvePropertyRole (auth.middleware.js), stays the only thing a
// route gates on. The token's `roles` claim (`admin` | `member`, pw.json
// `iam.roles`) rides on req.auth.roles for whatever step 4 follow-ups need.

let _db = null;
let _config = null;
let _logger = null;

// The shim's fixed BYPASS_AUTH principal (its DEV_CLAIMS): sub 'dev', no
// entra_oid. The pre-pwiam dev user was keyed ENTRA_ID='dev-user'; matching
// it here keeps an existing local DB's dev user (and every property it owns)
// across the migration instead of minting a second one with nothing.
const LEGACY_DEV_ENTRA_ID = 'dev-user';

function displayNameFrom(claims) {
  return claims.name || claims.preferred_username || claims.sub;
}

const AuthService = {
  init({ db, config, logger }) {
    _db = db;
    _config = config;
    _logger = logger;
  },

  isBypassAuth() {
    return _config.auth.bypassAuth === true;
  },

  /**
   * `resolveUser(claims, { tokens })` — called by the shim at login AND on
   * every silent refresh (≤ 15 min), with the ID-token claims: sub, name,
   * email, roles, entra_oid, auth_time, acr, amr, sid. Returns the user
   * projection that becomes `req.user` (and is sealed into the session row
   * and served by GET /api/auth/session — never a raw row).
   *
   *  1. match `users.SUB`;
   *  2. miss → match `ENTRA_ID = entra_oid` and backfill SUB (one-time, covers
   *     every pre-pwiam row with no data migration — spec §7);
   *  3. miss → insert;
   *  4. LAST_LOGIN_AT := auth_time, only when newer (a refresh carries the
   *     same auth_time as the login it descends from, so this is idempotent
   *     across refreshes and the column keeps meaning "last authenticated").
   */
  async resolveUser(claims, { tokens } = {}) {
    if (!claims || typeof claims.sub !== 'string' || !claims.sub) {
      throw new Error('resolveUser: claims.sub missing');
    }
    const sub = claims.sub;

    let row = await AuthService._bySub(sub);

    if (!row) {
      const legacyId = claims.entra_oid || (tokens === null && sub === 'dev' ? LEGACY_DEV_ENTRA_ID : null);
      if (legacyId) {
        const legacy = await _db.query(
          'SELECT * FROM TALLY.users WHERE ENTRA_ID = ? AND SUB IS NULL',
          [legacyId]
        );
        if (legacy[0]) {
          await _db.query('UPDATE TALLY.users SET SUB = ? WHERE ID = ? AND SUB IS NULL', [sub, legacy[0].ID]);
          row = { ...legacy[0], SUB: sub };
          _logger.info('[auth] backfilled users.SUB from entra_oid', { userId: row.ID });
        }
      }
    }

    if (!row) {
      try {
        const result = await _db.query(
          `INSERT INTO TALLY.users (SUB, ENTRA_ID, EMAIL, DISPLAY_NAME, AVATAR_URL)
           VALUES (?, ?, ?, ?, NULL)`,
          [sub, claims.entra_oid || null, claims.email || '', displayNameFrom(claims)]
        );
        row = (await _db.query('SELECT * FROM TALLY.users WHERE ID = ?', [result.insertId]))[0];
      } catch (err) {
        // Two first logins for one subject at once: the loser of the unique
        // race simply reads the winner's row.
        if (err.code !== 'ER_DUP_ENTRY') throw err;
        row = await AuthService._bySub(sub);
        if (!row) throw err;
      }
    }

    const authTime = Number.isFinite(claims.auth_time) ? new Date(claims.auth_time * 1000) : new Date();
    await _db.query(
      `UPDATE TALLY.users SET LAST_LOGIN_AT = ?
        WHERE ID = ? AND (LAST_LOGIN_AT IS NULL OR LAST_LOGIN_AT < ?)`,
      [authTime, row.ID, authTime]
    );
    const lastLoginAt = row.LAST_LOGIN_AT && row.LAST_LOGIN_AT >= authTime ? row.LAST_LOGIN_AT : authTime;

    return AuthService._mapUser({ ...row, LAST_LOGIN_AT: lastLoginAt });
  },

  async _bySub(sub) {
    const rows = await _db.query('SELECT * FROM TALLY.users WHERE SUB = ?', [sub]);
    return rows[0] || null;
  },

  // ── Helpers ──────────────────────────────────────────────────────────────

  _mapUser(row) {
    return {
      id: row.ID,
      email: row.EMAIL,
      displayName: row.DISPLAY_NAME,
      avatarUrl: row.AVATAR_URL || null,
      createdAt: row.CREATED_AT,
      lastLoginAt: row.LAST_LOGIN_AT || null,
    };
  },
};

module.exports = AuthService;

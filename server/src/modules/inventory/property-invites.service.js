const AuditService = require('../audit/audit.service');
const { pwiamInvitesClient } = require('../auth/pwiam-invites.client');

let _db = null;
let _logger = null;
let _client = null;

/**
 * pwiam's contract promises `{ id, userId, url, expiresAt }` (plan
 * "Contract → pwiam") — checked here, not trusted, because `expiresAt`
 * reaches a MySQL 8.4 DATETIME column next. A bad string in that column is
 * ERROR 1292 under strict mode, and that would fire AFTER pwiam already
 * minted the ticket and burned a slot against its daily cap, for a request
 * that then 500s instead of landing. Malformed here is treated exactly like
 * pwiam being unreachable (502) — the client's own error path, not a new one.
 */
function isValidMintedInvite(minted) {
  if (!minted || typeof minted !== 'object') return false;
  if (typeof minted.id !== 'string' || !minted.id) return false;
  if (typeof minted.userId !== 'string' || !minted.userId) return false;
  if (typeof minted.url !== 'string' || !minted.url) return false;
  return Number.isFinite(new Date(minted.expiresAt).getTime());
}

const PropertyInvitesService = {
  // `deps.fetch` lets a test hand in a stub instead of the real network —
  // pwiam-invites.client.js's own dependency-injection idiom.
  init({ db, logger, config, fetch: fetchImpl }) {
    _db = db;
    _logger = logger;
    _client = pwiamInvitesClient({ config, logger, fetch: fetchImpl });
  },

  _mapInvite(row) {
    return {
      id: row.ID,
      propertyId: row.PROPERTY_ID,
      role: row.ROLE,
      displayName: row.DISPLAY_NAME,
      invitedBy: row.INVITED_BY,
      expiresAt: row.EXPIRES_AT,
      createdAt: row.CREATED_AT,
    };
  },

  // Not accepted, not revoked, not (tally-side) expired — a lapsed pwiam
  // window still shows here until it is revoked or claimed, since tally has
  // no way to know the ticket expired without pwiam telling it; the owner
  // revoking a dead invite is harmless (pwiam 404s, this still marks
  // REVOKED_AT — see revoke()).
  async listPending(propertyId) {
    const rows = await _db.query(
      `SELECT * FROM TALLY.property_invites
        WHERE PROPERTY_ID = ? AND ACCEPTED_AT IS NULL AND REVOKED_AT IS NULL AND EXPIRES_AT > NOW()
        ORDER BY CREATED_AT DESC`,
      [propertyId]
    );
    return rows.map(PropertyInvitesService._mapInvite);
  },

  /**
   * Mints the pwiam ticket FIRST — nothing is written to
   * TALLY.property_invites until it succeeds, so a pwiam failure (cap
   * reached, not enabled, unreachable) never leaves a row with no matching
   * ticket. `actorId` is the inviting owner's tally user id; their pwiam
   * `sub` and display name are looked up fresh rather than trusted off
   * `req.user`, which carries neither.
   */
  async create(propertyId, data, actorId) {
    const actorRows = await _db.query(
      'SELECT SUB, DISPLAY_NAME FROM TALLY.users WHERE ID = ?',
      [actorId]
    );
    const actor = actorRows[0];
    if (!actor || !actor.SUB) {
      const err = new Error('Your account has no pwiam identity to invite from');
      err.statusCode = 500;
      throw err;
    }

    const minted = await _client.createInvite({
      displayName: data.displayName,
      invitedBy: { sub: actor.SUB, name: actor.DISPLAY_NAME },
    });

    if (!isValidMintedInvite(minted)) {
      _logger.error('[property-invites] pwiam returned a malformed invite body', {
        keys: minted && typeof minted === 'object' ? Object.keys(minted) : typeof minted,
      });
      const err = new Error('Could not reach the invite service');
      err.statusCode = 502;
      throw err;
    }
    // A Date object, not pwiam's ISO string — mysql2's pool is configured
    // timezone '+00:00' (infrastructure/db.js) and expects a Date for a
    // DATETIME bind; the raw string is what threw ERROR 1292 under strict
    // mode.
    const expiresAt = new Date(minted.expiresAt);

    await _db.query(
      `INSERT INTO TALLY.property_invites
         (PROPERTY_ID, ROLE, DISPLAY_NAME, INVITEE_SUB, PWIAM_INVITE_ID, INVITED_BY, EXPIRES_AT)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [propertyId, data.role, data.displayName, minted.userId, minted.id, actorId, expiresAt]
    );

    AuditService.logChange(actorId, 'property', propertyId, 'updated',
      { invite: { displayName: data.displayName, role: data.role, invited: true } }, propertyId);

    const rows = await _db.query(
      'SELECT * FROM TALLY.property_invites WHERE PWIAM_INVITE_ID = ?',
      [minted.id]
    );
    // The url is minted's alone — never stored, never re-derivable, so this
    // is the one and only place it exists after this call returns.
    return { invite: PropertyInvitesService._mapInvite(rows[0]), url: minted.url };
  },

  /**
   * pwiam's 404 (ticket already gone) is fine to proceed past. Its 409
   * (already redeemed) does NOT imply the membership already exists here —
   * `claimPending` runs in its own transaction (triggered by the invitee's
   * own sign-in) and can commit at any point, including while THIS request
   * is still talking to pwiam. So the write below is guarded by the same
   * predicate claimPending checks (`ACCEPTED_AT IS NULL AND REVOKED_AT IS
   * NULL`) and whichever gets there first wins:
   *   - claimPending wins → this UPDATE affects zero rows → 409 "already
   *     accepted". The row is left exactly as claimPending left it.
   *   - this wins → the row is marked revoked, even if pwiam had already
   *     told us 409/redeemed. In that case the invitee may already have a
   *     tally login (from signing in at pwiam) but ends up with NO
   *     membership for this property — claimPending's own SELECT filters on
   *     `REVOKED_AT IS NULL` and will have skipped this row once it loses
   *     the race. They would need a fresh invite (or, since their tally
   *     user row now exists, an owner could add them by email instead).
   */
  async revoke(propertyId, inviteId, actorId) {
    const rows = await _db.query(
      'SELECT * FROM TALLY.property_invites WHERE ID = ? AND PROPERTY_ID = ?',
      [inviteId, propertyId]
    );
    const invite = rows[0];
    if (!invite) {
      const err = new Error('Invite not found');
      err.statusCode = 404;
      throw err;
    }
    if (invite.REVOKED_AT || invite.ACCEPTED_AT) {
      const err = new Error('Invite already resolved');
      err.statusCode = 409;
      throw err;
    }

    await _client.revokeInvite(invite.PWIAM_INVITE_ID);

    const result = await _db.query(
      'UPDATE TALLY.property_invites SET REVOKED_AT = NOW() WHERE ID = ? AND ACCEPTED_AT IS NULL AND REVOKED_AT IS NULL',
      [inviteId]
    );
    if (result.affectedRows === 0) {
      // claimPending's own transaction won the race between the SELECT above
      // and this UPDATE — the invite is no longer ours to revoke.
      const err = new Error('This invite was already accepted');
      err.statusCode = 409;
      throw err;
    }

    AuditService.logChange(actorId, 'property', propertyId, 'updated',
      { invite: { id: inviteId, revoked: true } }, propertyId);

    return { revoked: true };
  },

  /**
   * Called from AuthService.resolveUser after every successful sign-in and
   * silent refresh (plan "Contract → tally"): claim any pending invite for
   * this pwiam `sub`. `FOR UPDATE` inside a transaction so two refreshes
   * racing the same claim cannot both insert a membership row; filtering on
   * `ACCEPTED_AT IS NULL` also makes a repeat call across refreshes a no-op —
   * once claimed, the row no longer matches. A pre-existing membership row
   * is left exactly as it is: this never downgrades (or upgrades) a role
   * someone already has. Tally-side EXPIRES_AT does not gate this — the
   * `sub` exists at all only because pwiam's own (7-day) window was honoured
   * when the account was created.
   */
  async claimPending(sub, userId) {
    if (!_db) throw new Error('PropertyInvitesService not initialized');

    await _db.withTransaction(async (tx) => {
      const invites = await tx.query(
        `SELECT * FROM TALLY.property_invites
          WHERE INVITEE_SUB = ? AND ACCEPTED_AT IS NULL AND REVOKED_AT IS NULL
          FOR UPDATE`,
        [sub]
      );

      for (const invite of invites) {
        const existing = await tx.query(
          'SELECT ID FROM TALLY.property_members WHERE PROPERTY_ID = ? AND USER_ID = ?',
          [invite.PROPERTY_ID, userId]
        );
        if (!existing.length) {
          await tx.query(
            `INSERT INTO TALLY.property_members (PROPERTY_ID, USER_ID, ROLE, INVITED_BY)
             VALUES (?, ?, ?, ?)`,
            [invite.PROPERTY_ID, userId, invite.ROLE, invite.INVITED_BY]
          );
        }
        await tx.query(
          'UPDATE TALLY.property_invites SET ACCEPTED_AT = NOW(), ACCEPTED_USER_ID = ? WHERE ID = ?',
          [userId, invite.ID]
        );
        // AuditService.logChange has no transaction-aware variant — it always
        // writes through its own module-level pool connection, not `tx`, so
        // this commits independently of (and possibly before) the enclosing
        // transaction. It cannot be what makes the transaction fail (it
        // swallows its own errors), but a later rollback of this transaction
        // — there is no code path that does that today, but if one is added
        // — would leave an audit row describing a claim that didn't happen.
        // Left as-is rather than threaded through `tx`: AuditService offers
        // no way to do that without changing its module-wide contract.
        AuditService.logChange(userId, 'property', invite.PROPERTY_ID, 'updated',
          { member: { userId, role: invite.ROLE, invited: true, claimedInviteId: invite.ID } },
          invite.PROPERTY_ID);
      }
    });
  },
};

module.exports = PropertyInvitesService;

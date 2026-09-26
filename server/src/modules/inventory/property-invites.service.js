const AuditService = require('../audit/audit.service');
const { pwiamInvitesClient } = require('../auth/pwiam-invites.client');

let _db = null;
let _client = null;

const PropertyInvitesService = {
  // `deps.fetch` lets a test hand in a stub instead of the real network —
  // pwiam-invites.client.js's own dependency-injection idiom.
  init({ db, logger, config, fetch: fetchImpl }) {
    _db = db;
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

    await _db.query(
      `INSERT INTO TALLY.property_invites
         (PROPERTY_ID, ROLE, DISPLAY_NAME, INVITEE_SUB, PWIAM_INVITE_ID, INVITED_BY, EXPIRES_AT)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [propertyId, data.role, data.displayName, minted.userId, minted.id, actorId, minted.expiresAt]
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
   * pwiam's 404 (ticket already gone) is fine to proceed past; 409 (already
   * redeemed) still marks tally-side revoked — the membership already
   * exists via resolveUser's claim by then, and this row is just closing out
   * the pending state, not undoing access.
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

    const pwiamResult = await _client.revokeInvite(invite.PWIAM_INVITE_ID);

    await _db.query(
      'UPDATE TALLY.property_invites SET REVOKED_AT = NOW() WHERE ID = ?',
      [inviteId]
    );

    AuditService.logChange(actorId, 'property', propertyId, 'updated',
      { invite: { id: inviteId, revoked: true, redeemed: pwiamResult.reason === 'redeemed' } }, propertyId);

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
        AuditService.logChange(userId, 'property', invite.PROPERTY_ID, 'updated',
          { member: { userId, role: invite.ROLE, invited: true, claimedInviteId: invite.ID } },
          invite.PROPERTY_ID);
      }
    });
  },
};

module.exports = PropertyInvitesService;

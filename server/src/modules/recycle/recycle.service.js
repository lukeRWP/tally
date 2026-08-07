/**
 * The recycle bin.
 *
 * Every soft-delete opens a BATCH and stamps the rows it actually touched, so a
 * restore can say precisely what it is undoing. This matters because the
 * cascades guard with `WHERE DELETED_AT IS NULL` — they only stamp rows that
 * were live at that moment — which means a deleted subtree is a mix of rows
 * from different operations. Restoring bin A must not resurrect child bin B
 * that was deleted separately a month earlier, and DELETED_AT alone cannot tell
 * them apart.
 *
 * A batch is the unit the user sees ("you deleted the Garage") and the unit
 * they act on. Members carry DELETE_BATCH_ID; the header carries what was
 * pointed at. Restore clears the members' batch id back to NULL and drops the
 * header, so nothing can be restored twice.
 */

let _db;
let _logger;
let AuditService;

const RecycleService = {
  init({ db, logger }) {
    _db = db;
    _logger = logger;
    AuditService = require('../audit/audit.service');
    return RecycleService;
  },

  /**
   * Open a batch and return its id. Must run inside the same transaction as the
   * deletes it describes, or a failed delete would leave an empty header behind.
   */
  async openBatch(tx, { propertyId, rootType, rootId, rootName, userId }) {
    const res = await tx.query(
      `INSERT INTO TALLY.delete_batches
         (PROPERTY_ID, ROOT_TYPE, ROOT_ID, ROOT_NAME, DELETED_BY, DELETED_AT)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [propertyId, rootType, rootId, String(rootName || '').slice(0, 255), userId || null]
    );
    return res.insertId;
  },

  /**
   * What is in the bin, one row per delete operation rather than one row per
   * swept-up item. Deleting an area used to mean 340 individual item rows; it
   * is one row that says "Garage · 4 bins, 340 items".
   *
   * Scoped by membership like every other read. The 30-day window matches the
   * existing item bin so the two agree about what is recoverable.
   */
  async list(userId, { limit = 100, offset = 0 } = {}) {
    const rows = await _db.query(
      `SELECT
         b.ID, b.ROOT_TYPE, b.ROOT_ID, b.ROOT_NAME, b.DELETED_AT,
         p.NAME AS PROPERTY_NAME,
         u.DISPLAY_NAME AS DELETED_BY_NAME,
         DATEDIFF(DATE_ADD(b.DELETED_AT, INTERVAL 30 DAY), NOW()) AS DAYS_LEFT,
         (SELECT COUNT(*) FROM TALLY.areas      x WHERE x.DELETE_BATCH_ID = b.ID) AS AREA_COUNT,
         (SELECT COUNT(*) FROM TALLY.containers x WHERE x.DELETE_BATCH_ID = b.ID) AS CONTAINER_COUNT,
         (SELECT COUNT(*) FROM TALLY.items      x WHERE x.DELETE_BATCH_ID = b.ID) AS ITEM_COUNT
       FROM TALLY.delete_batches b
       JOIN TALLY.properties p ON b.PROPERTY_ID = p.ID
       JOIN TALLY.property_members pm ON b.PROPERTY_ID = pm.PROPERTY_ID
       LEFT JOIN TALLY.users u ON b.DELETED_BY = u.ID
       WHERE pm.USER_ID = ?
         AND b.DELETED_AT > DATE_SUB(NOW(), INTERVAL 30 DAY)
       ORDER BY b.DELETED_AT DESC
       LIMIT ? OFFSET ?`,
      [userId, limit, offset]
    );
    return rows.map((r) => ({
      id: r.ID,
      rootType: r.ROOT_TYPE,
      rootId: r.ROOT_ID,
      rootName: r.ROOT_NAME,
      propertyName: r.PROPERTY_NAME || null,
      deletedAt: r.DELETED_AT,
      deletedByName: r.DELETED_BY_NAME || null,
      daysLeft: r.DAYS_LEFT != null ? Number(r.DAYS_LEFT) : 0,
      areaCount: Number(r.AREA_COUNT) || 0,
      containerCount: Number(r.CONTAINER_COUNT) || 0,
      itemCount: Number(r.ITEM_COUNT) || 0,
    }));
  },

  /**
   * Put a batch back.
   *
   * Refuses when the place it would return to is itself deleted — restoring a
   * bin into a recycled area would recreate the exact phantom state this whole
   * feature exists to remove. The user is told which ancestor to restore first,
   * and unlike before, that instruction is now actionable.
   */
  async restore(batchId, userId) {
    return _db.withTransaction(async (tx) => {
      const batchRows = await tx.query(
        `SELECT b.ID, b.PROPERTY_ID, b.ROOT_TYPE, b.ROOT_ID, b.ROOT_NAME
           FROM TALLY.delete_batches b
           JOIN TALLY.property_members pm ON b.PROPERTY_ID = pm.PROPERTY_ID
          WHERE b.ID = ? AND pm.USER_ID = ?
          FOR UPDATE`,
        [batchId, userId]
      );
      // 404 rather than 403 — a batch in someone else's property must not be
      // distinguishable from one that never existed.
      if (!batchRows.length) {
        const err = new Error('That deletion is not in your recycle bin');
        err.statusCode = 404;
        throw err;
      }
      const batch = batchRows[0];

      await RecycleService._assertAncestorsLive(tx, batch);

      // Order matters: ancestors first, so no row is ever briefly live under a
      // still-deleted parent.
      await tx.query(
        'UPDATE TALLY.areas SET DELETED_AT = NULL, DELETE_BATCH_ID = NULL WHERE DELETE_BATCH_ID = ?',
        [batchId]
      );
      await tx.query(
        'UPDATE TALLY.containers SET DELETED_AT = NULL, DELETE_BATCH_ID = NULL WHERE DELETE_BATCH_ID = ?',
        [batchId]
      );
      // STATUS goes back to 'active', never 'lent': the cascades close open
      // loans on the way down, so there is no loan left to be lent against.
      await tx.query(
        "UPDATE TALLY.items SET DELETED_AT = NULL, STATUS = 'active', DELETE_BATCH_ID = NULL WHERE DELETE_BATCH_ID = ?",
        [batchId]
      );

      // The header has no members left, so it is no longer a bin entry.
      await tx.query('DELETE FROM TALLY.delete_batches WHERE ID = ?', [batchId]);

      AuditService.logChange(userId, batch.ROOT_TYPE, batch.ROOT_ID, 'restored', {}, batch.PROPERTY_ID);
      return { rootType: batch.ROOT_TYPE, rootId: batch.ROOT_ID, rootName: batch.ROOT_NAME };
    });
  },

  /**
   * A batch may only come back if everything above its root is live. Checked
   * inside the restore transaction against the real rows, not inferred.
   */
  async _assertAncestorsLive(tx, batch) {
    const refuse = (message) => {
      const err = new Error(message);
      err.statusCode = 409;
      throw err;
    };

    if (batch.ROOT_TYPE === 'area') {
      const rows = await tx.query(
        'SELECT DELETED_AT FROM TALLY.properties WHERE ID = ?',
        [batch.PROPERTY_ID]
      );
      if (!rows.length) refuse('The property this belonged to no longer exists');
      if (rows[0].DELETED_AT) refuse('Restore the property first');
      return;
    }

    if (batch.ROOT_TYPE === 'container') {
      const rows = await tx.query(
        `SELECT c.PARENT_CONTAINER_ID, a.DELETED_AT AS AREA_DELETED, p.DELETED_AT AS PROP_DELETED,
                parent.DELETED_AT AS PARENT_DELETED
           FROM TALLY.containers c
           JOIN TALLY.areas a ON c.AREA_ID = a.ID
           JOIN TALLY.properties p ON a.PROPERTY_ID = p.ID
           LEFT JOIN TALLY.containers parent ON c.PARENT_CONTAINER_ID = parent.ID
          WHERE c.ID = ?`,
        [batch.ROOT_ID]
      );
      if (!rows.length) refuse('That container no longer exists');
      const r = rows[0];
      if (r.PROP_DELETED) refuse('Restore the property first');
      if (r.AREA_DELETED) refuse('Restore the area this was in first');
      // A nested bin whose parent is still in the bin has nowhere to hang.
      if (r.PARENT_CONTAINER_ID && r.PARENT_DELETED) refuse('Restore the bin this was inside first');
      return;
    }

    // item
    const rows = await tx.query(
      `SELECT c.DELETED_AT AS CONTAINER_DELETED, a.DELETED_AT AS AREA_DELETED, p.DELETED_AT AS PROP_DELETED
         FROM TALLY.items i
         JOIN TALLY.containers c ON i.CONTAINER_ID = c.ID
         JOIN TALLY.areas a ON c.AREA_ID = a.ID
         JOIN TALLY.properties p ON a.PROPERTY_ID = p.ID
        WHERE i.ID = ?`,
      [batch.ROOT_ID]
    );
    if (!rows.length) refuse('That item no longer exists');
    const r = rows[0];
    if (r.PROP_DELETED) refuse('Restore the property first');
    if (r.AREA_DELETED) refuse('Restore the area this was in first');
    if (r.CONTAINER_DELETED) refuse('Restore the bin this was in first');
  },
};

module.exports = RecycleService;

let _db = null;
let _logger = null;

function _mapLending(row) {
  return {
    id: row.ID,
    itemId: row.ITEM_ID,
    lentTo: row.LENT_TO,
    lentAt: row.LENT_AT,
    dueAt: row.DUE_AT || null,
    returnedAt: row.RETURNED_AT || null,
    notes: row.NOTES || null,
    createdBy: row.CREATED_BY,
    // Optional joined fields
    ...(row.ITEM_NAME !== undefined && { itemName: row.ITEM_NAME || null }),
    ...(row.CONTAINER_NAME !== undefined && { containerName: row.CONTAINER_NAME || null }),
    ...(row.AREA_NAME !== undefined && { areaName: row.AREA_NAME || null }),
    ...(row.PROPERTY_NAME !== undefined && { propertyName: row.PROPERTY_NAME || null }),
  };
}

const LendingService = {
  // ── Initialization ─────────────────────────────────────────────────────────

  init({ db, logger }) {
    _db = db;
    _logger = logger;
  },

  // ── Lend ──────────────────────────────────────────────────────────────────

  async lend(itemId, data, userId) {
    // The open-loan check and the insert must be ATOMIC. Previously getActive()
    // ran outside the transaction with no lock, so two concurrent lend requests
    // (or a double-click) could both pass the check and create two open loans on
    // the same item. Lock the item row FOR UPDATE to serialize concurrent lends,
    // then re-check inside the transaction.
    const insertId = await _db.withTransaction(async (tx) => {
      const items = await tx.query(
        `SELECT ID FROM TALLY.items WHERE ID = ? AND DELETED_AT IS NULL FOR UPDATE`,
        [itemId]
      );
      if (!items.length) {
        // Not found OR soft-deleted (recycled). A recycled item must not be
        // lent — its loan record would then be destroyed when the item is
        // purged after 30 days.
        const err = new Error('Item not found');
        err.statusCode = 404;
        throw err;
      }

      // Reject a second active loan on the same physical item.
      const open = await tx.query(
        `SELECT 1 FROM TALLY.item_lending
         WHERE ITEM_ID = ? AND RETURNED_AT IS NULL LIMIT 1 FOR UPDATE`,
        [itemId]
      );
      if (open.length) {
        const err = new Error('Item is already lent out');
        err.statusCode = 409;
        throw err;
      }

      const result = await tx.query(
        `INSERT INTO TALLY.item_lending (ITEM_ID, LENT_TO, LENT_AT, DUE_AT, NOTES, CREATED_BY)
         VALUES (?, ?, NOW(), ?, ?, ?)`,
        [
          itemId,
          data.lentTo,
          data.dueAt || null,
          data.notes || null,
          userId,
        ]
      );
      await tx.query(
        `UPDATE TALLY.items SET STATUS = 'lent' WHERE ID = ?`,
        [itemId]
      );
      return result.insertId;
    });

    const rows = await _db.query(
      `SELECT * FROM TALLY.item_lending WHERE ID = ?`,
      [insertId]
    );

    return _mapLending(rows[0]);
  },

  // ── Return ────────────────────────────────────────────────────────────────

  async return(lendingId, userId) {
    // Marking the lending returned and flipping the item back to 'active'
    // must commit together.
    const lending = await _db.withTransaction(async (tx) => {
      // Only an OPEN lending can be returned — guards against double-return
      // overwriting the original RETURNED_AT or re-activating a re-lent item.
      const result = await tx.query(
        `UPDATE TALLY.item_lending SET RETURNED_AT = NOW() WHERE ID = ? AND RETURNED_AT IS NULL`,
        [lendingId]
      );
      if (result.affectedRows === 0) {
        const err = new Error('This lending has already been returned');
        err.statusCode = 409;
        throw err;
      }

      const rows = await tx.query(
        `SELECT * FROM TALLY.item_lending WHERE ID = ?`,
        [lendingId]
      );

      // Re-activate the item only if it has no other still-open lending.
      const others = await tx.query(
        `SELECT 1 FROM TALLY.item_lending WHERE ITEM_ID = ? AND RETURNED_AT IS NULL LIMIT 1`,
        [rows[0].ITEM_ID]
      );
      if (!others.length) {
        await tx.query(
          `UPDATE TALLY.items SET STATUS = 'active' WHERE ID = ?`,
          [rows[0].ITEM_ID]
        );
      }
      return rows[0];
    });

    if (!lending) return null;
    return _mapLending(lending);
  },

  // ── Get Active ────────────────────────────────────────────────────────────

  async getActive(itemId) {
    const rows = await _db.query(
      `SELECT * FROM TALLY.item_lending
       WHERE ITEM_ID = ? AND RETURNED_AT IS NULL
       LIMIT 1`,
      [itemId]
    );

    if (!rows.length) return null;
    return _mapLending(rows[0]);
  },

  // ── Get History ───────────────────────────────────────────────────────────

  async getHistory(itemId) {
    const rows = await _db.query(
      `SELECT * FROM TALLY.item_lending
       WHERE ITEM_ID = ?
       ORDER BY LENT_AT DESC`,
      [itemId]
    );

    return rows.map(_mapLending);
  },

  // ── Get Overdue ───────────────────────────────────────────────────────────

  // All loans currently out across the caller's properties — the "On loan"
  // hub needs the full list, not only the overdue tail. Same shape and the
  // same membership scoping as getOverdue.
  async getActive(userId) {
    const rows = await _db.query(
      `SELECT
         il.*,
         i.NAME  AS ITEM_NAME,
         c.NAME  AS CONTAINER_NAME,
         a.NAME  AS AREA_NAME,
         pr.NAME AS PROPERTY_NAME
       FROM TALLY.item_lending il
       JOIN TALLY.items i       ON i.ID  = il.ITEM_ID
       JOIN TALLY.containers c  ON c.ID  = i.CONTAINER_ID
       JOIN TALLY.areas a       ON a.ID  = c.AREA_ID
       JOIN TALLY.properties pr ON pr.ID = a.PROPERTY_ID
       JOIN TALLY.property_members pm ON pm.PROPERTY_ID = a.PROPERTY_ID
       WHERE il.RETURNED_AT IS NULL
         AND pm.USER_ID = ?
       ORDER BY il.DUE_AT IS NULL, il.DUE_AT`,
      [userId]
    );

    return rows.map(_mapLending);
  },

  async getOverdue(userId) {
    const rows = await _db.query(
      `SELECT
         il.*,
         i.NAME  AS ITEM_NAME,
         c.NAME  AS CONTAINER_NAME,
         a.NAME  AS AREA_NAME,
         pr.NAME AS PROPERTY_NAME
       FROM TALLY.item_lending il
       JOIN TALLY.items i       ON i.ID  = il.ITEM_ID
       JOIN TALLY.containers c  ON c.ID  = i.CONTAINER_ID
       JOIN TALLY.areas a       ON a.ID  = c.AREA_ID
       JOIN TALLY.properties pr ON pr.ID = a.PROPERTY_ID
       JOIN TALLY.property_members pm ON pm.PROPERTY_ID = a.PROPERTY_ID
       WHERE il.RETURNED_AT IS NULL
         AND il.DUE_AT < NOW()
         AND pm.USER_ID = ?`,
      [userId]
    );

    return rows.map(_mapLending);
  },

  // ── Get Item ID for Lending ───────────────────────────────────────────────

  async getItemIdForLending(lendingId) {
    const rows = await _db.query(
      `SELECT ITEM_ID FROM TALLY.item_lending WHERE ID = ?`,
      [lendingId]
    );
    return rows[0]?.ITEM_ID || null;
  },
};

module.exports = LendingService;

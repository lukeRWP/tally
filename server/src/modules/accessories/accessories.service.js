let _db = null;
let _logger = null;

function _mapAccessory(row) {
  return {
    itemId: row.ITEM_ID,
    accessoryId: row.ACCESSORY_ID,
    createdAt: row.CREATED_AT,
    // Optional joined fields
    ...(row.NAME !== undefined && { name: row.NAME || null }),
    ...(row.QR_CODE !== undefined && { qrCode: row.QR_CODE || null }),
    ...(row.CONDITION !== undefined && { condition: row.CONDITION || null }),
  };
}

const AccessoriesService = {
  // ── Initialization ──────────────────────────────────────────────────────────

  init({ db, logger }) {
    _db = db;
    _logger = logger;
  },

  // ── Get Accessories for Item ─────────────────────────────────────────────────

  async getForItem(itemId) {
    const rows = await _db.query(
      `SELECT ia.*, i.NAME, i.QR_CODE, i.CONDITION
       FROM TALLY.item_accessories ia
       JOIN TALLY.items i ON ia.ACCESSORY_ID = i.ID
       WHERE ia.ITEM_ID = ?`,
      [itemId]
    );
    return rows.map(_mapAccessory);
  },

  // ── Get Parent ──────────────────────────────────────────────────────────────

  async getParent(accessoryId) {
    const rows = await _db.query(
      `SELECT ia.*, i.NAME
       FROM TALLY.item_accessories ia
       JOIN TALLY.items i ON ia.ITEM_ID = i.ID
       WHERE ia.ACCESSORY_ID = ?`,
      [accessoryId]
    );
    if (!rows.length) return null;
    return _mapAccessory(rows[0]);
  },

  // ── Link ─────────────────────────────────────────────────────────────────────

  async link(itemId, accessoryId) {
    if (Number(itemId) === Number(accessoryId)) {
      throw Object.assign(new Error('An item cannot be its own accessory'), { status: 400 });
    }

    try {
      await _db.query(
        `INSERT INTO TALLY.item_accessories (ITEM_ID, ACCESSORY_ID) VALUES (?, ?)`,
        [itemId, accessoryId]
      );
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        // Already linked — return gracefully
        return;
      }
      throw err;
    }
  },

  // ── Unlink ───────────────────────────────────────────────────────────────────

  async unlink(itemId, accessoryId) {
    await _db.query(
      `DELETE FROM TALLY.item_accessories WHERE ITEM_ID = ? AND ACCESSORY_ID = ?`,
      [itemId, accessoryId]
    );
  },
};

module.exports = AccessoriesService;

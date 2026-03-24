let _db = null;
let _logger = null;

function _mapDate(row) {
  return {
    id: row.ID,
    itemId: row.ITEM_ID,
    dateType: row.DATE_TYPE,
    dateValue: row.DATE_VALUE,
    notes: row.NOTES || null,
    createdAt: row.CREATED_AT,
    updatedAt: row.UPDATED_AT,
    // Optional joined fields
    ...(row.ITEM_NAME !== undefined && { itemName: row.ITEM_NAME || null }),
    ...(row.LOCATION !== undefined && { location: row.LOCATION || null }),
  };
}

const DatesService = {
  // ── Initialization ──────────────────────────────────────────────────────────

  init({ db, logger }) {
    _db = db;
    _logger = logger;
  },

  // ── Get by Item ─────────────────────────────────────────────────────────────

  async getByItem(itemId) {
    const rows = await _db.query(
      `SELECT * FROM TALLY.item_dates WHERE ITEM_ID = ? ORDER BY DATE_VALUE ASC`,
      [itemId]
    );
    return rows.map(_mapDate);
  },

  // ── Create ──────────────────────────────────────────────────────────────────

  async create(itemId, data) {
    const result = await _db.query(
      `INSERT INTO TALLY.item_dates (ITEM_ID, DATE_TYPE, DATE_VALUE, NOTES)
       VALUES (?, ?, ?, ?)`,
      [itemId, data.dateType, data.dateValue, data.notes || null]
    );

    const rows = await _db.query(
      `SELECT * FROM TALLY.item_dates WHERE ID = ?`,
      [result.insertId]
    );

    return _mapDate(rows[0]);
  },

  // ── Update ──────────────────────────────────────────────────────────────────

  async update(dateId, data) {
    const fields = [];
    const values = [];

    if (data.dateType !== undefined) {
      fields.push('DATE_TYPE = ?');
      values.push(data.dateType);
    }
    if (data.dateValue !== undefined) {
      fields.push('DATE_VALUE = ?');
      values.push(data.dateValue);
    }
    if (data.notes !== undefined) {
      fields.push('NOTES = ?');
      values.push(data.notes);
    }

    if (!fields.length) return null;

    values.push(dateId);

    await _db.query(
      `UPDATE TALLY.item_dates SET ${fields.join(', ')} WHERE ID = ?`,
      values
    );

    const rows = await _db.query(
      `SELECT * FROM TALLY.item_dates WHERE ID = ?`,
      [dateId]
    );

    if (!rows.length) return null;
    return _mapDate(rows[0]);
  },

  // ── Delete ──────────────────────────────────────────────────────────────────

  async delete(dateId) {
    await _db.query(
      `DELETE FROM TALLY.item_dates WHERE ID = ?`,
      [dateId]
    );
  },

  // ── Get Upcoming ────────────────────────────────────────────────────────────

  async getUpcoming(userId, daysAhead = 30) {
    const rows = await _db.query(
      `SELECT
         id.*,
         i.NAME  AS ITEM_NAME,
         c.NAME  AS LOCATION
       FROM TALLY.item_dates id
       JOIN TALLY.items i           ON i.ID  = id.ITEM_ID
       JOIN TALLY.containers c      ON c.ID  = i.CONTAINER_ID
       JOIN TALLY.areas a           ON a.ID  = c.AREA_ID
       JOIN TALLY.property_members pm ON pm.PROPERTY_ID = a.PROPERTY_ID
       WHERE id.DATE_VALUE BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL ? DAY)
         AND pm.USER_ID = ?
       ORDER BY id.DATE_VALUE ASC`,
      [daysAhead, userId]
    );

    return rows.map(_mapDate);
  },

  // ── Get Item ID for Date ─────────────────────────────────────────────────────

  async getItemIdForDate(dateId) {
    const rows = await _db.query(
      `SELECT ITEM_ID FROM TALLY.item_dates WHERE ID = ?`,
      [dateId]
    );
    return rows[0]?.ITEM_ID || null;
  },
};

module.exports = DatesService;

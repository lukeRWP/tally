const { generateCode } = require('../../utils/qr');

let _db = null;
let _logger = null;

const AreasService = {
  // ── Initialization ─────────────────────────────────────────────────────────

  init({ db, logger }) {
    _db = db;
    _logger = logger;
  },

  // ── Helpers ────────────────────────────────────────────────────────────────

  _mapArea(row) {
    return {
      id: row.ID,
      propertyId: row.PROPERTY_ID,
      name: row.NAME,
      description: row.DESCRIPTION || null,
      qrCode: row.QR_CODE || null,
      createdAt: row.CREATED_AT,
      updatedAt: row.UPDATED_AT,
      deletedAt: row.DELETED_AT || null,
      containerCount: row.CONTAINER_COUNT != null ? Number(row.CONTAINER_COUNT) : undefined,
      itemCount: row.ITEM_COUNT != null ? Number(row.ITEM_COUNT) : undefined,
      // Property info for breadcrumb (getById)
      propertyName: row.PROPERTY_NAME !== undefined ? (row.PROPERTY_NAME || null) : undefined,
    };
  },

  // ── Queries ────────────────────────────────────────────────────────────────

  async getByProperty(propertyId) {
    const rows = await _db.query(
      `SELECT
         a.*,
         (SELECT COUNT(*) FROM TALLY.containers c WHERE c.AREA_ID = a.ID AND c.DELETED_AT IS NULL) AS CONTAINER_COUNT,
         (SELECT COUNT(*) FROM TALLY.items i
            JOIN TALLY.containers c2 ON i.CONTAINER_ID = c2.ID
           WHERE c2.AREA_ID = a.ID AND i.DELETED_AT IS NULL) AS ITEM_COUNT
       FROM TALLY.areas a
       WHERE a.PROPERTY_ID = ? AND a.DELETED_AT IS NULL`,
      [propertyId]
    );
    return rows.map(AreasService._mapArea);
  },

  async getById(id) {
    const rows = await _db.query(
      `SELECT
         a.*,
         p.NAME AS PROPERTY_NAME,
         (SELECT COUNT(*) FROM TALLY.containers c WHERE c.AREA_ID = a.ID AND c.DELETED_AT IS NULL) AS CONTAINER_COUNT,
         (SELECT COUNT(*) FROM TALLY.items i
            JOIN TALLY.containers c2 ON i.CONTAINER_ID = c2.ID
           WHERE c2.AREA_ID = a.ID AND i.DELETED_AT IS NULL) AS ITEM_COUNT
       FROM TALLY.areas a
       JOIN TALLY.properties p ON a.PROPERTY_ID = p.ID
       WHERE a.ID = ?`,
      [id]
    );
    if (!rows.length) return null;
    return AreasService._mapArea(rows[0]);
  },

  async create(data, propertyId) {
    let qrCode = generateCode('area');
    try {
      const result = await _db.query(
        `INSERT INTO TALLY.areas (PROPERTY_ID, NAME, DESCRIPTION, QR_CODE)
         VALUES (?, ?, ?, ?)`,
        [propertyId, data.name, data.description || null, qrCode]
      );
      return AreasService.getById(result.insertId);
    } catch (err) {
      // Duplicate QR code — retry once with a new code
      if (err.code === 'ER_DUP_ENTRY' && err.message.includes('qr_code')) {
        qrCode = generateCode('area');
        const result = await _db.query(
          `INSERT INTO TALLY.areas (PROPERTY_ID, NAME, DESCRIPTION, QR_CODE)
           VALUES (?, ?, ?, ?)`,
          [propertyId, data.name, data.description || null, qrCode]
        );
        return AreasService.getById(result.insertId);
      }
      throw err;
    }
  },

  async update(id, data) {
    const fields = [];
    const values = [];

    if (data.name !== undefined) { fields.push('NAME = ?'); values.push(data.name); }
    if (data.description !== undefined) { fields.push('DESCRIPTION = ?'); values.push(data.description); }

    if (!fields.length) return AreasService.getById(id);

    values.push(id);
    await _db.query(
      `UPDATE TALLY.areas SET ${fields.join(', ')} WHERE ID = ?`,
      values
    );

    return AreasService.getById(id);
  },

  async softDelete(id) {
    await _db.query(
      'UPDATE TALLY.areas SET DELETED_AT = NOW() WHERE ID = ?',
      [id]
    );
  },

  async getPropertyIdForArea(areaId) {
    const rows = await _db.query(
      'SELECT PROPERTY_ID FROM TALLY.areas WHERE ID = ?',
      [areaId]
    );
    return rows[0]?.PROPERTY_ID || null;
  },
};

module.exports = AreasService;

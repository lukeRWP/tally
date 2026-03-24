const { generateCode } = require('../../utils/qr');

let _db = null;
let _logger = null;

const PropertiesService = {
  // ── Initialization ─────────────────────────────────────────────────────────

  init({ db, logger }) {
    _db = db;
    _logger = logger;
  },

  // ── Helpers ────────────────────────────────────────────────────────────────

  _mapProperty(row) {
    return {
      id: row.ID,
      name: row.NAME,
      address: row.ADDRESS || null,
      description: row.DESCRIPTION || null,
      ownerId: row.OWNER_ID,
      qrCode: row.QR_CODE || null,
      createdAt: row.CREATED_AT,
      updatedAt: row.UPDATED_AT,
      deletedAt: row.DELETED_AT || null,
      role: row.ROLE || null,
      areaCount: row.AREA_COUNT != null ? Number(row.AREA_COUNT) : undefined,
      containerCount: row.CONTAINER_COUNT != null ? Number(row.CONTAINER_COUNT) : undefined,
      itemCount: row.ITEM_COUNT != null ? Number(row.ITEM_COUNT) : undefined,
    };
  },

  _mapMember(row) {
    return {
      id: row.ID,
      propertyId: row.PROPERTY_ID,
      userId: row.USER_ID,
      role: row.ROLE,
      invitedBy: row.INVITED_BY || null,
      createdAt: row.CREATED_AT,
      email: row.EMAIL,
      displayName: row.DISPLAY_NAME,
      avatarUrl: row.AVATAR_URL || null,
    };
  },

  // ── Queries ────────────────────────────────────────────────────────────────

  async getAll(userId) {
    const rows = await _db.query(
      `SELECT
         p.*,
         pm.ROLE,
         (SELECT COUNT(*) FROM TALLY.areas a WHERE a.PROPERTY_ID = p.ID AND a.DELETED_AT IS NULL) AS AREA_COUNT,
         (SELECT COUNT(*) FROM TALLY.containers c
            JOIN TALLY.areas a2 ON c.AREA_ID = a2.ID
           WHERE a2.PROPERTY_ID = p.ID AND c.DELETED_AT IS NULL) AS CONTAINER_COUNT,
         (SELECT COUNT(*) FROM TALLY.items i
            JOIN TALLY.containers c2 ON i.CONTAINER_ID = c2.ID
            JOIN TALLY.areas a3 ON c2.AREA_ID = a3.ID
           WHERE a3.PROPERTY_ID = p.ID AND i.DELETED_AT IS NULL) AS ITEM_COUNT
       FROM TALLY.properties p
       JOIN TALLY.property_members pm ON p.ID = pm.PROPERTY_ID
       WHERE pm.USER_ID = ? AND p.DELETED_AT IS NULL`,
      [userId]
    );
    return rows.map(PropertiesService._mapProperty);
  },

  async getById(id) {
    const rows = await _db.query(
      `SELECT
         p.*,
         (SELECT COUNT(*) FROM TALLY.areas a WHERE a.PROPERTY_ID = p.ID AND a.DELETED_AT IS NULL) AS AREA_COUNT,
         (SELECT COUNT(*) FROM TALLY.containers c
            JOIN TALLY.areas a2 ON c.AREA_ID = a2.ID
           WHERE a2.PROPERTY_ID = p.ID AND c.DELETED_AT IS NULL) AS CONTAINER_COUNT,
         (SELECT COUNT(*) FROM TALLY.items i
            JOIN TALLY.containers c2 ON i.CONTAINER_ID = c2.ID
            JOIN TALLY.areas a3 ON c2.AREA_ID = a3.ID
           WHERE a3.PROPERTY_ID = p.ID AND i.DELETED_AT IS NULL) AS ITEM_COUNT
       FROM TALLY.properties p
       WHERE p.ID = ?`,
      [id]
    );
    if (!rows.length) return null;
    return PropertiesService._mapProperty(rows[0]);
  },

  async create(data, userId) {
    // Generate QR code, retry once on collision
    let qrCode = generateCode('property');
    try {
      const result = await _db.query(
        `INSERT INTO TALLY.properties (NAME, ADDRESS, DESCRIPTION, OWNER_ID, QR_CODE)
         VALUES (?, ?, ?, ?, ?)`,
        [data.name, data.address || null, data.description || null, userId, qrCode]
      );

      const propertyId = result.insertId;

      await _db.query(
        `INSERT INTO TALLY.property_members (PROPERTY_ID, USER_ID, ROLE) VALUES (?, ?, 'owner')`,
        [propertyId, userId]
      );

      return PropertiesService.getById(propertyId);
    } catch (err) {
      // Duplicate QR code — retry once with a new code
      if (err.code === 'ER_DUP_ENTRY' && err.message.includes('qr_code')) {
        qrCode = generateCode('property');
        const result = await _db.query(
          `INSERT INTO TALLY.properties (NAME, ADDRESS, DESCRIPTION, OWNER_ID, QR_CODE)
           VALUES (?, ?, ?, ?, ?)`,
          [data.name, data.address || null, data.description || null, userId, qrCode]
        );

        const propertyId = result.insertId;

        await _db.query(
          `INSERT INTO TALLY.property_members (PROPERTY_ID, USER_ID, ROLE) VALUES (?, ?, 'owner')`,
          [propertyId, userId]
        );

        return PropertiesService.getById(propertyId);
      }
      throw err;
    }
  },

  async update(id, data) {
    const fields = [];
    const values = [];

    if (data.name !== undefined) { fields.push('NAME = ?'); values.push(data.name); }
    if (data.address !== undefined) { fields.push('ADDRESS = ?'); values.push(data.address); }
    if (data.description !== undefined) { fields.push('DESCRIPTION = ?'); values.push(data.description); }

    if (!fields.length) return PropertiesService.getById(id);

    values.push(id);
    await _db.query(
      `UPDATE TALLY.properties SET ${fields.join(', ')} WHERE ID = ?`,
      values
    );

    return PropertiesService.getById(id);
  },

  async softDelete(id) {
    await _db.query(
      'UPDATE TALLY.properties SET DELETED_AT = NOW() WHERE ID = ?',
      [id]
    );
  },

  async restore(id) {
    await _db.query(
      'UPDATE TALLY.properties SET DELETED_AT = NULL WHERE ID = ?',
      [id]
    );
  },

  async getMembers(propertyId) {
    const rows = await _db.query(
      `SELECT pm.*, u.EMAIL, u.DISPLAY_NAME, u.AVATAR_URL
       FROM TALLY.property_members pm
       JOIN TALLY.users u ON pm.USER_ID = u.ID
       WHERE pm.PROPERTY_ID = ?`,
      [propertyId]
    );
    return rows.map(PropertiesService._mapMember);
  },

  async addMember(propertyId, data, invitedBy) {
    const users = await _db.query(
      'SELECT ID FROM TALLY.users WHERE EMAIL = ?',
      [data.email]
    );
    if (!users.length) {
      const err = new Error('User not found');
      err.statusCode = 404;
      throw err;
    }

    const userId = users[0].ID;

    await _db.query(
      `INSERT INTO TALLY.property_members (PROPERTY_ID, USER_ID, ROLE, INVITED_BY)
       VALUES (?, ?, ?, ?)`,
      [propertyId, userId, data.role, invitedBy]
    );

    const rows = await _db.query(
      `SELECT pm.*, u.EMAIL, u.DISPLAY_NAME, u.AVATAR_URL
       FROM TALLY.property_members pm
       JOIN TALLY.users u ON pm.USER_ID = u.ID
       WHERE pm.PROPERTY_ID = ? AND pm.USER_ID = ?`,
      [propertyId, userId]
    );

    return PropertiesService._mapMember(rows[0]);
  },

  async removeMember(propertyId, userId) {
    await _db.query(
      'DELETE FROM TALLY.property_members WHERE PROPERTY_ID = ? AND USER_ID = ?',
      [propertyId, userId]
    );
  },

  async updateMemberRole(propertyId, userId, role) {
    await _db.query(
      'UPDATE TALLY.property_members SET ROLE = ? WHERE PROPERTY_ID = ? AND USER_ID = ?',
      [role, propertyId, userId]
    );

    const rows = await _db.query(
      `SELECT pm.*, u.EMAIL, u.DISPLAY_NAME, u.AVATAR_URL
       FROM TALLY.property_members pm
       JOIN TALLY.users u ON pm.USER_ID = u.ID
       WHERE pm.PROPERTY_ID = ? AND pm.USER_ID = ?`,
      [propertyId, userId]
    );

    return rows.length ? PropertiesService._mapMember(rows[0]) : null;
  },
};

module.exports = PropertiesService;

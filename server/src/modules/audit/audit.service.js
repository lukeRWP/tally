let _db = null;
let _logger = null;

const AuditService = {
  init({ db, logger }) {
    _db = db;
    _logger = logger;
  },

  async logChange(userId, entityType, entityId, action, changes, propertyId) {
    try {
      await _db.query(
        `INSERT INTO TALLY.change_log (USER_ID, ENTITY_TYPE, ENTITY_ID, ACTION, CHANGES, PROPERTY_ID)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [userId, entityType, entityId, action, JSON.stringify(changes || {}), propertyId]
      );
    } catch (err) {
      _logger.error('Failed to log change', { error: err.message, entityType, entityId, action });
    }
  },

  async getByProperty(propertyId, options = {}) {
    const { limit = 50, offset = 0, entityType, action } = options;

    const where = ['cl.PROPERTY_ID = ?'];
    const params = [propertyId];

    if (entityType) {
      where.push('cl.ENTITY_TYPE = ?');
      params.push(entityType);
    }
    if (action) {
      where.push('cl.ACTION = ?');
      params.push(action);
    }

    params.push(limit, offset);

    const rows = await _db.query(
      `SELECT cl.*, u.DISPLAY_NAME
       FROM TALLY.change_log cl
       JOIN TALLY.users u ON cl.USER_ID = u.ID
       WHERE ${where.join(' AND ')}
       ORDER BY cl.CREATED_AT DESC
       LIMIT ? OFFSET ?`,
      params
    );

    return rows.map(AuditService._mapEntry);
  },

  async getByEntity(entityType, entityId, options = {}) {
    const { limit = 50, offset = 0 } = options;

    const rows = await _db.query(
      `SELECT cl.*, u.DISPLAY_NAME
       FROM TALLY.change_log cl
       JOIN TALLY.users u ON cl.USER_ID = u.ID
       WHERE cl.ENTITY_TYPE = ? AND cl.ENTITY_ID = ?
       ORDER BY cl.CREATED_AT DESC
       LIMIT ? OFFSET ?`,
      [entityType, entityId, limit, offset]
    );

    return rows.map(AuditService._mapEntry);
  },

  async getRecent(userId, limit = 20) {
    const rows = await _db.query(
      `SELECT cl.*, u.DISPLAY_NAME
       FROM TALLY.change_log cl
       JOIN TALLY.users u ON cl.USER_ID = u.ID
       JOIN TALLY.property_members pm ON cl.PROPERTY_ID = pm.PROPERTY_ID
       WHERE pm.USER_ID = ?
       ORDER BY cl.CREATED_AT DESC
       LIMIT ?`,
      [userId, limit]
    );

    return rows.map(AuditService._mapEntry);
  },

  _mapEntry(row) {
    let changes = row.CHANGES;
    if (typeof changes === 'string') {
      try { changes = JSON.parse(changes); } catch { changes = {}; }
    }
    return {
      id: row.ID,
      userId: row.USER_ID,
      displayName: row.DISPLAY_NAME || null,
      entityType: row.ENTITY_TYPE,
      entityId: row.ENTITY_ID,
      action: row.ACTION,
      changes,
      propertyId: row.PROPERTY_ID,
      createdAt: row.CREATED_AT,
    };
  },
};

module.exports = AuditService;

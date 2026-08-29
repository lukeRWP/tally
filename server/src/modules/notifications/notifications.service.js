let _db = null;
let _logger = null;

function _mapNotification(row) {
  return {
    id: row.ID,
    userId: row.USER_ID,
    type: row.TYPE,
    title: row.TITLE,
    message: row.MESSAGE,
    entityType: row.ENTITY_TYPE || null,
    entityId: row.ENTITY_ID || null,
    // ITEM_ID is projected only by getForUser (read-time join for item_date /
    // item_lending rows); undefined elsewhere → null either way.
    itemId: row.ITEM_ID || null,
    readAt: row.READ_AT || null,
    createdAt: row.CREATED_AT,
  };
}

const NotificationsService = {
  // ── Initialization ──────────────────────────────────────────────────────────

  init({ db, logger }) {
    _db = db;
    _logger = logger;
  },

  // ── Create ──────────────────────────────────────────────────────────────────

  async create(userId, type, title, message, entityType = null, entityId = null) {
    // Check if user has this notification type enabled in preferences
    const prefRows = await _db.query(
      `SELECT ENABLED FROM TALLY.notification_preferences
       WHERE USER_ID = ? AND NOTIFICATION_TYPE = ?`,
      [userId, type]
    );

    // If preference exists and is disabled, skip silently
    if (prefRows.length > 0 && !prefRows[0].ENABLED) {
      return null;
    }

    // If no preference row exists, default to false — skip silently
    if (prefRows.length === 0) {
      return null;
    }

    const result = await _db.query(
      `INSERT INTO TALLY.notifications (USER_ID, TYPE, TITLE, MESSAGE, ENTITY_TYPE, ENTITY_ID)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, type, title, message, entityType, entityId]
    );

    const rows = await _db.query(
      `SELECT * FROM TALLY.notifications WHERE ID = ?`,
      [result.insertId]
    );

    return _mapNotification(rows[0]);
  },

  // ── Get for User ────────────────────────────────────────────────────────────

  async getForUser(userId, { limit = 50, offset = 0, unreadOnly = false } = {}) {
    // item_date / item_lending notifications store the *source-row* id in
    // ENTITY_ID (the dedup key needs it), which the client cannot navigate to.
    // Resolve the owning item at read time via conditional LEFT JOINs — no
    // restamping, no schema change. Both joins key on a row this user already
    // owns (n.USER_ID filter below), so no cross-user surface is added. The
    // COALESCE is NULL for other entity types and for deleted source rows,
    // which the client treats as "no destination".
    let sql = `SELECT n.*, COALESCE(d.ITEM_ID, il.ITEM_ID) AS ITEM_ID
       FROM TALLY.notifications n
       LEFT JOIN TALLY.item_dates d    ON n.ENTITY_TYPE = 'item_date'    AND d.ID  = n.ENTITY_ID
       LEFT JOIN TALLY.item_lending il ON n.ENTITY_TYPE = 'item_lending' AND il.ID = n.ENTITY_ID
       WHERE n.USER_ID = ?`;
    const params = [userId];

    if (unreadOnly) {
      sql += ` AND n.READ_AT IS NULL`;
    }

    sql += ` ORDER BY n.CREATED_AT DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = await _db.query(sql, params);
    return rows.map(_mapNotification);
  },

  // ── Get Unread Count ────────────────────────────────────────────────────────

  async getUnreadCount(userId) {
    const rows = await _db.query(
      `SELECT COUNT(*) AS cnt FROM TALLY.notifications
       WHERE USER_ID = ? AND READ_AT IS NULL`,
      [userId]
    );
    return rows[0].cnt;
  },

  // ── Mark Read ───────────────────────────────────────────────────────────────

  async markRead(notificationId, userId) {
    await _db.query(
      `UPDATE TALLY.notifications SET READ_AT = NOW()
       WHERE ID = ? AND USER_ID = ?`,
      [notificationId, userId]
    );
  },

  // ── Mark All Read ───────────────────────────────────────────────────────────

  async markAllRead(userId) {
    await _db.query(
      `UPDATE TALLY.notifications SET READ_AT = NOW()
       WHERE USER_ID = ? AND READ_AT IS NULL`,
      [userId]
    );
  },

  // ── Dismiss ─────────────────────────────────────────────────────────────────

  async dismiss(notificationId, userId) {
    await _db.query(
      `DELETE FROM TALLY.notifications WHERE ID = ? AND USER_ID = ?`,
      [notificationId, userId]
    );
  },

  // ── Get Preferences ─────────────────────────────────────────────────────────

  async getPreferences(userId) {
    const rows = await _db.query(
      `SELECT NOTIFICATION_TYPE, ENABLED FROM TALLY.notification_preferences
       WHERE USER_ID = ?`,
      [userId]
    );

    const ALL_TYPES = ['warranty_expiry', 'lending_due', 'item_moved', 'item_removed', 'share_expiring', 'custom_date'];

    // Build map: start with all types defaulting to false
    const prefs = {};
    for (const type of ALL_TYPES) {
      prefs[type] = false;
    }

    // Overlay stored preferences
    for (const row of rows) {
      prefs[row.NOTIFICATION_TYPE] = !!row.ENABLED;
    }

    return prefs;
  },

  // ── Update Preference ───────────────────────────────────────────────────────

  async updatePreference(userId, type, enabled) {
    await _db.query(
      `INSERT INTO TALLY.notification_preferences (USER_ID, NOTIFICATION_TYPE, ENABLED)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE ENABLED = VALUES(ENABLED)`,
      [userId, type, enabled]
    );
  },

  // ── Check Date Notifications ────────────────────────────────────────────────

  async checkDateNotifications(userId) {
    // Each section — and each row within it — is isolated in its own try/catch
    // so a single failed insert can never abort the rest of the pass. A prior
    // single outer try/catch meant the first failure (e.g. an ENTITY_TYPE the
    // column ENUM rejected) swallowed the entire run, including the unrelated
    // overdue-lending checks below.

    // ── 1. Upcoming custom dates (within 30 days) ──────────────────────────
    try {
      const upcomingDates = await _db.query(
        `SELECT id.ID, id.ITEM_ID, id.DATE_TYPE, id.DATE_VALUE, i.NAME AS ITEM_NAME
         FROM TALLY.item_dates id
         JOIN TALLY.items i           ON i.ID  = id.ITEM_ID
         JOIN TALLY.containers c      ON c.ID  = i.CONTAINER_ID
         JOIN TALLY.areas a           ON a.ID  = c.AREA_ID
         JOIN TALLY.property_members pm ON pm.PROPERTY_ID = a.PROPERTY_ID
         WHERE id.DATE_VALUE BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 30 DAY)
           AND pm.USER_ID = ?`,
        [userId]
      );

      for (const row of upcomingDates) {
        try {
          // Check for a recent duplicate notification (within last 24 hours)
          const existing = await _db.query(
            `SELECT ID FROM TALLY.notifications
             WHERE USER_ID = ?
               AND TYPE = 'custom_date'
               AND ENTITY_TYPE = 'item_date'
               AND ENTITY_ID = ?
               AND CREATED_AT > DATE_SUB(NOW(), INTERVAL 24 HOUR)
             LIMIT 1`,
            [userId, row.ID]
          );

          if (existing.length === 0) {
            const dateLabel = row.DATE_TYPE || 'Date';
            const dateStr = new Date(row.DATE_VALUE).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            await NotificationsService.create(
              userId,
              'custom_date',
              `Upcoming: ${dateLabel}`,
              `${row.ITEM_NAME} — ${dateLabel} on ${dateStr}`,
              'item_date',
              row.ID
            );
          }
        } catch (err) {
          _logger.warn('checkDateNotifications: date row failed', { userId, dateId: row.ID, error: err.message });
        }
      }
    } catch (err) {
      _logger.warn('checkDateNotifications: upcoming-dates section failed', { userId, error: err.message });
    }

    // ── 2. Overdue lendings ────────────────────────────────────────────────
    try {
      const overdueLendings = await _db.query(
        `SELECT il.ID, il.ITEM_ID, il.DUE_AT, il.LENT_TO, i.NAME AS ITEM_NAME
         FROM TALLY.item_lending il
         JOIN TALLY.items i           ON i.ID  = il.ITEM_ID
         JOIN TALLY.containers c      ON c.ID  = i.CONTAINER_ID
         JOIN TALLY.areas a           ON a.ID  = c.AREA_ID
         JOIN TALLY.property_members pm ON pm.PROPERTY_ID = a.PROPERTY_ID
         WHERE il.RETURNED_AT IS NULL
           AND il.DUE_AT < NOW()
           AND pm.USER_ID = ?`,
        [userId]
      );

      for (const row of overdueLendings) {
        try {
          // Check for a recent duplicate notification (within last 24 hours)
          const existing = await _db.query(
            `SELECT ID FROM TALLY.notifications
             WHERE USER_ID = ?
               AND TYPE = 'lending_due'
               AND ENTITY_TYPE = 'item_lending'
               AND ENTITY_ID = ?
               AND CREATED_AT > DATE_SUB(NOW(), INTERVAL 24 HOUR)
             LIMIT 1`,
            [userId, row.ID]
          );

          if (existing.length === 0) {
            const dueStr = new Date(row.DUE_AT).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            await NotificationsService.create(
              userId,
              'lending_due',
              `Overdue: ${row.ITEM_NAME}`,
              `${row.ITEM_NAME} lent to ${row.LENT_TO} was due ${dueStr}`,
              'item_lending',
              row.ID
            );
          }
        } catch (err) {
          _logger.warn('checkDateNotifications: lending row failed', { userId, lendingId: row.ID, error: err.message });
        }
      }
    } catch (err) {
      _logger.warn('checkDateNotifications: overdue-lendings section failed', { userId, error: err.message });
    }
  },
};

module.exports = NotificationsService;

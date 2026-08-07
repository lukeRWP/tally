const { generateCode } = require('../../utils/qr');
const AuditService = require('../audit/audit.service');
const RecycleService = require('../recycle/recycle.service');

let _db = null;
let _logger = null;

const AreasService = {
  // ── Initialization ─────────────────────────────────────────────────────────

  init({ db, logger }) {
    RecycleService.init({ db, logger });
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

  async create(data, propertyId, userId) {
    let qrCode = generateCode('area');
    try {
      const result = await _db.query(
        `INSERT INTO TALLY.areas (PROPERTY_ID, NAME, DESCRIPTION, QR_CODE)
         VALUES (?, ?, ?, ?)`,
        [propertyId, data.name, data.description || null, qrCode]
      );
      AuditService.logChange(userId, 'area', result.insertId, 'created', data, propertyId);
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
        AuditService.logChange(userId, 'area', result.insertId, 'created', data, propertyId);
        return AreasService.getById(result.insertId);
      }
      throw err;
    }
  },

  async update(id, data, userId) {
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

    const propertyId = await AreasService.getPropertyIdForArea(id);
    AuditService.logChange(userId, 'area', id, 'updated', data, propertyId);

    return AreasService.getById(id);
  },

  /**
   * Cascade-soft-delete an area and everything under it.
   * `executor` defaults to the pooled db; pass a transaction `tx` to make the
   * cascade part of a larger atomic operation (e.g. property delete). When
   * called standalone, `softDelete` supplies the transaction.
   */
  async cascadeDelete(areaId, userId, executor = _db) {
    const propertyId = await AreasService.getPropertyIdForArea(areaId, executor);
    const nameRows = await executor.query('SELECT NAME FROM TALLY.areas WHERE ID = ?', [areaId]);
    // Opened on the same executor so it shares the caller's transaction when
    // there is one (property delete loops this per area) — a rolled-back
    // cascade must not leave a header naming a deletion that never happened.
    const batchId = await RecycleService.openBatch(executor, {
      propertyId, rootType: 'area', rootId: areaId,
      rootName: nameRows[0]?.NAME || 'Area', userId,
    });

    // Set-based cascade (was a per-container × per-item loop issuing thousands
    // of statements for a large area). Every container in an area carries that
    // AREA_ID (denormalized across the subtree), so a single AREA_ID predicate
    // reaches the whole area — no per-row iteration needed.

    // 1. Return any open loans so a later purge can't destroy the loan record.
    await executor.query(
      `UPDATE TALLY.item_lending SET RETURNED_AT = NOW()
       WHERE RETURNED_AT IS NULL AND ITEM_ID IN (
         SELECT i.ID FROM TALLY.items i
         JOIN TALLY.containers c ON i.CONTAINER_ID = c.ID
         WHERE c.AREA_ID = ? AND i.DELETED_AT IS NULL
       )`,
      [areaId]
    );

    // 2. Soft-delete every item in the area's containers.
    await executor.query(
      `UPDATE TALLY.items SET DELETED_AT = NOW(), STATUS = 'removed', DELETE_BATCH_ID = ?
       WHERE DELETED_AT IS NULL AND CONTAINER_ID IN (
         SELECT ID FROM TALLY.containers WHERE AREA_ID = ?
       )`,
      [batchId, areaId]
    );

    // 3. Soft-delete every container in the area. Closure paths are LEFT
    // INTACT so the subtree stays restorable — mirroring the #75 container
    // softDelete fix. (Previously this DELETEd container_paths during a SOFT
    // delete, leaving descendants phantom and the subtree unrestorable, and
    // could orphan a container whose parent lived in another area. Closure
    // destruction belongs to permanent delete only.)
    await executor.query(
      'UPDATE TALLY.containers SET DELETED_AT = NOW(), DELETE_BATCH_ID = ? WHERE DELETED_AT IS NULL AND AREA_ID = ?',
      [batchId, areaId]
    );

    // 4. Soft-delete the area.
    await executor.query(
      'UPDATE TALLY.areas SET DELETED_AT = NOW(), DELETE_BATCH_ID = ? WHERE ID = ?',
      [batchId, areaId]
    );

    // 5. Audit
    AuditService.logChange(userId, 'area', areaId, 'deleted', {}, propertyId);
  },

  async softDelete(id, userId) {
    await _db.withTransaction((tx) => AreasService.cascadeDelete(id, userId, tx));
  },

  async getPropertyIdForArea(areaId, executor = _db) {
    const rows = await executor.query(
      'SELECT PROPERTY_ID FROM TALLY.areas WHERE ID = ?',
      [areaId]
    );
    return rows[0]?.PROPERTY_ID || null;
  },
};

module.exports = AreasService;

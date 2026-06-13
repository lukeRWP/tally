const { generateCode } = require('../../utils/qr');
const ClosureTableService = require('./closure-table.service');
const AuditService = require('../audit/audit.service');

let _db = null;
let _logger = null;
let _closureTable = null;

const ContainersService = {
  // ── Initialization ─────────────────────────────────────────────────────────

  init({ db, logger }) {
    _db = db;
    _logger = logger;
    _closureTable = new ClosureTableService(db);
  },

  // ── Helpers ────────────────────────────────────────────────────────────────

  _mapContainer(row) {
    return {
      id: row.ID,
      areaId: row.AREA_ID,
      parentContainerId: row.PARENT_CONTAINER_ID || null,
      name: row.NAME,
      type: row.TYPE || null,
      description: row.DESCRIPTION || null,
      qrCode: row.QR_CODE || null,
      createdAt: row.CREATED_AT,
      updatedAt: row.UPDATED_AT,
      deletedAt: row.DELETED_AT || null,
      containerCount: row.CONTAINER_COUNT != null ? Number(row.CONTAINER_COUNT) : undefined,
      itemCount: row.ITEM_COUNT != null ? Number(row.ITEM_COUNT) : undefined,
      // Breadcrumb info (getById)
      areaName: row.AREA_NAME !== undefined ? (row.AREA_NAME || null) : undefined,
      propertyId: row.PROPERTY_ID !== undefined ? (row.PROPERTY_ID || null) : undefined,
      propertyName: row.PROPERTY_NAME !== undefined ? (row.PROPERTY_NAME || null) : undefined,
    };
  },

  _mapItem(row) {
    return {
      id: row.ID,
      containerId: row.CONTAINER_ID,
      name: row.NAME,
      description: row.DESCRIPTION || null,
      quantity: row.QUANTITY != null ? Number(row.QUANTITY) : 1,
      qrCode: row.QR_CODE || null,
      createdAt: row.CREATED_AT,
      updatedAt: row.UPDATED_AT,
      deletedAt: row.DELETED_AT || null,
    };
  },

  // ── Queries ────────────────────────────────────────────────────────────────

  async getByArea(areaId) {
    const rows = await _db.query(
      `SELECT
         c.*,
         (SELECT COUNT(*) FROM TALLY.containers ch WHERE ch.PARENT_CONTAINER_ID = c.ID AND ch.DELETED_AT IS NULL) AS CONTAINER_COUNT,
         (SELECT COUNT(*) FROM TALLY.items i WHERE i.CONTAINER_ID = c.ID AND i.DELETED_AT IS NULL) AS ITEM_COUNT
       FROM TALLY.containers c
       WHERE c.AREA_ID = ? AND c.PARENT_CONTAINER_ID IS NULL AND c.DELETED_AT IS NULL`,
      [areaId]
    );
    return rows.map(ContainersService._mapContainer);
  },

  async getByParent(parentContainerId) {
    const rows = await _db.query(
      `SELECT
         c.*,
         (SELECT COUNT(*) FROM TALLY.containers ch WHERE ch.PARENT_CONTAINER_ID = c.ID AND ch.DELETED_AT IS NULL) AS CONTAINER_COUNT,
         (SELECT COUNT(*) FROM TALLY.items i WHERE i.CONTAINER_ID = c.ID AND i.DELETED_AT IS NULL) AS ITEM_COUNT
       FROM TALLY.containers c
       WHERE c.PARENT_CONTAINER_ID = ? AND c.DELETED_AT IS NULL`,
      [parentContainerId]
    );
    return rows.map(ContainersService._mapContainer);
  },

  async getById(id) {
    const rows = await _db.query(
      `SELECT
         c.*,
         a.NAME AS AREA_NAME,
         a.PROPERTY_ID AS PROPERTY_ID,
         p.NAME AS PROPERTY_NAME,
         (SELECT COUNT(*) FROM TALLY.containers ch WHERE ch.PARENT_CONTAINER_ID = c.ID AND ch.DELETED_AT IS NULL) AS CONTAINER_COUNT,
         (SELECT COUNT(*) FROM TALLY.items i WHERE i.CONTAINER_ID = c.ID AND i.DELETED_AT IS NULL) AS ITEM_COUNT
       FROM TALLY.containers c
       JOIN TALLY.areas a ON c.AREA_ID = a.ID
       JOIN TALLY.properties p ON a.PROPERTY_ID = p.ID
       WHERE c.ID = ?`,
      [id]
    );
    if (!rows.length) return null;

    const container = ContainersService._mapContainer(rows[0]);

    // Build breadcrumb path via closure table ancestors
    const ancestors = await _closureTable.getAncestors(id);
    if (ancestors.length > 0) {
      const ancestorIds = ancestors.map(a => a.ANCESTOR_ID);
      const ancestorRows = await _db.query(
        `SELECT ID, NAME FROM TALLY.containers WHERE ID IN (${ancestorIds.map(() => '?').join(',')})`,
        ancestorIds
      );
      const nameMap = {};
      for (const r of ancestorRows) {
        nameMap[r.ID] = r.NAME;
      }
      // ancestors are ordered by DEPTH DESC (farthest first), so breadcrumb reads top-down
      container.breadcrumb = ancestors.map(a => ({
        id: a.ANCESTOR_ID,
        name: nameMap[a.ANCESTOR_ID] || null,
      }));
    } else {
      container.breadcrumb = [];
    }

    return container;
  },

  async getAllDescendantItems(containerId) {
    const rows = await _db.query(
      `SELECT i.*
       FROM TALLY.items i
       JOIN TALLY.container_paths cp ON i.CONTAINER_ID = cp.DESCENDANT_ID
       WHERE cp.ANCESTOR_ID = ? AND i.DELETED_AT IS NULL`,
      [containerId]
    );
    return rows.map(ContainersService._mapItem);
  },

  async create(data, userId) {
    // Insert the container row and its closure self/ancestor paths atomically:
    // a half-created container (row but no closure path) corrupts every tree read.
    const insertContainer = (qrCode) =>
      _db.withTransaction(async (tx) => {
        const result = await tx.query(
          `INSERT INTO TALLY.containers (AREA_ID, PARENT_CONTAINER_ID, NAME, TYPE, DESCRIPTION, QR_CODE)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [data.areaId, data.parentContainerId || null, data.name, data.type, data.description || null, qrCode]
        );
        await _closureTable.addNode(result.insertId, data.parentContainerId || null, tx);
        return result.insertId;
      });

    let insertId;
    try {
      insertId = await insertContainer(generateCode('container'));
    } catch (err) {
      // Duplicate QR code — retry once with a new code (fresh transaction)
      if (err.code === 'ER_DUP_ENTRY' && err.message.includes('qr_code')) {
        insertId = await insertContainer(generateCode('container'));
      } else {
        throw err;
      }
    }

    const propertyId = await ContainersService.getPropertyIdForContainer(insertId);
    AuditService.logChange(userId, 'container', insertId, 'created', data, propertyId);
    return ContainersService.getById(insertId);
  },

  async update(id, data, userId) {
    const fields = [];
    const values = [];

    if (data.name !== undefined) { fields.push('NAME = ?'); values.push(data.name); }
    if (data.type !== undefined) { fields.push('TYPE = ?'); values.push(data.type); }
    if (data.description !== undefined) { fields.push('DESCRIPTION = ?'); values.push(data.description); }

    if (!fields.length) return ContainersService.getById(id);

    values.push(id);
    await _db.query(
      `UPDATE TALLY.containers SET ${fields.join(', ')} WHERE ID = ?`,
      values
    );

    const propertyId = await ContainersService.getPropertyIdForContainer(id);
    AuditService.logChange(userId, 'container', id, 'updated', data, propertyId);

    return ContainersService.getById(id);
  },

  async move(id, newParentContainerId, newAreaId, userId) {
    const fields = ['PARENT_CONTAINER_ID = ?'];
    const values = [newParentContainerId || null];

    if (newAreaId !== undefined) {
      fields.push('AREA_ID = ?');
      values.push(newAreaId);
    }

    values.push(id);
    // Row move + closure rewrite must commit together, or breadcrumbs/descendant
    // queries see a tree that disagrees with the containers table.
    await _db.withTransaction(async (tx) => {
      await tx.query(
        `UPDATE TALLY.containers SET ${fields.join(', ')} WHERE ID = ?`,
        values
      );
      await _closureTable.moveNode(id, newParentContainerId || null, tx);
    });

    const propertyId = await ContainersService.getPropertyIdForContainer(id);
    AuditService.logChange(userId, 'container', id, 'moved', { parentContainerId: newParentContainerId, areaId: newAreaId }, propertyId);

    return ContainersService.getById(id);
  },

  async softDelete(id, userId) {
    const propertyId = await ContainersService.getPropertyIdForContainer(id);
    await _db.withTransaction(async (tx) => {
      await tx.query(
        'UPDATE TALLY.containers SET DELETED_AT = NOW() WHERE ID = ?',
        [id]
      );
      await _closureTable.removeNode(id, tx);
    });
    AuditService.logChange(userId, 'container', id, 'deleted', {}, propertyId);
  },

  async getPropertyIdForContainer(containerId) {
    const rows = await _db.query(
      'SELECT a.PROPERTY_ID FROM TALLY.areas a JOIN TALLY.containers c ON c.AREA_ID = a.ID WHERE c.ID = ?',
      [containerId]
    );
    return rows[0]?.PROPERTY_ID || null;
  },
};

module.exports = ContainersService;

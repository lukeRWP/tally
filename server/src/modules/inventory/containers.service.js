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
    // A container can never be moved into itself — cheap to reject up front.
    if (newParentContainerId && Number(newParentContainerId) === Number(id)) {
      const err = new Error('A container cannot be moved into itself');
      err.statusCode = 400;
      throw err;
    }

    // Everything that decides the move must happen INSIDE the transaction under
    // row locks. The cycle check was previously a check-then-act OUTSIDE the tx:
    // two concurrent mutual moves (A→under B while B→under A) could each pass a
    // stale "is the other my descendant?" check and both commit, forming a
    // 2-cycle in container_paths that corrupts every tree read. We now lock the
    // moving container and its destination parent FOR UPDATE (in ID order to
    // avoid deadlock), then re-check the cycle as a locking read.
    await _db.withTransaction(async (tx) => {
      const lockIds = [Number(id)];
      if (newParentContainerId) lockIds.push(Number(newParentContainerId));
      lockIds.sort((a, b) => a - b);
      await tx.query(
        `SELECT ID FROM TALLY.containers WHERE ID IN (${lockIds.map(() => '?').join(', ')}) FOR UPDATE`,
        lockIds
      );

      // Effective area: derived from the destination PARENT, never trusted from
      // the caller. Moving under a parent in another area without a matching
      // areaId used to leave the subtree's AREA_ID stale — wrong breadcrumbs,
      // and silently dropped from the items-by-location report (which filters
      // children by PARENT_CONTAINER_ID AND AREA_ID). For a root move (no
      // parent) there is no parent to derive from, so the caller's areaId stands.
      let effectiveAreaId = newAreaId;

      if (newParentContainerId) {
        const cycle = await tx.query(
          'SELECT 1 FROM TALLY.container_paths WHERE ANCESTOR_ID = ? AND DESCENDANT_ID = ? LIMIT 1',
          [id, newParentContainerId]
        );
        if (cycle.length) {
          const err = new Error('A container cannot be moved into its own descendant');
          err.statusCode = 400;
          throw err;
        }

        // Parent must be a LIVE container in a LIVE area (join areas — checking
        // only the container's DELETED_AT would let a "live container in a dead
        // area" slip through if that invariant ever loosened).
        const parentRows = await tx.query(
          `SELECT c.AREA_ID FROM TALLY.containers c
           JOIN TALLY.areas a ON c.AREA_ID = a.ID
           WHERE c.ID = ? AND c.DELETED_AT IS NULL AND a.DELETED_AT IS NULL`,
          [newParentContainerId]
        );
        if (!parentRows.length) {
          const err = new Error('Destination parent container not found');
          err.statusCode = 404;
          throw err;
        }
        const parentAreaId = parentRows[0].AREA_ID;
        if (newAreaId !== undefined && Number(newAreaId) !== Number(parentAreaId)) {
          const err = new Error("areaId must match the destination parent's area");
          err.statusCode = 400;
          throw err;
        }
        effectiveAreaId = parentAreaId;
      } else if (newAreaId !== undefined) {
        // Root move into a specific area — that area must be LIVE, or the
        // container (and its whole subtree, via the AREA_ID cascade below)
        // would be planted in a soft-deleted area: phantom inventory that's
        // hidden from area navigation but still surfaces in search/reports.
        const areaRows = await tx.query(
          'SELECT ID FROM TALLY.areas WHERE ID = ? AND DELETED_AT IS NULL',
          [newAreaId]
        );
        if (!areaRows.length) {
          const err = new Error('Destination area not found');
          err.statusCode = 404;
          throw err;
        }
      }

      const fields = ['PARENT_CONTAINER_ID = ?'];
      const values = [newParentContainerId || null];
      if (effectiveAreaId !== undefined) {
        fields.push('AREA_ID = ?');
        values.push(effectiveAreaId);
      }
      values.push(id);

      await tx.query(`UPDATE TALLY.containers SET ${fields.join(', ')} WHERE ID = ?`, values);
      await _closureTable.moveNode(id, newParentContainerId || null, tx);

      // Cascade the derived area to the whole subtree (moveNode only rewrites
      // the closure). Runs whenever we have an effective area — i.e. any move
      // under a parent, or a root move that carried an areaId.
      if (effectiveAreaId !== undefined) {
        await tx.query(
          `UPDATE TALLY.containers SET AREA_ID = ?
           WHERE ID IN (
             SELECT DESCENDANT_ID FROM TALLY.container_paths WHERE ANCESTOR_ID = ?
           )`,
          [effectiveAreaId, id]
        );
      }
    });

    const propertyId = await ContainersService.getPropertyIdForContainer(id);
    AuditService.logChange(userId, 'container', id, 'moved', { parentContainerId: newParentContainerId, areaId: newAreaId }, propertyId);

    return ContainersService.getById(id);
  },

  async softDelete(id, userId) {
    const propertyId = await ContainersService.getPropertyIdForContainer(id);
    await _db.withTransaction(async (tx) => {
      // Cascade the soft-delete to the ENTIRE subtree (this container + every
      // descendant container) and the items inside them, using the closure
      // table. Previously this soft-deleted only the target row and then called
      // removeNode() to DESTROY the subtree's closure paths — which left
      // descendant containers/items with DELETED_AT NULL (phantom value still
      // summed in reports/search), unreachable via navigation, and unrestorable
      // (closure gone). We keep the closure intact so the subtree stays
      // restorable; closure destruction is reserved for a permanent delete.
      await tx.query(
        `UPDATE TALLY.containers SET DELETED_AT = NOW()
         WHERE DELETED_AT IS NULL AND ID IN (
           SELECT DESCENDANT_ID FROM TALLY.container_paths WHERE ANCESTOR_ID = ?
         )`,
        [id]
      );
      await tx.query(
        `UPDATE TALLY.items SET DELETED_AT = NOW()
         WHERE DELETED_AT IS NULL AND CONTAINER_ID IN (
           SELECT DESCENDANT_ID FROM TALLY.container_paths WHERE ANCESTOR_ID = ?
         )`,
        [id]
      );
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

  // Returns the container's AREA_ID iff the container AND its area are both
  // live (not soft-deleted); null otherwise. Used to reject placing items/
  // containers into a recycled container — which would create "phantom"
  // inventory: rows that are active but sit inside a hidden parent, so they
  // never appear in navigation yet still count in reports/search. (Distinct
  // from getPropertyIdForContainer, which intentionally ignores DELETED_AT so
  // the recycle bin can still read deleted containers.)
  async getActiveAreaId(containerId) {
    const rows = await _db.query(
      `SELECT c.AREA_ID FROM TALLY.containers c
       JOIN TALLY.areas a ON c.AREA_ID = a.ID
       WHERE c.ID = ? AND c.DELETED_AT IS NULL AND a.DELETED_AT IS NULL`,
      [containerId]
    );
    return rows.length ? rows[0].AREA_ID : null;
  },
};

module.exports = ContainersService;

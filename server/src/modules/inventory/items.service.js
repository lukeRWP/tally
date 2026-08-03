const { generateCode } = require('../../utils/qr');
const AuditService = require('../audit/audit.service');
const storage = require('../../infrastructure/storage');

let _db = null;
let _logger = null;

const ItemsService = {
  // ── Initialization ─────────────────────────────────────────────────────────

  init({ db, logger }) {
    _db = db;
    _logger = logger;
  },

  // ── Helpers ────────────────────────────────────────────────────────────────

  _mapItem(row) {
    return {
      id: row.ID,
      containerId: row.CONTAINER_ID,
      productId: row.PRODUCT_ID || null,
      name: row.NAME,
      description: row.DESCRIPTION || null,
      quantity: row.QUANTITY != null ? Number(row.QUANTITY) : 1,
      qrCode: row.QR_CODE || null,
      purchasePrice: row.PURCHASE_PRICE != null ? Number(row.PURCHASE_PRICE) : null,
      condition: row.CONDITION || null,
      status: row.STATUS || null,
      depreciationEnabled: row.DEPRECIATION_ENABLED != null ? Boolean(row.DEPRECIATION_ENABLED) : false,
      depreciationRate: row.DEPRECIATION_RATE != null ? Number(row.DEPRECIATION_RATE) : null,
      createdAt: row.CREATED_AT,
      updatedAt: row.UPDATED_AT,
      deletedAt: row.DELETED_AT || null,
      // Product fields (from LEFT JOIN)
      productName: row.PRODUCT_NAME !== undefined ? (row.PRODUCT_NAME || null) : undefined,
      productBrand: row.PRODUCT_BRAND !== undefined ? (row.PRODUCT_BRAND || null) : undefined,
      productImageUrl: row.PRODUCT_IMAGE_URL !== undefined ? (row.PRODUCT_IMAGE_URL || null) : undefined,
    };
  },

  // ── Queries ────────────────────────────────────────────────────────────────

  async getByContainer(containerId) {
    const rows = await _db.query(
      `SELECT
         i.*,
         p.NAME AS PRODUCT_NAME,
         p.BRAND AS PRODUCT_BRAND,
         p.IMAGE_URL AS PRODUCT_IMAGE_URL
       FROM TALLY.items i
       LEFT JOIN TALLY.products p ON i.PRODUCT_ID = p.ID
       WHERE i.CONTAINER_ID = ? AND i.DELETED_AT IS NULL`,
      [containerId]
    );
    return rows.map(ItemsService._mapItem);
  },

  async getById(id) {
    const rows = await _db.query(
      `SELECT
         i.*,
         p.NAME AS PRODUCT_NAME,
         p.BRAND AS PRODUCT_BRAND,
         p.IMAGE_URL AS PRODUCT_IMAGE_URL,
         p.DESCRIPTION AS PRODUCT_DESCRIPTION,
         p.CATEGORY AS PRODUCT_CATEGORY,
         p.BARCODE AS PRODUCT_BARCODE,
         p.RETAIL_PRICE AS PRODUCT_RETAIL_PRICE,
         p.RETAIL_LINKS AS PRODUCT_RETAIL_LINKS,
         p.SPECS AS PRODUCT_SPECS,
         p.DATA_SOURCE AS PRODUCT_DATA_SOURCE,
         c.NAME AS CONTAINER_NAME,
         a.ID AS AREA_ID,
         a.NAME AS AREA_NAME,
         a.PROPERTY_ID AS PROPERTY_ID,
         pr.NAME AS PROPERTY_NAME
       FROM TALLY.items i
       LEFT JOIN TALLY.products p ON i.PRODUCT_ID = p.ID
       JOIN TALLY.containers c ON i.CONTAINER_ID = c.ID
       JOIN TALLY.areas a ON c.AREA_ID = a.ID
       JOIN TALLY.properties pr ON a.PROPERTY_ID = pr.ID
       WHERE i.ID = ?`,
      [id]
    );
    if (!rows.length) return null;

    const row = rows[0];
    const item = ItemsService._mapItem(row);

    // Enrich with full product data
    if (row.PRODUCT_DESCRIPTION !== undefined) {
      item.productDescription = row.PRODUCT_DESCRIPTION || null;
    }
    if (row.PRODUCT_CATEGORY !== undefined) {
      item.productCategory = row.PRODUCT_CATEGORY || null;
    }
    if (row.PRODUCT_BARCODE !== undefined) {
      item.productBarcode = row.PRODUCT_BARCODE || null;
    }
    if (row.PRODUCT_RETAIL_PRICE !== undefined) {
      item.productRetailPrice = row.PRODUCT_RETAIL_PRICE != null ? parseFloat(row.PRODUCT_RETAIL_PRICE) : null;
    }
    if (row.PRODUCT_RETAIL_LINKS !== undefined) {
      let links = row.PRODUCT_RETAIL_LINKS;
      if (typeof links === 'string') { try { links = JSON.parse(links); } catch { links = null; } }
      item.productRetailLinks = links || null;
    }
    if (row.PRODUCT_SPECS !== undefined) {
      let specs = row.PRODUCT_SPECS;
      if (typeof specs === 'string') { try { specs = JSON.parse(specs); } catch { specs = null; } }
      item.productSpecs = specs || null;
    }
    if (row.PRODUCT_DATA_SOURCE !== undefined) {
      item.productDataSource = row.PRODUCT_DATA_SOURCE || null;
    }

    // Build breadcrumb: property → area → container
    item.breadcrumb = [
      { id: row.PROPERTY_ID, name: row.PROPERTY_NAME || null, type: 'property' },
      { id: row.AREA_ID, name: row.AREA_NAME || null, type: 'area' },
      { id: row.CONTAINER_ID, name: row.CONTAINER_NAME || null, type: 'container' },
    ];

    return item;
  },

  async create(data, userId) {
    let qrCode = generateCode('item');
    try {
      const result = await _db.query(
        `INSERT INTO TALLY.items
           (CONTAINER_ID, PRODUCT_ID, NAME, DESCRIPTION, QUANTITY, QR_CODE, PURCHASE_PRICE, \`CONDITION\`, STATUS)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
        [
          data.containerId,
          data.productId || null,
          data.name,
          data.description || null,
          data.quantity != null ? data.quantity : 1,
          qrCode,
          data.purchasePrice != null ? data.purchasePrice : null,
          data.condition || 'good',
        ]
      );
      const propertyId = await ItemsService.getPropertyIdForItem(result.insertId);
      AuditService.logChange(userId, 'item', result.insertId, 'created', data, propertyId);
      return ItemsService.getById(result.insertId);
    } catch (err) {
      // Duplicate QR code — retry once with a new code
      if (err.code === 'ER_DUP_ENTRY' && err.message.includes('qr_code')) {
        qrCode = generateCode('item');
        const result = await _db.query(
          `INSERT INTO TALLY.items
             (CONTAINER_ID, PRODUCT_ID, NAME, DESCRIPTION, QUANTITY, QR_CODE, PURCHASE_PRICE, \`CONDITION\`, STATUS)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
          [
            data.containerId,
            data.productId || null,
            data.name,
            data.description || null,
            data.quantity != null ? data.quantity : 1,
            qrCode,
            data.purchasePrice != null ? data.purchasePrice : null,
            data.condition || 'good',
          ]
        );
        const propertyId = await ItemsService.getPropertyIdForItem(result.insertId);
        AuditService.logChange(userId, 'item', result.insertId, 'created', data, propertyId);
        return ItemsService.getById(result.insertId);
      }
      throw err;
    }
  },

  async update(id, data, userId) {
    const fields = [];
    const values = [];

    if (data.name !== undefined) { fields.push('NAME = ?'); values.push(data.name); }
    if (data.description !== undefined) { fields.push('DESCRIPTION = ?'); values.push(data.description); }
    if (data.quantity !== undefined) { fields.push('QUANTITY = ?'); values.push(data.quantity); }
    if (data.purchasePrice !== undefined) { fields.push('PURCHASE_PRICE = ?'); values.push(data.purchasePrice); }
    if (data.condition !== undefined) { fields.push('`CONDITION` = ?'); values.push(data.condition); }
    if (data.depreciationEnabled !== undefined) { fields.push('DEPRECIATION_ENABLED = ?'); values.push(data.depreciationEnabled ? 1 : 0); }
    if (data.depreciationRate !== undefined) { fields.push('DEPRECIATION_RATE = ?'); values.push(data.depreciationRate); }

    if (!fields.length) return ItemsService.getById(id);

    values.push(id);
    await _db.query(
      `UPDATE TALLY.items SET ${fields.join(', ')} WHERE ID = ?`,
      values
    );

    const propertyId = await ItemsService.getPropertyIdForItem(id);
    AuditService.logChange(userId, 'item', id, 'updated', data, propertyId);

    return ItemsService.getById(id);
  },

  async move(id, newContainerId, userId) {
    await _db.query(
      'UPDATE TALLY.items SET CONTAINER_ID = ? WHERE ID = ?',
      [newContainerId, id]
    );
    const propertyId = await ItemsService.getPropertyIdForItem(id);
    AuditService.logChange(userId, 'item', id, 'moved', { containerId: newContainerId }, propertyId);
    return ItemsService.getById(id);
  },

  async softDelete(id, userId) {
    const propertyId = await ItemsService.getPropertyIdForItem(id);
    // Block deleting an item that is currently lent out — otherwise the open
    // loan record is orphaned and then destroyed when the item is purged after
    // 30 days (the recycle bin loses the lending history silently).
    const openLoan = await _db.query(
      'SELECT 1 FROM TALLY.item_lending WHERE ITEM_ID = ? AND RETURNED_AT IS NULL LIMIT 1',
      [id]
    );
    if (openLoan.length) {
      const err = new Error('Return this item before deleting it');
      err.statusCode = 409;
      throw err;
    }
    await _db.query(
      "UPDATE TALLY.items SET DELETED_AT = NOW(), STATUS = 'removed' WHERE ID = ?",
      [id]
    );
    AuditService.logChange(userId, 'item', id, 'deleted', {}, propertyId);
  },

  async restore(id, userId) {
    await _db.query(
      "UPDATE TALLY.items SET DELETED_AT = NULL, STATUS = 'active' WHERE ID = ?",
      [id]
    );
    const propertyId = await ItemsService.getPropertyIdForItem(id);
    AuditService.logChange(userId, 'item', id, 'restored', {}, propertyId);
    return ItemsService.getById(id);
  },

  async search(query, userId, { tagIds, condition, status } = {}) {
    // Strip FULLTEXT boolean operators and append * for prefix matching
    const booleanQuery = query
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(word => word.replace(/[+\-><()~*"@]/g, ''))
      .filter(Boolean)
      .map(word => `${word}*`)
      .join(' ');

    const hasTagFilter = Array.isArray(tagIds) && tagIds.length > 0;

    const joins = [
      `LEFT JOIN TALLY.products p ON i.PRODUCT_ID = p.ID`,
      `JOIN TALLY.containers c ON i.CONTAINER_ID = c.ID`,
      `JOIN TALLY.areas a ON c.AREA_ID = a.ID`,
      `JOIN TALLY.property_members pm ON a.PROPERTY_ID = pm.PROPERTY_ID`,
    ];

    if (hasTagFilter) {
      joins.push(`JOIN TALLY.entity_tags et ON et.ENTITY_ID = i.ID AND et.ENTITY_TYPE = 'item'`);
      joins.push(`LEFT JOIN TALLY.tags t ON t.ID = et.TAG_ID`);
    }

    const where = [
      `pm.USER_ID = ?`,
      `i.DELETED_AT IS NULL`,
      `(MATCH(i.NAME, i.DESCRIPTION) AGAINST(? IN BOOLEAN MODE)
              OR (p.ID IS NOT NULL AND MATCH(p.NAME, p.BRAND, p.DESCRIPTION) AGAINST(? IN BOOLEAN MODE))
              ${hasTagFilter ? `OR t.NAME LIKE ?` : ''})`,
    ];

    const params = [userId, booleanQuery, booleanQuery];

    if (hasTagFilter) {
      // Add LIKE param for tag name search (must come right after the booleanQuery params)
      params.push(`%${query.trim()}%`);
      where.push(`et.TAG_ID IN (?)`);
      params.push(tagIds);
    }

    if (condition) {
      where.push(`i.\`CONDITION\` = ?`);
      params.push(condition);
    }

    if (status) {
      where.push(`i.STATUS = ?`);
      params.push(status);
    }

    const sql = `
      SELECT DISTINCT i.*, p.NAME AS PRODUCT_NAME, p.BRAND AS PRODUCT_BRAND
      FROM TALLY.items i
      ${joins.join('\n      ')}
      WHERE ${where.join('\n        AND ')}
      LIMIT 50`;

    const rows = await _db.query(sql, params);

    return rows.map(ItemsService._mapItem);
  },

  async getPropertyIdForItem(itemId) {
    const rows = await _db.query(
      `SELECT a.PROPERTY_ID
       FROM TALLY.areas a
       JOIN TALLY.containers c ON c.AREA_ID = a.ID
       JOIN TALLY.items i ON i.CONTAINER_ID = c.ID
       WHERE i.ID = ?`,
      [itemId]
    );
    return rows[0]?.PROPERTY_ID || null;
  },

  // ── Recycle Bin ────────────────────────────────────────────────────────────

  async getDeleted(userId, { limit = 50, offset = 0 } = {}) {
    const rows = await _db.query(
      `SELECT
         i.*,
         c.NAME  AS CONTAINER_NAME,
         a.NAME  AS AREA_NAME,
         pr.NAME AS PROPERTY_NAME,
         DATEDIFF(DATE_ADD(i.DELETED_AT, INTERVAL 30 DAY), NOW()) AS DAYS_LEFT
       FROM TALLY.items i
       JOIN TALLY.containers c ON i.CONTAINER_ID = c.ID
       JOIN TALLY.areas a ON c.AREA_ID = a.ID
       JOIN TALLY.properties pr ON a.PROPERTY_ID = pr.ID
       JOIN TALLY.property_members pm ON a.PROPERTY_ID = pm.PROPERTY_ID
       WHERE i.DELETED_AT IS NOT NULL
         AND i.DELETED_AT > DATE_SUB(NOW(), INTERVAL 30 DAY)
         AND pm.USER_ID = ?
       ORDER BY i.DELETED_AT DESC
       LIMIT ? OFFSET ?`,
      [userId, limit, offset]
    );
    return rows.map(row => ({
      ...ItemsService._mapItem(row),
      containerName: row.CONTAINER_NAME || null,
      areaName: row.AREA_NAME || null,
      propertyName: row.PROPERTY_NAME || null,
      daysLeft: row.DAYS_LEFT != null ? Number(row.DAYS_LEFT) : 0,
    }));
  },

  async permanentDelete(itemId) {
    // Collect the object-storage keys BEFORE the transaction so we can remove
    // them only AFTER the DB delete commits — removing them up front (as the
    // old code did) would orphan data if the transaction later rolled back.
    const snapshots = await _db.query(
      `SELECT PHOTO_KEY FROM TALLY.condition_snapshots WHERE ITEM_ID = ?`,
      [itemId]
    );
    const files = await _db.query(
      `SELECT FILE_KEY FROM TALLY.item_files WHERE ITEM_ID = ?`,
      [itemId]
    );

    // All dependent-table deletes + the item hard-delete commit as one unit,
    // so a failure can't leave dangling child rows (or a half-deleted item).
    await _db.withTransaction(async (tx) => {
      await tx.query(
        `DELETE FROM TALLY.entity_tags WHERE ENTITY_TYPE = 'item' AND ENTITY_ID = ?`,
        [itemId]
      );
      await tx.query(
        `DELETE FROM TALLY.item_accessories WHERE ITEM_ID = ? OR ACCESSORY_ID = ?`,
        [itemId, itemId]
      );
      await tx.query(
        `DELETE FROM TALLY.item_dates WHERE ITEM_ID = ?`,
        [itemId]
      );
      await tx.query(
        `DELETE FROM TALLY.item_lending WHERE ITEM_ID = ?`,
        [itemId]
      );
      await tx.query(
        `DELETE FROM TALLY.condition_snapshots WHERE ITEM_ID = ?`,
        [itemId]
      );
      await tx.query(
        `DELETE FROM TALLY.item_files WHERE ITEM_ID = ?`,
        [itemId]
      );
      await tx.query(
        `DELETE FROM TALLY.items WHERE ID = ?`,
        [itemId]
      );
    });

    // Best-effort object cleanup after the DB delete is durable.
    for (const snap of snapshots) {
      try { await storage.remove(snap.PHOTO_KEY); } catch { /* ignore */ }
    }
    for (const f of files) {
      try { await storage.remove(f.FILE_KEY); } catch { /* ignore */ }
    }
  },

  async purgeExpired(userId) {
    const rows = await _db.query(
      `SELECT i.ID FROM TALLY.items i
       JOIN TALLY.containers c ON i.CONTAINER_ID = c.ID
       JOIN TALLY.areas a ON c.AREA_ID = a.ID
       JOIN TALLY.property_members pm ON a.PROPERTY_ID = pm.PROPERTY_ID
       WHERE i.DELETED_AT IS NOT NULL
         AND i.DELETED_AT < DATE_SUB(NOW(), INTERVAL 30 DAY)
         AND pm.USER_ID = ? AND pm.ROLE = 'owner'
         AND NOT EXISTS (
           SELECT 1 FROM TALLY.item_lending il
           WHERE il.ITEM_ID = i.ID AND il.RETURNED_AT IS NULL
         )`,
      [userId]
    );
    // Items with an open loan are skipped above so the purge can't destroy an
    // active loan record (defense in depth — softDelete already blocks
    // deleting a lent item, but pre-existing recycled rows may still have one).
    for (const row of rows) {
      await ItemsService.permanentDelete(row.ID);
    }
    return rows.length;
  },
};

module.exports = ItemsService;

const crypto = require('crypto');
const storage = require('../../infrastructure/storage');

let _db = null;
let _logger = null;
let _baseUrl = null;

const SharingService = {
  // ── Initialization ─────────────────────────────────────────────────────────

  init({ db, logger, config }) {
    _db = db;
    _logger = logger;
    _baseUrl = config.clientUrl;
  },

  // ── Helpers ────────────────────────────────────────────────────────────────

  _mapLink(row) {
    return {
      id: row.ID,
      token: row.TOKEN,
      url: `${_baseUrl}/share/${row.TOKEN}`,
      entityType: row.ENTITY_TYPE,
      entityId: row.ENTITY_ID,
      createdBy: row.CREATED_BY,
      expiresAt: row.EXPIRES_AT,
      createdAt: row.CREATED_AT,
    };
  },

  // ── CRUD ───────────────────────────────────────────────────────────────────

  async create(entityType, entityId, createdBy, expiresInDays = 7) {
    const token = crypto.randomBytes(32).toString('hex');

    const result = await _db.query(
      `INSERT INTO TALLY.share_links (TOKEN, ENTITY_TYPE, ENTITY_ID, CREATED_BY, EXPIRES_AT)
       VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? DAY))`,
      [token, entityType, entityId, createdBy, expiresInDays]
    );

    const rows = await _db.query(
      'SELECT * FROM TALLY.share_links WHERE ID = ?',
      [result.insertId]
    );

    return SharingService._mapLink(rows[0]);
  },

  async validate(token) {
    // The public page has to frame itself for a stranger — who shared this and
    // when it stops working — so the sharer's display name is joined in here.
    // LEFT JOIN on purpose: a link outlives the user row it was created from,
    // and a share whose creator is gone must still resolve (the page then just
    // omits the "shared by" line rather than inventing one).
    const rows = await _db.query(
      `SELECT s.ENTITY_TYPE, s.ENTITY_ID, s.CREATED_BY, s.EXPIRES_AT, s.CREATED_AT,
              u.DISPLAY_NAME AS CREATED_BY_NAME
       FROM TALLY.share_links s
       LEFT JOIN TALLY.users u ON s.CREATED_BY = u.ID
       WHERE s.TOKEN = ? AND s.EXPIRES_AT > NOW()`,
      [token]
    );
    if (!rows.length) return null;

    const row = rows[0];
    return {
      entityType: row.ENTITY_TYPE,
      entityId: row.ENTITY_ID,
      createdBy: row.CREATED_BY,
      createdByName: row.CREATED_BY_NAME || null,
      expiresAt: row.EXPIRES_AT || null,
      createdAt: row.CREATED_AT || null,
    };
  },

  async getByUser(userId) {
    const rows = await _db.query(
      'SELECT * FROM TALLY.share_links WHERE CREATED_BY = ? ORDER BY CREATED_AT DESC',
      [userId]
    );
    return rows.map(SharingService._mapLink);
  },

  async revoke(linkId, userId) {
    await _db.query(
      'DELETE FROM TALLY.share_links WHERE ID = ? AND CREATED_BY = ?',
      [linkId, userId]
    );
  },

  // ── Public entity fetching ─────────────────────────────────────────────────

  async getEntityForShare(entityType, entityId) {
    switch (entityType) {
      case 'property':
        return SharingService._getPropertyForShare(entityId);
      case 'area':
        return SharingService._getAreaForShare(entityId);
      case 'container':
        return SharingService._getContainerForShare(entityId);
      case 'item':
        return SharingService._getItemForShare(entityId);
      default:
        return null;
    }
  },

  async _getPropertyForShare(propertyId) {
    // Property details
    const propRows = await _db.query(
      'SELECT ID, NAME, ADDRESS, DESCRIPTION, CREATED_AT FROM TALLY.properties WHERE ID = ? AND DELETED_AT IS NULL',
      [propertyId]
    );
    if (!propRows.length) return null;
    const prop = propRows[0];

    // All areas
    const areaRows = await _db.query(
      'SELECT ID, NAME, DESCRIPTION, QR_CODE, CREATED_AT FROM TALLY.areas WHERE PROPERTY_ID = ? AND DELETED_AT IS NULL ORDER BY NAME',
      [propertyId]
    );

    // All containers for this property
    const containerRows = await _db.query(
      `SELECT c.ID, c.AREA_ID, c.PARENT_CONTAINER_ID, c.NAME, c.TYPE, c.DESCRIPTION, c.QR_CODE, c.CREATED_AT
       FROM TALLY.containers c
       JOIN TALLY.areas a ON c.AREA_ID = a.ID
       WHERE a.PROPERTY_ID = ? AND c.DELETED_AT IS NULL
       ORDER BY c.NAME`,
      [propertyId]
    );

    // All items for this property
    const itemRows = await _db.query(
      `SELECT i.ID, i.CONTAINER_ID, i.NAME, i.DESCRIPTION, i.QUANTITY, i.PURCHASE_PRICE,
              i.\`CONDITION\`, i.STATUS, i.QR_CODE, i.CREATED_AT,
              p.NAME AS PRODUCT_NAME, p.BRAND AS PRODUCT_BRAND, p.IMAGE_URL AS PRODUCT_IMAGE_URL
       FROM TALLY.items i
       JOIN TALLY.containers c ON i.CONTAINER_ID = c.ID
       JOIN TALLY.areas a ON c.AREA_ID = a.ID
       LEFT JOIN TALLY.products p ON i.PRODUCT_ID = p.ID
       WHERE a.PROPERTY_ID = ? AND i.DELETED_AT IS NULL
       ORDER BY i.NAME`,
      [propertyId]
    );

    return {
      type: 'property',
      property: {
        id: prop.ID,
        name: prop.NAME,
        address: prop.ADDRESS || null,
        description: prop.DESCRIPTION || null,
        createdAt: prop.CREATED_AT,
      },
      areas: areaRows.map(a => ({
        id: a.ID,
        name: a.NAME,
        description: a.DESCRIPTION || null,
        qrCode: a.QR_CODE || null,
        createdAt: a.CREATED_AT,
      })),
      containers: containerRows.map(c => ({
        id: c.ID,
        areaId: c.AREA_ID,
        parentContainerId: c.PARENT_CONTAINER_ID || null,
        name: c.NAME,
        type: c.TYPE || null,
        description: c.DESCRIPTION || null,
        qrCode: c.QR_CODE || null,
        createdAt: c.CREATED_AT,
      })),
      items: itemRows.map(i => ({
        id: i.ID,
        containerId: i.CONTAINER_ID,
        name: i.NAME,
        description: i.DESCRIPTION || null,
        quantity: i.QUANTITY != null ? Number(i.QUANTITY) : 1,
        purchasePrice: i.PURCHASE_PRICE != null ? Number(i.PURCHASE_PRICE) : null,
        condition: i.CONDITION || null,
        status: i.STATUS || null,
        qrCode: i.QR_CODE || null,
        createdAt: i.CREATED_AT,
        productName: i.PRODUCT_NAME || null,
        productBrand: i.PRODUCT_BRAND || null,
        productImageUrl: i.PRODUCT_IMAGE_URL || null,
      })),
    };
  },

  async _getAreaForShare(areaId) {
    // Area + property name
    const areaRows = await _db.query(
      `SELECT a.ID, a.PROPERTY_ID, a.NAME, a.DESCRIPTION, a.QR_CODE, a.CREATED_AT,
              p.NAME AS PROPERTY_NAME
       FROM TALLY.areas a
       JOIN TALLY.properties p ON a.PROPERTY_ID = p.ID
       WHERE a.ID = ? AND a.DELETED_AT IS NULL`,
      [areaId]
    );
    if (!areaRows.length) return null;
    const area = areaRows[0];

    // Containers within this area
    const containerRows = await _db.query(
      `SELECT ID, PARENT_CONTAINER_ID, NAME, TYPE, DESCRIPTION, QR_CODE, CREATED_AT
       FROM TALLY.containers
       WHERE AREA_ID = ? AND DELETED_AT IS NULL
       ORDER BY NAME`,
      [areaId]
    );

    // Items within this area
    const itemRows = await _db.query(
      `SELECT i.ID, i.CONTAINER_ID, i.NAME, i.DESCRIPTION, i.QUANTITY, i.PURCHASE_PRICE,
              i.\`CONDITION\`, i.STATUS, i.QR_CODE, i.CREATED_AT,
              p.NAME AS PRODUCT_NAME, p.BRAND AS PRODUCT_BRAND, p.IMAGE_URL AS PRODUCT_IMAGE_URL
       FROM TALLY.items i
       JOIN TALLY.containers c ON i.CONTAINER_ID = c.ID
       LEFT JOIN TALLY.products p ON i.PRODUCT_ID = p.ID
       WHERE c.AREA_ID = ? AND i.DELETED_AT IS NULL
       ORDER BY i.NAME`,
      [areaId]
    );

    return {
      type: 'area',
      area: {
        id: area.ID,
        propertyId: area.PROPERTY_ID,
        propertyName: area.PROPERTY_NAME || null,
        name: area.NAME,
        description: area.DESCRIPTION || null,
        qrCode: area.QR_CODE || null,
        createdAt: area.CREATED_AT,
      },
      containers: containerRows.map(c => ({
        id: c.ID,
        parentContainerId: c.PARENT_CONTAINER_ID || null,
        name: c.NAME,
        type: c.TYPE || null,
        description: c.DESCRIPTION || null,
        qrCode: c.QR_CODE || null,
        createdAt: c.CREATED_AT,
      })),
      items: itemRows.map(i => ({
        id: i.ID,
        containerId: i.CONTAINER_ID,
        name: i.NAME,
        description: i.DESCRIPTION || null,
        quantity: i.QUANTITY != null ? Number(i.QUANTITY) : 1,
        purchasePrice: i.PURCHASE_PRICE != null ? Number(i.PURCHASE_PRICE) : null,
        condition: i.CONDITION || null,
        status: i.STATUS || null,
        qrCode: i.QR_CODE || null,
        createdAt: i.CREATED_AT,
        productName: i.PRODUCT_NAME || null,
        productBrand: i.PRODUCT_BRAND || null,
        productImageUrl: i.PRODUCT_IMAGE_URL || null,
      })),
    };
  },

  async _getContainerForShare(containerId) {
    // Container + area/property breadcrumb
    const containerRows = await _db.query(
      `SELECT c.ID, c.AREA_ID, c.PARENT_CONTAINER_ID, c.NAME, c.TYPE, c.DESCRIPTION, c.QR_CODE, c.CREATED_AT,
              a.NAME AS AREA_NAME, a.PROPERTY_ID AS PROPERTY_ID,
              p.NAME AS PROPERTY_NAME
       FROM TALLY.containers c
       JOIN TALLY.areas a ON c.AREA_ID = a.ID
       JOIN TALLY.properties p ON a.PROPERTY_ID = p.ID
       WHERE c.ID = ? AND c.DELETED_AT IS NULL`,
      [containerId]
    );
    if (!containerRows.length) return null;
    const cont = containerRows[0];

    // Nested containers via closure table (all descendants)
    const nestedRows = await _db.query(
      `SELECT c.ID, c.AREA_ID, c.PARENT_CONTAINER_ID, c.NAME, c.TYPE, c.DESCRIPTION, c.QR_CODE, c.CREATED_AT,
              cp.DEPTH
       FROM TALLY.container_paths cp
       JOIN TALLY.containers c ON cp.DESCENDANT_ID = c.ID
       WHERE cp.ANCESTOR_ID = ? AND cp.DEPTH > 0 AND c.DELETED_AT IS NULL
       ORDER BY cp.DEPTH ASC, c.NAME ASC`,
      [containerId]
    );

    // All items within this container and its descendants
    const itemRows = await _db.query(
      `SELECT i.ID, i.CONTAINER_ID, i.NAME, i.DESCRIPTION, i.QUANTITY, i.PURCHASE_PRICE,
              i.\`CONDITION\`, i.STATUS, i.QR_CODE, i.CREATED_AT,
              p.NAME AS PRODUCT_NAME, p.BRAND AS PRODUCT_BRAND, p.IMAGE_URL AS PRODUCT_IMAGE_URL
       FROM TALLY.items i
       JOIN TALLY.container_paths cp ON i.CONTAINER_ID = cp.DESCENDANT_ID
       LEFT JOIN TALLY.products p ON i.PRODUCT_ID = p.ID
       WHERE cp.ANCESTOR_ID = ? AND i.DELETED_AT IS NULL
       ORDER BY i.NAME`,
      [containerId]
    );

    return {
      type: 'container',
      container: {
        id: cont.ID,
        areaId: cont.AREA_ID,
        areaName: cont.AREA_NAME || null,
        propertyId: cont.PROPERTY_ID || null,
        propertyName: cont.PROPERTY_NAME || null,
        parentContainerId: cont.PARENT_CONTAINER_ID || null,
        name: cont.NAME,
        type: cont.TYPE || null,
        description: cont.DESCRIPTION || null,
        qrCode: cont.QR_CODE || null,
        createdAt: cont.CREATED_AT,
      },
      nestedContainers: nestedRows.map(c => ({
        id: c.ID,
        areaId: c.AREA_ID,
        parentContainerId: c.PARENT_CONTAINER_ID || null,
        name: c.NAME,
        type: c.TYPE || null,
        description: c.DESCRIPTION || null,
        qrCode: c.QR_CODE || null,
        depth: c.DEPTH,
        createdAt: c.CREATED_AT,
      })),
      items: itemRows.map(i => ({
        id: i.ID,
        containerId: i.CONTAINER_ID,
        name: i.NAME,
        description: i.DESCRIPTION || null,
        quantity: i.QUANTITY != null ? Number(i.QUANTITY) : 1,
        purchasePrice: i.PURCHASE_PRICE != null ? Number(i.PURCHASE_PRICE) : null,
        condition: i.CONDITION || null,
        status: i.STATUS || null,
        qrCode: i.QR_CODE || null,
        createdAt: i.CREATED_AT,
        productName: i.PRODUCT_NAME || null,
        productBrand: i.PRODUCT_BRAND || null,
        productImageUrl: i.PRODUCT_IMAGE_URL || null,
      })),
    };
  },

  async _getItemForShare(itemId) {
    // Item + product info + container/area/property breadcrumb
    const itemRows = await _db.query(
      `SELECT i.*,
              p.NAME AS PRODUCT_NAME, p.BRAND AS PRODUCT_BRAND, p.IMAGE_URL AS PRODUCT_IMAGE_URL,
              p.DESCRIPTION AS PRODUCT_DESCRIPTION, p.SPECS AS PRODUCT_SPECS,
              c.NAME AS CONTAINER_NAME,
              a.ID AS AREA_ID, a.NAME AS AREA_NAME,
              a.PROPERTY_ID AS PROPERTY_ID, pr.NAME AS PROPERTY_NAME
       FROM TALLY.items i
       LEFT JOIN TALLY.products p ON i.PRODUCT_ID = p.ID
       JOIN TALLY.containers c ON i.CONTAINER_ID = c.ID
       JOIN TALLY.areas a ON c.AREA_ID = a.ID
       JOIN TALLY.properties pr ON a.PROPERTY_ID = pr.ID
       WHERE i.ID = ? AND i.DELETED_AT IS NULL`,
      [itemId]
    );
    if (!itemRows.length) return null;
    const row = itemRows[0];

    // Condition snapshots with presigned photo URLs
    const snapshotRows = await _db.query(
      `SELECT cs.ID, cs.CONDITION, cs.PHOTO_KEY, cs.NOTES, cs.CREATED_AT,
              u.DISPLAY_NAME AS RECORDED_BY_NAME
       FROM TALLY.condition_snapshots cs
       LEFT JOIN TALLY.users u ON cs.RECORDED_BY = u.ID
       WHERE cs.ITEM_ID = ?
       ORDER BY cs.CREATED_AT DESC`,
      [itemId]
    );

    const conditionSnapshots = await Promise.all(
      snapshotRows.map(async (snap) => ({
        id: snap.ID,
        condition: snap.CONDITION,
        notes: snap.NOTES || null,
        recordedByName: snap.RECORDED_BY_NAME || null,
        createdAt: snap.CREATED_AT,
        photoUrl: await storage.getPresignedUrl(snap.PHOTO_KEY, { expiresIn: 300, inline: true }),
      }))
    );

    // Item files with presigned URLs
    const fileRows = await _db.query(
      `SELECT ID, FILE_TYPE, FILE_KEY, FILE_NAME, MIME_TYPE, FILE_SIZE, CREATED_AT
       FROM TALLY.item_files
       WHERE ITEM_ID = ?
       ORDER BY CREATED_AT DESC`,
      [itemId]
    );

    const files = await Promise.all(
      fileRows.map(async (f) => ({
        id: f.ID,
        fileType: f.FILE_TYPE,
        fileName: f.FILE_NAME,
        mimeType: f.MIME_TYPE,
        fileSize: f.FILE_SIZE,
        createdAt: f.CREATED_AT,
        url: await storage.getPresignedUrl(f.FILE_KEY, { expiresIn: 300, contentType: f.MIME_TYPE, fileName: f.FILE_NAME }),
      }))
    );

    // Item dates
    const dateRows = await _db.query(
      'SELECT ID, DATE_TYPE, DATE_VALUE, NOTES FROM TALLY.item_dates WHERE ITEM_ID = ? ORDER BY DATE_VALUE ASC',
      [itemId]
    );

    return {
      type: 'item',
      item: {
        id: row.ID,
        name: row.NAME,
        description: row.DESCRIPTION || null,
        quantity: row.QUANTITY != null ? Number(row.QUANTITY) : 1,
        purchasePrice: row.PURCHASE_PRICE != null ? Number(row.PURCHASE_PRICE) : null,
        condition: row.CONDITION || null,
        status: row.STATUS || null,
        qrCode: row.QR_CODE || null,
        depreciationEnabled: row.DEPRECIATION_ENABLED != null ? Boolean(row.DEPRECIATION_ENABLED) : false,
        depreciationRate: row.DEPRECIATION_RATE != null ? Number(row.DEPRECIATION_RATE) : null,
        createdAt: row.CREATED_AT,
        updatedAt: row.UPDATED_AT,
        // Product info
        productName: row.PRODUCT_NAME || null,
        productBrand: row.PRODUCT_BRAND || null,
        productImageUrl: row.PRODUCT_IMAGE_URL || null,
        productDescription: row.PRODUCT_DESCRIPTION || null,
        productSpecs: row.PRODUCT_SPECS || null,
        // Breadcrumb
        breadcrumb: [
          { id: row.PROPERTY_ID, name: row.PROPERTY_NAME || null, type: 'property' },
          { id: row.AREA_ID, name: row.AREA_NAME || null, type: 'area' },
          { id: row.CONTAINER_ID, name: row.CONTAINER_NAME || null, type: 'container' },
        ],
      },
      conditionSnapshots,
      files,
      dates: dateRows.map(d => ({
        id: d.ID,
        dateType: d.DATE_TYPE,
        dateValue: d.DATE_VALUE,
        notes: d.NOTES || null,
      })),
    };
  },
};

module.exports = SharingService;

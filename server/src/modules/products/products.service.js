const lookupOrchestrator = require('./lookup/lookup-orchestrator');

let _db = null;
let _logger = null;

const ProductsService = {
  // ── Initialization ─────────────────────────────────────────────────────────

  init({ db, logger }) {
    _db = db;
    _logger = logger;
    lookupOrchestrator.init(db, logger);
  },

  // ── Helpers ────────────────────────────────────────────────────────────────

  _mapProduct(row) {
    return {
      id: row.ID,
      barcode: row.BARCODE || null,
      name: row.NAME,
      brand: row.BRAND || null,
      category: row.CATEGORY || null,
      description: row.DESCRIPTION || null,
      specs: row.SPECS || null,
      imageUrl: row.IMAGE_URL || null,
      retailPrice: row.RETAIL_PRICE != null ? parseFloat(row.RETAIL_PRICE) : null,
      retailLinks: row.RETAIL_LINKS || null,
      depreciationRate: row.DEPRECIATION_RATE != null ? parseFloat(row.DEPRECIATION_RATE) : null,
      dataSource: row.DATA_SOURCE || null,
      createdAt: row.CREATED_AT,
      updatedAt: row.UPDATED_AT,
    };
  },

  // ── Queries ────────────────────────────────────────────────────────────────

  async getById(id) {
    const rows = await _db.query(
      'SELECT * FROM TALLY.products WHERE ID = ?',
      [id]
    );
    if (!rows.length) return null;
    return ProductsService._mapProduct(rows[0]);
  },

  async getByBarcode(barcode) {
    const rows = await _db.query(
      'SELECT * FROM TALLY.products WHERE BARCODE = ?',
      [barcode]
    );
    if (!rows.length) return null;
    return ProductsService._mapProduct(rows[0]);
  },

  async lookupBarcode(barcode) {
    const result = await lookupOrchestrator.lookupByBarcode(barcode);

    // Auto-save to local catalog if found externally
    if (result.source !== 'local' && result.source !== 'not_found' && result.product?.name) {
      try {
        const saved = await ProductsService.create(result.product);
        result.product = saved;
        result.source = 'local'; // now saved locally
      } catch (err) {
        _logger.warn('Failed to auto-save product from external lookup', {
          barcode,
          error: err.message,
        });
      }
    }

    return result;
  },

  async create(data) {
    try {
      const result = await _db.query(
        `INSERT INTO TALLY.products
           (BARCODE, NAME, BRAND, CATEGORY, DESCRIPTION, SPECS, IMAGE_URL, RETAIL_PRICE, RETAIL_LINKS, DEPRECIATION_RATE, DATA_SOURCE)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          data.barcode || null,
          data.name,
          data.brand || null,
          data.category || null,
          data.description || null,
          data.specs ? JSON.stringify(data.specs) : null,
          data.imageUrl || null,
          data.retailPrice != null ? data.retailPrice : null,
          data.retailLinks ? JSON.stringify(data.retailLinks) : null,
          data.depreciationRate != null ? data.depreciationRate : null,
          data.dataSource || 'manual',
        ]
      );
      return ProductsService.getById(result.insertId);
    } catch (err) {
      // Handle duplicate barcode — return existing product
      if (err.code === 'ER_DUP_ENTRY') {
        const existing = await ProductsService.getByBarcode(data.barcode);
        if (existing) return existing;
      }
      throw err;
    }
  },

  async update(id, data) {
    const fields = [];
    const values = [];

    if (data.name !== undefined) { fields.push('NAME = ?'); values.push(data.name); }
    if (data.brand !== undefined) { fields.push('BRAND = ?'); values.push(data.brand); }
    if (data.category !== undefined) { fields.push('CATEGORY = ?'); values.push(data.category); }
    if (data.description !== undefined) { fields.push('DESCRIPTION = ?'); values.push(data.description); }
    if (data.retailPrice !== undefined) { fields.push('RETAIL_PRICE = ?'); values.push(data.retailPrice); }
    if (data.depreciationRate !== undefined) { fields.push('DEPRECIATION_RATE = ?'); values.push(data.depreciationRate); }

    if (!fields.length) return ProductsService.getById(id);

    values.push(id);
    await _db.query(
      `UPDATE TALLY.products SET ${fields.join(', ')} WHERE ID = ?`,
      values
    );

    return ProductsService.getById(id);
  },

  async checkDuplicate(barcode, userId) {
    const rows = await _db.query(
      `SELECT i.ID, i.NAME, c.NAME AS CONTAINER_NAME, a.NAME AS AREA_NAME, p.NAME AS PROPERTY_NAME
       FROM TALLY.items i
       JOIN TALLY.containers c ON i.CONTAINER_ID = c.ID
       JOIN TALLY.areas a ON c.AREA_ID = a.ID
       JOIN TALLY.properties p ON a.PROPERTY_ID = p.ID
       JOIN TALLY.property_members pm ON p.ID = pm.PROPERTY_ID
       WHERE i.PRODUCT_ID = (SELECT ID FROM TALLY.products WHERE BARCODE = ?)
         AND pm.USER_ID = ?
         AND i.DELETED_AT IS NULL`,
      [barcode, userId]
    );

    return rows.map(row => ({
      id: row.ID,
      name: row.NAME,
      containerName: row.CONTAINER_NAME,
      areaName: row.AREA_NAME,
      propertyName: row.PROPERTY_NAME,
    }));
  },

  async searchByText(query) {
    const trimmed = query.trim();
    if (!trimmed) return [];

    // Strip FULLTEXT boolean operators and append * for prefix matching
    const booleanQuery = trimmed
      .split(/\s+/)
      .filter(Boolean)
      .map(word => word.replace(/[+\-><()~*"@]/g, ''))
      .filter(Boolean)
      .map(word => `${word}*`)
      .join(' ');

    // Try FULLTEXT search first (fast, relevance-ranked)
    let rows = [];
    if (booleanQuery.length > 0) {
      rows = await _db.query(
        `SELECT *
         FROM TALLY.products
         WHERE MATCH(NAME, BRAND, DESCRIPTION) AGAINST(? IN BOOLEAN MODE)
         LIMIT 50`,
        [booleanQuery]
      );
    }

    // Fallback to LIKE search if FULLTEXT returns nothing
    // (handles short words below ft_min_token_size, partial matches, etc.)
    if (rows.length === 0) {
      const likePattern = `%${trimmed}%`;
      rows = await _db.query(
        `SELECT *
         FROM TALLY.products
         WHERE NAME LIKE ? OR BRAND LIKE ? OR BARCODE LIKE ?
         ORDER BY NAME
         LIMIT 50`,
        [likePattern, likePattern, likePattern]
      );
    }

    return rows.map(ProductsService._mapProduct);
  },
};

module.exports = ProductsService;

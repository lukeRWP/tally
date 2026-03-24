class BaseRepository {
  /**
   * @param {object} opts
   * @param {object} opts.db        - DB module with query() method
   * @param {string} opts.table     - Table name
   * @param {string} opts.database  - Database name
   * @param {string} [opts.primaryKey='ID'] - Primary key column name
   */
  constructor({ db, table, database, primaryKey = 'ID' }) {
    this.db = db;
    this.table = table;
    this.database = database;
    this.primaryKey = primaryKey;
    this.fullTable = `\`${database}\`.\`${table}\``;
  }

  // ── Mapping hooks (override in subclasses) ────────────────────────────────

  /** Transform a DB row (UPPERCASE cols) → API entity (camelCase). */
  mapToEntity(row) {
    return row;
  }

  /** Transform an API entity (camelCase) → DB row (UPPERCASE cols). */
  mapToRow(entity) {
    return entity;
  }

  // ── Safety helpers ────────────────────────────────────────────────────────

  /**
   * Validate an ORDER BY clause against an allowlist to prevent SQL injection.
   * @param {string} orderBy - e.g. "NAME ASC" or "CREATED_AT DESC"
   * @param {string[]} allowedColumns - Column names permitted in ORDER BY
   * @returns {string|null} Sanitized ORDER BY string, or null if invalid
   */
  sanitizeOrderBy(orderBy, allowedColumns) {
    if (!orderBy || !allowedColumns || allowedColumns.length === 0) return null;

    // Allow one column + optional direction
    const match = orderBy.trim().match(/^([A-Z0-9_]+)(?:\s+(ASC|DESC))?$/i);
    if (!match) return null;

    const [, column, direction = 'ASC'] = match;

    const allowed = allowedColumns.map(c => c.toUpperCase());
    if (!allowed.includes(column.toUpperCase())) return null;

    return `${column.toUpperCase()} ${direction.toUpperCase()}`;
  }

  // ── Read operations ───────────────────────────────────────────────────────

  async findById(id) {
    const sql = `SELECT * FROM ${this.fullTable} WHERE \`${this.primaryKey}\` = ? AND DELETED_AT IS NULL LIMIT 1`;
    const rows = await this.db.query(sql, [id]);
    if (!rows || rows.length === 0) return null;
    return this.mapToEntity(rows[0]);
  }

  /**
   * @param {object} [opts]
   * @param {object} [opts.where]     - Key/value pairs for WHERE clause (AND logic)
   * @param {string} [opts.orderBy]   - Raw "COLUMN ASC|DESC" — caller must validate via sanitizeOrderBy
   * @param {number} [opts.limit]
   * @param {number} [opts.offset]
   */
  async findAll({ where, orderBy, limit, offset } = {}) {
    const conditions = ['DELETED_AT IS NULL'];
    const params = [];

    if (where && typeof where === 'object') {
      for (const [col, val] of Object.entries(where)) {
        conditions.push(`\`${col}\` = ?`);
        params.push(val);
      }
    }

    let sql = `SELECT * FROM ${this.fullTable} WHERE ${conditions.join(' AND ')}`;

    if (orderBy) {
      sql += ` ORDER BY ${orderBy}`;
    }

    if (limit !== undefined && limit !== null) {
      sql += ` LIMIT ?`;
      params.push(Number(limit));
    }

    if (offset !== undefined && offset !== null) {
      sql += ` OFFSET ?`;
      params.push(Number(offset));
    }

    const rows = await this.db.query(sql, params);
    return (rows || []).map(row => this.mapToEntity(row));
  }

  // ── Write operations ──────────────────────────────────────────────────────

  async insert(entity) {
    const row = this.mapToRow(entity);
    const columns = Object.keys(row).map(c => `\`${c}\``).join(', ');
    const placeholders = Object.keys(row).map(() => '?').join(', ');
    const values = Object.values(row);

    const sql = `INSERT INTO ${this.fullTable} (${columns}) VALUES (${placeholders})`;
    const result = await this.db.query(sql, values);
    return result.insertId;
  }

  async update(id, entity) {
    const row = this.mapToRow(entity);
    const assignments = Object.keys(row).map(c => `\`${c}\` = ?`).join(', ');
    const values = [...Object.values(row), id];

    const sql = `UPDATE ${this.fullTable} SET ${assignments} WHERE \`${this.primaryKey}\` = ?`;
    const result = await this.db.query(sql, values);
    return result.affectedRows;
  }

  /** Soft delete: sets DELETED_AT = NOW() */
  async delete(id) {
    const sql = `UPDATE ${this.fullTable} SET DELETED_AT = NOW() WHERE \`${this.primaryKey}\` = ?`;
    const result = await this.db.query(sql, [id]);
    return result.affectedRows;
  }

  /** Restore a soft-deleted record */
  async restore(id) {
    const sql = `UPDATE ${this.fullTable} SET DELETED_AT = NULL WHERE \`${this.primaryKey}\` = ?`;
    const result = await this.db.query(sql, [id]);
    return result.affectedRows;
  }

  // ── Aggregate operations ──────────────────────────────────────────────────

  async count(where) {
    const conditions = ['DELETED_AT IS NULL'];
    const params = [];

    if (where && typeof where === 'object') {
      for (const [col, val] of Object.entries(where)) {
        conditions.push(`\`${col}\` = ?`);
        params.push(val);
      }
    }

    const sql = `SELECT COUNT(*) AS cnt FROM ${this.fullTable} WHERE ${conditions.join(' AND ')}`;
    const rows = await this.db.query(sql, params);
    return Number(rows[0].cnt);
  }

  async exists(id) {
    const sql = `SELECT 1 FROM ${this.fullTable} WHERE \`${this.primaryKey}\` = ? AND DELETED_AT IS NULL LIMIT 1`;
    const rows = await this.db.query(sql, [id]);
    return rows && rows.length > 0;
  }
}

module.exports = BaseRepository;

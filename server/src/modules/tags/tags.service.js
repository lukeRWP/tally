let _db = null;
let _logger = null;

const TagsService = {
  // ── Initialization ─────────────────────────────────────────────────────────

  init({ db, logger }) {
    _db = db;
    _logger = logger;
  },

  // ── Helpers ────────────────────────────────────────────────────────────────

  _mapTag(row) {
    return {
      id: row.ID,
      name: row.NAME,
      color: row.COLOR,
      propertyId: row.PROPERTY_ID,
    };
  },

  // ── Queries ────────────────────────────────────────────────────────────────

  async getByProperty(propertyId) {
    const rows = await _db.query(
      'SELECT * FROM TALLY.tags WHERE PROPERTY_ID = ? ORDER BY NAME',
      [propertyId]
    );
    return rows.map(TagsService._mapTag);
  },

  async create(data) {
    const result = await _db.query(
      'INSERT INTO TALLY.tags (NAME, COLOR, PROPERTY_ID) VALUES (?, ?, ?)',
      [data.name, data.color, data.propertyId]
    );
    const rows = await _db.query(
      'SELECT * FROM TALLY.tags WHERE ID = ?',
      [result.insertId]
    );
    return TagsService._mapTag(rows[0]);
  },

  /**
   * Get the property's tag with this name, creating it only if absent.
   *
   * create() above is a blind INSERT, which is correct for the tag UI (the user
   * asked for a new tag; a collision is a real error worth showing them). It is
   * wrong for a category applied automatically at item-commit time: two items
   * saved back to back with the same new category race uq_tags_name_property,
   * and the loser's ER_DUP_ENTRY becomes a 409 on an item whose own data was
   * perfectly valid.
   *
   * The re-SELECT on collision is the same pattern addToEntity() already uses.
   *
   * NAME and PROPERTY_ID compare under MySQL's default case-insensitive
   * collation, here and in the unique key, so an approved `kitchen` REUSES an
   * existing user tag named `Kitchen` instead of creating a second row. That is
   * deliberate — do not "fix" it into a BINARY comparison.
   */
  async findOrCreate({ name, color, propertyId }) {
    const find = async () => {
      const rows = await _db.query(
        'SELECT * FROM TALLY.tags WHERE NAME = ? AND PROPERTY_ID = ? LIMIT 1',
        [name, propertyId]
      );
      return rows[0] ? TagsService._mapTag(rows[0]) : null;
    };

    const existing = await find();
    if (existing) return existing;

    try {
      return await TagsService.create({ name, color, propertyId });
    } catch (err) {
      // Someone else inserted the same name between our SELECT and our INSERT.
      if (err.code === 'ER_DUP_ENTRY') {
        const winner = await find();
        if (winner) return winner;
      }
      throw err;
    }
  },

  async update(id, data) {
    const fields = [];
    const values = [];

    if (data.name !== undefined) { fields.push('NAME = ?'); values.push(data.name); }
    if (data.color !== undefined) { fields.push('COLOR = ?'); values.push(data.color); }

    if (!fields.length) {
      const rows = await _db.query('SELECT * FROM TALLY.tags WHERE ID = ?', [id]);
      return rows[0] ? TagsService._mapTag(rows[0]) : null;
    }

    values.push(id);
    await _db.query(
      `UPDATE TALLY.tags SET ${fields.join(', ')} WHERE ID = ?`,
      values
    );

    const rows = await _db.query('SELECT * FROM TALLY.tags WHERE ID = ?', [id]);
    return rows[0] ? TagsService._mapTag(rows[0]) : null;
  },

  async delete(id) {
    await _db.query('DELETE FROM TALLY.entity_tags WHERE TAG_ID = ?', [id]);
    await _db.query('DELETE FROM TALLY.tags WHERE ID = ?', [id]);
  },

  async addToEntity(tagId, entityType, entityId) {
    try {
      await _db.query(
        'INSERT INTO TALLY.entity_tags (TAG_ID, ENTITY_TYPE, ENTITY_ID) VALUES (?, ?, ?)',
        [tagId, entityType, entityId]
      );
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') return; // Already tagged — ignore
      throw err;
    }
  },

  async removeFromEntity(tagId, entityType, entityId) {
    await _db.query(
      'DELETE FROM TALLY.entity_tags WHERE TAG_ID = ? AND ENTITY_TYPE = ? AND ENTITY_ID = ?',
      [tagId, entityType, entityId]
    );
  },

  async getForEntity(entityType, entityId) {
    const rows = await _db.query(
      `SELECT t.* FROM TALLY.tags t
       JOIN TALLY.entity_tags et ON t.ID = et.TAG_ID
       WHERE et.ENTITY_TYPE = ? AND et.ENTITY_ID = ?
       ORDER BY t.NAME`,
      [entityType, entityId]
    );
    return rows.map(TagsService._mapTag);
  },

  async getPropertyIdForTag(tagId) {
    const rows = await _db.query(
      'SELECT PROPERTY_ID FROM TALLY.tags WHERE ID = ?',
      [tagId]
    );
    return rows[0]?.PROPERTY_ID || null;
  },
};

module.exports = TagsService;

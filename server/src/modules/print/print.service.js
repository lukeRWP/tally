const crypto = require('crypto');   // used by claimNext's randomUUID in Task 4

let _db = null;
let _logger = null;

// Membership-scoped property resolution per entity type. Every branch INNER
// JOINs property_members, so an entity the caller cannot see simply yields no
// row for it. Each branch returns one row per visible entity (ENTITY_ID +
// PROPERTY_ID) rather than a distinct property list, so resolveProperty can
// verify EVERY requested id resolved instead of accepting a partial batch.
const PROPERTY_SQL = {
  item: `SELECT i.ID AS ENTITY_ID, a.PROPERTY_ID
           FROM TALLY.items i
           JOIN TALLY.containers c ON i.CONTAINER_ID = c.ID
           JOIN TALLY.areas a ON c.AREA_ID = a.ID
           JOIN TALLY.property_members pm ON pm.PROPERTY_ID = a.PROPERTY_ID AND pm.USER_ID = ?
          WHERE i.ID IN (:ids) AND i.DELETED_AT IS NULL`,
  container: `SELECT c.ID AS ENTITY_ID, a.PROPERTY_ID
           FROM TALLY.containers c
           JOIN TALLY.areas a ON c.AREA_ID = a.ID
           JOIN TALLY.property_members pm ON pm.PROPERTY_ID = a.PROPERTY_ID AND pm.USER_ID = ?
          WHERE c.ID IN (:ids) AND c.DELETED_AT IS NULL`,
  area: `SELECT a.ID AS ENTITY_ID, a.PROPERTY_ID
           FROM TALLY.areas a
           JOIN TALLY.property_members pm ON pm.PROPERTY_ID = a.PROPERTY_ID AND pm.USER_ID = ?
          WHERE a.ID IN (:ids) AND a.DELETED_AT IS NULL`,
};

const PrintService = {
  init({ db, logger }) {
    _db = db;
    _logger = logger;
  },

  _mapJob(row) {
    return {
      id: row.ID,
      propertyId: row.PROPERTY_ID,
      createdBy: row.CREATED_BY,
      entityType: row.ENTITY_TYPE,
      entityIds: typeof row.ENTITY_IDS === 'string' ? JSON.parse(row.ENTITY_IDS) : row.ENTITY_IDS,
      preset: row.PRESET,
      status: row.STATUS,
      attempts: row.ATTEMPTS,
      lastError: row.LAST_ERROR,
      printedAt: row.PRINTED_AT,
      createdAt: row.CREATED_AT,
    };
  },

  // ── User-side ─────────────────────────────────────────────────────────────

  async resolveProperty(entityType, entityIds, userId) {
    const template = PROPERTY_SQL[entityType];
    if (!template) return { error: 'not_found' };

    // Dedupe first so a caller passing e.g. [5,5] isn't penalized by the
    // "every id resolved" check below — it's still one entity, not two.
    const uniqueIds = [...new Set(entityIds)];
    // Guard before building SQL: an empty array would otherwise produce an
    // invalid `IN ()` clause. Joi guards the route, but this method is
    // exported and called directly elsewhere (createJob; future tasks).
    if (uniqueIds.length === 0) return { error: 'not_found' };

    const sql = template.replace(':ids', uniqueIds.map(() => '?').join(', '));
    const rows = await _db.query(sql, [userId, ...uniqueIds]);

    // Every requested id must resolve — a partially-visible batch (e.g. one
    // foreign/nonexistent id mixed with visible ones) must be refused rather
    // than silently narrowed to whatever the caller could see.
    const resolvedIds = new Set(rows.map((r) => r.ENTITY_ID));
    if (resolvedIds.size !== uniqueIds.length) return { error: 'not_found' };

    const propertyIds = new Set(rows.map((r) => r.PROPERTY_ID));
    if (propertyIds.size > 1) return { error: 'mixed' };
    return { propertyId: rows[0].PROPERTY_ID };
  },

  async createJob({ entityType, entityIds, preset, userId }) {
    const resolved = await PrintService.resolveProperty(entityType, entityIds, userId);
    if (resolved.error) return { error: resolved.error };
    const { propertyId } = resolved;

    // Hold the job when a roll is loaded that does not match. With no agent
    // registered yet the job simply waits as `queued`.
    //
    // The UI assumes one printer per property, but printer_agents has no
    // uniqueness constraint on PROPERTY_ID. ORDER BY ID makes the held/queued
    // decision deterministic (always the first-registered agent) if a second
    // agent is ever registered for the same property, instead of depending
    // on unspecified storage order.
    const agents = await _db.query(
      'SELECT LOADED_MEDIA FROM TALLY.printer_agents WHERE PROPERTY_ID = ? ORDER BY ID LIMIT 1',
      [propertyId]
    );
    const status = agents.length > 0 && agents[0].LOADED_MEDIA !== preset ? 'held' : 'queued';

    const result = await _db.query(
      `INSERT INTO TALLY.print_jobs (PROPERTY_ID, CREATED_BY, ENTITY_TYPE, ENTITY_IDS, PRESET, STATUS)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [propertyId, userId, entityType, JSON.stringify(entityIds), preset, status]
    );
    return { id: result.insertId, status };
  },

  async listJobs(propertyId, userId, limit = 50) {
    const rows = await _db.query(
      `SELECT j.* FROM TALLY.print_jobs j
         JOIN TALLY.property_members pm ON pm.PROPERTY_ID = j.PROPERTY_ID AND pm.USER_ID = ?
        WHERE j.PROPERTY_ID = ?
        ORDER BY j.CREATED_AT DESC
        LIMIT ?`,
      [userId, propertyId, limit]
    );
    return rows.map(PrintService._mapJob);
  },

  async cancelJob(id, userId) {
    const result = await _db.query(
      `UPDATE TALLY.print_jobs j
         JOIN TALLY.property_members pm ON pm.PROPERTY_ID = j.PROPERTY_ID AND pm.USER_ID = ?
          SET j.STATUS = 'canceled'
        WHERE j.ID = ? AND j.STATUS IN ('queued', 'held', 'claimed')`,
      [userId, id]
    );
    return result.affectedRows > 0;
  },

  async retryJob(id, userId) {
    const result = await _db.query(
      `UPDATE TALLY.print_jobs j
         JOIN TALLY.property_members pm ON pm.PROPERTY_ID = j.PROPERTY_ID AND pm.USER_ID = ?
          SET j.STATUS = 'queued', j.ATTEMPTS = 0, j.LAST_ERROR = NULL,
              j.CLAIM_ID = NULL, j.CLAIMED_BY = NULL, j.CLAIMED_AT = NULL
        WHERE j.ID = ? AND j.STATUS = 'failed'`,
      [userId, id]
    );
    return result.affectedRows > 0;
  },
};

module.exports = PrintService;

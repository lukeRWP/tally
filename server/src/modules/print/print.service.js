const crypto = require('crypto');   // used by claimNext's randomUUID in Task 4
const LabelsService = require('../labels/labels.service');

let _db = null;
let _logger = null;

const STALE_CLAIM_MINUTES = 5;
const MAX_ATTEMPTS = 3;

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

  // ── Agent-side ────────────────────────────────────────────────────────────

  async sweepStaleClaims(propertyId) {
    // An agent that dies mid-job would otherwise strand its row in `claimed`
    // forever. Lazy sweep on each claim — no cron, no scheduler.
    const result = await _db.query(
      `UPDATE TALLY.print_jobs
          SET STATUS = 'queued', ATTEMPTS = ATTEMPTS + 1,
              CLAIM_ID = NULL, CLAIMED_BY = NULL, CLAIMED_AT = NULL
        WHERE PROPERTY_ID = ? AND STATUS = 'claimed'
          AND CLAIMED_AT < DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
      [propertyId, STALE_CLAIM_MINUTES]
    );
    return result.affectedRows;
  },

  async claimNext(agent, telemetry = {}) {
    // Telemetry rides the claim: liveness + printer state in one write.
    await _db.query(
      `UPDATE TALLY.printer_agents
          SET LAST_SEEN_AT = NOW(), PRINTER_STATE = ?, PRINTER_STATE_REASONS = ?
        WHERE ID = ?`,
      [telemetry.printerState || 'unknown',
       JSON.stringify(telemetry.printerStateReasons || []),
       agent.id]
    );

    await PrintService.sweepStaleClaims(agent.propertyId);

    // PROPERTY_ID and PRESET come from the agent row — never from the request,
    // so an agent cannot reach another property or pull a roll it hasn't loaded.
    const claimId = crypto.randomUUID();
    const claimed = await _db.query(
      `UPDATE TALLY.print_jobs
          SET STATUS = 'claimed', CLAIM_ID = ?, CLAIMED_BY = ?, CLAIMED_AT = NOW()
        WHERE PROPERTY_ID = ? AND STATUS = 'queued' AND PRESET = ?
        ORDER BY CREATED_AT
        LIMIT 1`,
      [claimId, agent.id, agent.propertyId, agent.loadedMedia]
    );
    if (claimed.affectedRows === 0) return null;

    const rows = await _db.query(
      'SELECT * FROM TALLY.print_jobs WHERE CLAIM_ID = ?', [claimId]
    );
    return rows.length > 0 ? PrintService._mapJob(rows[0]) : null;
  },

  async getClaimedJob(jobId, agentId) {
    const rows = await _db.query(
      `SELECT * FROM TALLY.print_jobs
        WHERE ID = ? AND CLAIMED_BY = ? AND STATUS = 'claimed'`,
      [jobId, agentId]
    );
    return rows.length > 0 ? PrintService._mapJob(rows[0]) : null;
  },

  async renderJobPdf(job) {
    // Rendered AS THE QUEUING USER: Phase 1's renderers are membership-scoped,
    // so this inherits that scoping instead of inventing an unscoped path. If
    // the user has since lost access the render yields nothing and the job fails.
    if (job.preset === 'large') {
      const manifests = [];
      for (const id of job.entityIds) {
        const m = await LabelsService.getManifest(job.entityType, id, job.createdBy);
        if (m) manifests.push(m);
      }
      if (manifests.length === 0) return null;
      return LabelsService.renderManifestBundle(manifests, 'large');
    }

    const entities = await LabelsService.getEntityData(job.entityType, job.entityIds, job.createdBy);
    if (entities.length === 0) return null;
    return LabelsService.renderLabelPdf(entities, job.preset);
  },

  async ackJob(jobId, agentId, ok, errorText) {
    if (ok) {
      const result = await _db.query(
        `UPDATE TALLY.print_jobs
            SET STATUS = 'done', PRINTED_AT = NOW(), LAST_ERROR = NULL
          WHERE ID = ? AND CLAIMED_BY = ? AND STATUS = 'claimed'`,
        [jobId, agentId]
      );
      return result.affectedRows > 0 ? 'done' : null;
    }

    const rows = await _db.query(
      `SELECT ATTEMPTS FROM TALLY.print_jobs
        WHERE ID = ? AND CLAIMED_BY = ? AND STATUS = 'claimed'`,
      [jobId, agentId]
    );
    if (rows.length === 0) return null;

    const nextAttempts = rows[0].ATTEMPTS + 1;
    const nextStatus = nextAttempts >= MAX_ATTEMPTS ? 'failed' : 'queued';
    await _db.query(
      `UPDATE TALLY.print_jobs
          SET STATUS = ?, ATTEMPTS = ?, LAST_ERROR = ?,
              CLAIM_ID = NULL, CLAIMED_BY = NULL, CLAIMED_AT = NULL
        WHERE ID = ? AND CLAIMED_BY = ?`,
      [nextStatus, nextAttempts, errorText || null, jobId, agentId]
    );
    return nextStatus;
  },
};

module.exports = PrintService;

const crypto = require('crypto');   // used by claimNext's randomUUID in Task 4
const LabelsService = require('../labels/labels.service');
const { generateToken, hashToken } = require('./agent.middleware');

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
      // Handed to the agent so it can fence its ack to THIS claim. Without it a
      // delayed/retried ack could land on a later claim of the same job.
      claimId: row.CLAIM_ID ?? null,
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

    // The property is only known after resolving the entities, so this is the
    // first point a role gate can run — the routes cannot do it up front.
    // Printing is an editing action: a viewer must not be able to queue jobs
    // (or, via a large-preset manifest, render the whole inventory).
    const member = await _db.query(
      'SELECT ROLE FROM TALLY.property_members WHERE PROPERTY_ID = ? AND USER_ID = ?',
      [propertyId, userId]
    );
    const role = member[0]?.ROLE || null;
    if (role !== 'owner' && role !== 'editor') return { error: 'forbidden' };

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
          SET j.STATUS = 'canceled',
              j.CLAIM_ID = NULL, j.CLAIMED_BY = NULL, j.CLAIMED_AT = NULL
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
    // The attempt cap applies here too. Without it a job that is claimed and
    // abandoned over and over is requeued forever — reprinting each time and
    // never reaching 'failed' — so one poison job could wedge the queue
    // indefinitely. Mirrors the cap ackJob applies on an explicit failure.
    const result = await _db.query(
      `UPDATE TALLY.print_jobs
          SET STATUS = CASE WHEN ATTEMPTS + 1 >= ? THEN 'failed' ELSE 'queued' END,
              LAST_ERROR = CASE WHEN ATTEMPTS + 1 >= ?
                                THEN 'Printer stopped responding mid-job'
                                ELSE LAST_ERROR END,
              ATTEMPTS = ATTEMPTS + 1,
              CLAIM_ID = NULL, CLAIMED_BY = NULL, CLAIMED_AT = NULL
        WHERE PROPERTY_ID = ? AND STATUS = 'claimed'
          AND CLAIMED_AT < DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
      [MAX_ATTEMPTS, MAX_ATTEMPTS, propertyId, STALE_CLAIM_MINUTES]
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

  // Property is checked as well as the claim: spec §6 states a two-part
  // guard, and relying on CLAIMED_BY alone means one deleted-and-reused
  // agent id would be the only thing between a job and the wrong printer.
  async getClaimedJob(jobId, agentId, propertyId) {
    const rows = await _db.query(
      `SELECT * FROM TALLY.print_jobs
        WHERE ID = ? AND CLAIMED_BY = ? AND PROPERTY_ID = ? AND STATUS = 'claimed'`,
      [jobId, agentId, propertyId]
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

  // claimId fences the ack to the specific claim it belongs to. A retried or
  // delayed ack could otherwise land on a LATER claim of the same job (same
  // agent, also 'claimed') and wrongly mark an in-flight print done.
  async ackJob(jobId, agentId, ok, errorText, claimId) {
    const fence = claimId ? ' AND CLAIM_ID = ?' : '';
    const fenceParam = claimId ? [claimId] : [];
    if (ok) {
      const result = await _db.query(
        `UPDATE TALLY.print_jobs
            SET STATUS = 'done', PRINTED_AT = NOW(), LAST_ERROR = NULL
          WHERE ID = ? AND CLAIMED_BY = ? AND STATUS = 'claimed'${fence}`,
        [jobId, agentId, ...fenceParam]
      );
      return result.affectedRows > 0 ? 'done' : null;
    }

    const rows = await _db.query(
      `SELECT ATTEMPTS FROM TALLY.print_jobs
        WHERE ID = ? AND CLAIMED_BY = ? AND STATUS = 'claimed'${fence}`,
      [jobId, agentId, ...fenceParam]
    );
    if (rows.length === 0) return null;

    const nextAttempts = rows[0].ATTEMPTS + 1;
    const nextStatus = nextAttempts >= MAX_ATTEMPTS ? 'failed' : 'queued';
    // Re-assert STATUS = 'claimed' here, not just in the SELECT above: a
    // concurrent claimNext() can sweep this very claim as stale in between,
    // which already requeues the row and clears CLAIMED_BY. Without this guard
    // the UPDATE silently matches nothing while we return a status the row
    // never took. Report null instead so the caller knows the ack didn't land.
    const written = await _db.query(
      `UPDATE TALLY.print_jobs
          SET STATUS = ?, ATTEMPTS = ?, LAST_ERROR = ?,
              CLAIM_ID = NULL, CLAIMED_BY = NULL, CLAIMED_AT = NULL
        WHERE ID = ? AND CLAIMED_BY = ? AND STATUS = 'claimed'${fence}`,
      [nextStatus, nextAttempts, errorText || null, jobId, agentId, ...fenceParam]
    );
    return written.affectedRows > 0 ? nextStatus : null;
  },

  // ── Agent registration & roll state ───────────────────────────────────────

  async createAgent({ propertyId, name, userId }) {
    const member = await _db.query(
      'SELECT PROPERTY_ID FROM TALLY.property_members WHERE PROPERTY_ID = ? AND USER_ID = ?',
      [propertyId, userId]
    );
    if (member.length === 0) return { error: 'not_found' };

    // Plaintext is handed back exactly once and never persisted.
    const token = generateToken();
    const result = await _db.query(
      'INSERT INTO TALLY.printer_agents (PROPERTY_ID, NAME, TOKEN_HASH) VALUES (?, ?, ?)',
      [propertyId, name, hashToken(token)]
    );
    return { id: result.insertId, name, token };
  },

  async listAgents(propertyId, userId) {
    const rows = await _db.query(
      `SELECT a.ID, a.PROPERTY_ID, a.NAME, a.LOADED_MEDIA, a.PRINTER_STATE,
              a.PRINTER_STATE_REASONS, a.LAST_SEEN_AT
         FROM TALLY.printer_agents a
         JOIN TALLY.property_members pm ON pm.PROPERTY_ID = a.PROPERTY_ID AND pm.USER_ID = ?
        WHERE a.PROPERTY_ID = ?`,
      [userId, propertyId]
    );
    // TOKEN_HASH is deliberately not selected — it must never reach the client.
    return rows.map(r => ({
      id: r.ID,
      propertyId: r.PROPERTY_ID,
      name: r.NAME,
      loadedMedia: r.LOADED_MEDIA,
      printerState: r.PRINTER_STATE,
      printerStateReasons: typeof r.PRINTER_STATE_REASONS === 'string'
        ? JSON.parse(r.PRINTER_STATE_REASONS || '[]')
        : (r.PRINTER_STATE_REASONS || []),
      lastSeenAt: r.LAST_SEEN_AT,
    }));
  },

  async revokeAgent(id, userId) {
    const result = await _db.query(
      `DELETE a FROM TALLY.printer_agents a
         JOIN TALLY.property_members pm ON pm.PROPERTY_ID = a.PROPERTY_ID AND pm.USER_ID = ?
        WHERE a.ID = ?`,
      [userId, id]
    );
    return result.affectedRows > 0;
  },

  async setLoadedMedia(agentId, loadedMedia, userId) {
    const updated = await _db.query(
      `UPDATE TALLY.printer_agents a
         JOIN TALLY.property_members pm ON pm.PROPERTY_ID = a.PROPERTY_ID AND pm.USER_ID = ?
          SET a.LOADED_MEDIA = ?
        WHERE a.ID = ?`,
      [userId, loadedMedia, agentId]
    );
    if (updated.affectedRows === 0) return null;

    // Swapping the roll cuts both ways. Anything queued for the OLD roll is now
    // unprintable — the claim filters on PRESET = LOADED_MEDIA, so those rows
    // would sit in 'queued' forever, displayed as ready but never claimable.
    // Park them back in 'held' so they show honestly and are released when
    // their roll is loaded again.
    const heldBack = await _db.query(
      `UPDATE TALLY.print_jobs j
         JOIN TALLY.printer_agents a ON a.PROPERTY_ID = j.PROPERTY_ID
          SET j.STATUS = 'held'
        WHERE a.ID = ? AND j.STATUS = 'queued' AND j.PRESET <> ?`,
      [agentId, loadedMedia]
    );

    // Loading a roll releases everything that was waiting on exactly that roll.
    const released = await _db.query(
      `UPDATE TALLY.print_jobs j
         JOIN TALLY.printer_agents a ON a.PROPERTY_ID = j.PROPERTY_ID
          SET j.STATUS = 'queued'
        WHERE a.ID = ? AND j.STATUS = 'held' AND j.PRESET = ?`,
      [agentId, loadedMedia]
    );
    return { released: released.affectedRows, held: heldBack.affectedRows };
  },
};

module.exports = PrintService;

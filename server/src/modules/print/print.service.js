const crypto = require('crypto');   // used by claimNext's randomUUID in Task 4
const LabelsService = require('../labels/labels.service');
const { generateToken, hashToken, BYPASS_SERVICE_ACCOUNT_ID } = require('./agent.middleware');

let _db = null;
let _logger = null;

const STALE_CLAIM_MINUTES = 5;
const MAX_ATTEMPTS = 3;

// Shared by setLoadedMedia (loading a new roll) and moveAgent (arriving at a
// new property): whichever printer_agents row matches `agentId` names the
// property whose queue gets reconciled against `loadedMedia` — queued jobs
// for a different preset are held, held jobs for this preset are released.
// Takes a bound query fn so either _db.query (plain) or tx.query (inside
// moveAgent's transaction) works.
async function reconcileQueueForMedia(q, agentId, loadedMedia) {
  const heldBack = await q(
    `UPDATE TALLY.print_jobs j
       JOIN TALLY.printer_agents a ON a.PROPERTY_ID = j.PROPERTY_ID
        SET j.STATUS = 'held'
      WHERE a.ID = ? AND j.STATUS = 'queued' AND j.PRESET <> ?`,
    [agentId, loadedMedia]
  );
  const released = await q(
    `UPDATE TALLY.print_jobs j
       JOIN TALLY.printer_agents a ON a.PROPERTY_ID = j.PROPERTY_ID
        SET j.STATUS = 'queued'
      WHERE a.ID = ? AND j.STATUS = 'held' AND j.PRESET = ?`,
    [agentId, loadedMedia]
  );
  return { released: released.affectedRows, held: heldBack.affectedRows };
}

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

    // Hold the job when a roll is loaded that does not match.
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

    // A property with NO registered agent still gets a `queued` row, because a
    // printer may be registered later and the job should print when it is.
    // But `queued` reads as "about to print", and agent claims are
    // property-scoped by design — so with no agent the job is unclaimable by
    // construction and will sit there indefinitely. Found in prod: job 27 sat
    // `queued` for five days for a property with no printer, while another
    // property's agent printed forty jobs beside it. Nothing said so.
    //
    // Reported rather than refused: the row is still useful, and refusing
    // would break queueing labels ahead of setting a printer up. The caller
    // gets the fact so the UI can say it at the moment of queueing, which is
    // the only moment anyone is looking.
    return { id: result.insertId, status, noAgent: agents.length === 0 };
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

    // The agent is asking "anything for me?" while its own telemetry says the
    // printer cannot print (#125). Dealing it a job anyway just burns one of
    // the job's 3 attempts per poll for nothing — the honest answer is nothing.
    // Jobs stay 'queued' (the telemetry banner explains why they wait) and are
    // dealt on the first claim after the printer recovers. Only an EXPLICIT
    // 'stopped' withholds: the schema coerces junk telemetry to 'unknown',
    // which — like idle/printing — claims normally, so telemetry still can
    // never break a claim. The sweep above still runs so a claim abandoned by
    // a dead agent process is not stranded while the printer is down.
    if (telemetry.printerState === 'stopped') return null;

    // PROPERTY_ID and PRESET come from the agent row — never from the request,
    // so an agent cannot reach another property or pull a roll it hasn't loaded.
    //
    // agent.propertyId was read by the auth middleware before this statement
    // runs, and a concurrent moveAgent can commit in between — without a
    // re-check here, this UPDATE would happily claim a job still sitting at
    // the OLD property, which nothing will ever sweep again (sweeps are
    // scoped per-property too). The EXISTS subquery re-reads printer_agents
    // for THIS agent id at claim time; a subquery on a DIFFERENT table is
    // legal inside the same UPDATE (MySQL error 1093 only forbids the target
    // table), so this stays the single-table UPDATE ORDER BY/LIMIT needs.
    // That read also locks the same agent row moveAgent holds FOR UPDATE, so
    // a claim racing a move simply waits for it, then matches nothing against
    // the agent's new property.
    const claimId = crypto.randomUUID();
    const claimed = await _db.query(
      `UPDATE TALLY.print_jobs
          SET STATUS = 'claimed', CLAIM_ID = ?, CLAIMED_BY = ?, CLAIMED_AT = NOW()
        WHERE PROPERTY_ID = ? AND STATUS = 'queued' AND PRESET = ?
          AND EXISTS (SELECT 1 FROM TALLY.printer_agents a WHERE a.ID = ? AND a.PROPERTY_ID = print_jobs.PROPERTY_ID)
        ORDER BY CREATED_AT
        LIMIT 1`,
      [claimId, agent.id, agent.propertyId, agent.loadedMedia, agent.id]
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
  // agent, also 'claimed') and wrongly mark an in-flight print done. The fence
  // is MANDATORY (#104): when it was optional, an ack that simply omitted
  // claimId skipped the fence entirely and reopened exactly that hole. The
  // schema already requires it on the route; refusing here as well keeps a
  // direct caller from acking unfenced.
  async ackJob(jobId, agentId, ok, errorText, claimId) {
    if (!claimId) return null;
    if (ok) {
      const result = await _db.query(
        `UPDATE TALLY.print_jobs
            SET STATUS = 'done', PRINTED_AT = NOW(), LAST_ERROR = NULL
          WHERE ID = ? AND CLAIMED_BY = ? AND STATUS = 'claimed' AND CLAIM_ID = ?`,
        [jobId, agentId, claimId]
      );
      return result.affectedRows > 0 ? 'done' : null;
    }

    const rows = await _db.query(
      `SELECT ATTEMPTS FROM TALLY.print_jobs
        WHERE ID = ? AND CLAIMED_BY = ? AND STATUS = 'claimed' AND CLAIM_ID = ?`,
      [jobId, agentId, claimId]
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
        WHERE ID = ? AND CLAIMED_BY = ? AND STATUS = 'claimed' AND CLAIM_ID = ?`,
      [nextStatus, nextAttempts, errorText || null, jobId, agentId, claimId]
    );
    return written.affectedRows > 0 ? nextStatus : null;
  },

  // ── Agent registration & roll state ───────────────────────────────────────

  async createAgent({ propertyId, name, userId, serviceAccountId }) {
    const member = await _db.query(
      'SELECT PROPERTY_ID FROM TALLY.property_members WHERE PROPERTY_ID = ? AND USER_ID = ?',
      [propertyId, userId]
    );
    if (member.length === 0) return { error: 'not_found' };

    // Register straight onto a pwiam service account — no tp_ token is
    // minted at all (TOKEN_HASH stays NULL, migration 016). Same #122 tether:
    // CREATED_BY is the registering owner.
    if (serviceAccountId) {
      if (serviceAccountId === BYPASS_SERVICE_ACCOUNT_ID) return { error: 'forbidden' };
      try {
        const result = await _db.query(
          'INSERT INTO TALLY.printer_agents (PROPERTY_ID, NAME, SERVICE_ACCOUNT_ID, CREATED_BY) VALUES (?, ?, ?, ?)',
          [propertyId, name, serviceAccountId, userId]
        );
        return { id: result.insertId, name, serviceAccountId };
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return { error: 'bound_elsewhere' };
        throw err;
      }
    }

    // Plaintext is handed back exactly once and never persisted. CREATED_BY is
    // the tether requireAgent validates against (#122): the token dies with
    // this user's membership (or an ownership demotion), not with the heat
    // death of the universe.
    const token = generateToken();
    const result = await _db.query(
      'INSERT INTO TALLY.printer_agents (PROPERTY_ID, NAME, TOKEN_HASH, CREATED_BY) VALUES (?, ?, ?, ?)',
      [propertyId, name, hashToken(token), userId]
    );
    return { id: result.insertId, name, token };
  },

  // Pairs an EXISTING printer row with a pwiam service account (owner-only,
  // route-gated). CREATED_BY moves to the binder, so the #122 tether follows
  // whoever did the pairing rather than whoever originally registered the
  // printer — the same rule createAgent establishes at registration time.
  // No proof of possession is asked for: the SA id alone grants nothing
  // without its key, so recording who bound it is enough (the binder is
  // already an owner, checked by the route's role gate).
  async bindServiceAccount(agentId, serviceAccountId, userId) {
    if (serviceAccountId === BYPASS_SERVICE_ACCOUNT_ID) return { error: 'forbidden' };

    try {
      const result = await _db.query(
        `UPDATE TALLY.printer_agents a
           JOIN TALLY.property_members pm ON pm.PROPERTY_ID = a.PROPERTY_ID AND pm.USER_ID = ?
            SET a.SERVICE_ACCOUNT_ID = ?, a.CREATED_BY = ?
          WHERE a.ID = ?`,
        [userId, serviceAccountId, userId, agentId]
      );
      if (result.affectedRows === 0) return { error: 'not_found' };
      return { id: agentId, serviceAccountId };
    } catch (err) {
      // The UNIQUE key on SERVICE_ACCOUNT_ID (migration 016) is what actually
      // enforces "one printer per service account" — this catch just turns
      // the constraint violation into the same {error} shape every other
      // method here uses instead of a raw MySQL error reaching the route.
      if (err.code === 'ER_DUP_ENTRY') return { error: 'bound_elsewhere' };
      throw err;
    }
  },

  async unbindServiceAccount(agentId, userId) {
    const result = await _db.query(
      `UPDATE TALLY.printer_agents a
         JOIN TALLY.property_members pm ON pm.PROPERTY_ID = a.PROPERTY_ID AND pm.USER_ID = ?
          SET a.SERVICE_ACCOUNT_ID = NULL
        WHERE a.ID = ?`,
      [userId, agentId]
    );
    return result.affectedRows > 0;
  },

  async listAgents(propertyId, userId) {
    const rows = await _db.query(
      `SELECT a.ID, a.PROPERTY_ID, a.NAME, a.LOADED_MEDIA, a.PRINTER_STATE,
              a.PRINTER_STATE_REASONS, a.LAST_SEEN_AT, a.SERVICE_ACCOUNT_ID
         FROM TALLY.printer_agents a
         JOIN TALLY.property_members pm ON pm.PROPERTY_ID = a.PROPERTY_ID AND pm.USER_ID = ?
        WHERE a.PROPERTY_ID = ?`,
      [userId, propertyId]
    );
    // TOKEN_HASH is deliberately not selected — it must never reach the
    // client. SERVICE_ACCOUNT_ID is not a secret (the id alone grants nothing
    // without its pwk_ key) and the Settings UI needs it to show pairing state.
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
      serviceAccountId: r.SERVICE_ACCOUNT_ID || null,
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
    return reconcileQueueForMedia(_db.query, agentId, loadedMedia);
  },

  // Move an existing printer to a different property the caller owns,
  // keeping its credential (tp_ token or pwk_ key) unchanged — no SD-card
  // swap on the Pi. Everything else about the printer row survives the move
  // except two things that must change together:
  //
  // - CREATED_BY moves to the mover. Both agent auth paths (agent.middleware.js
  //   requireAgent and the pwk_ path) join property_members ON PROPERTY_ID =
  //   a.PROPERTY_ID AND USER_ID = a.CREATED_BY AND ROLE = 'owner' (#122
  //   tether) — keeping the old CREATED_BY would lock the Pi out the moment
  //   that user isn't an owner of the destination. Same rule bindServiceAccount
  //   already follows for pairing.
  // - The destination's queue is reconciled against LOADED_MEDIA exactly as
  //   setLoadedMedia does, because the printer now sits in front of a
  //   different property's jobs.
  //
  // Jobs left at the OLD property are untouched — they belong to that
  // property's labels and stay there. Only claims THIS agent currently holds
  // move with it (requeued, not failed: this is an operator action, not a
  // job failure, so ATTEMPTS is never incremented).
  async moveAgent(agentId, toPropertyId, userId) {
    const result = await _db.withTransaction(async (tx) => {
      const agentRows = await tx.query(
        `SELECT a.ID, a.PROPERTY_ID, a.LOADED_MEDIA
           FROM TALLY.printer_agents a
           JOIN TALLY.property_members pm ON pm.PROPERTY_ID = a.PROPERTY_ID
                AND pm.USER_ID = ? AND pm.ROLE = 'owner'
          WHERE a.ID = ?
          FOR UPDATE`,
        [userId, agentId]
      );
      if (agentRows.length === 0) return { error: 'not_found' };
      const agent = agentRows[0];

      if (agent.PROPERTY_ID === toPropertyId) return { error: 'same_property' };

      // 404, not 403: a destination that exists but isn't owned by the
      // caller must read the same as one that doesn't exist at all — the
      // same leak-nothing rule restore()'s batch lookup follows.
      const destRows = await tx.query(
        `SELECT p.ID FROM TALLY.properties p
           JOIN TALLY.property_members pm ON pm.PROPERTY_ID = p.ID
                AND pm.USER_ID = ? AND pm.ROLE = 'owner'
          WHERE p.ID = ? AND p.DELETED_AT IS NULL
          FOR UPDATE`,
        [userId, toPropertyId]
      );
      if (destRows.length === 0) return { error: 'destination_not_found' };

      // The UI assumes one printer per property (it renders printers[0]).
      const existing = await tx.query(
        'SELECT ID FROM TALLY.printer_agents WHERE PROPERTY_ID = ? FOR UPDATE',
        [toPropertyId]
      );
      if (existing.length > 0) return { error: 'destination_has_printer' };

      // Requeue whatever this agent currently holds. The stale-claim sweep
      // only runs on claims at the job's OWN property, so a departed
      // printer's claims would otherwise be stranded in 'claimed' forever;
      // clearing CLAIM_ID also fences out a late ack from the Pi for the
      // claim it no longer holds. PROPERTY_ID = ? (the agent's CURRENT,
      // pre-move property) is added alongside CLAIMED_BY so this hits
      // idx_print_jobs_claim instead of a bare CLAIMED_BY scan — unindexed,
      // it would lock every row in print_jobs for the duration of this
      // transaction. A claim is only ever made at the agent's own property,
      // so the added predicate narrows nothing a correct claim could violate.
      const requeued = await tx.query(
        `UPDATE TALLY.print_jobs
            SET STATUS = 'queued', CLAIM_ID = NULL, CLAIMED_BY = NULL, CLAIMED_AT = NULL
          WHERE CLAIMED_BY = ? AND STATUS = 'claimed' AND PROPERTY_ID = ?`,
        [agentId, agent.PROPERTY_ID]
      );

      await tx.query(
        'UPDATE TALLY.printer_agents SET PROPERTY_ID = ?, CREATED_BY = ? WHERE ID = ?',
        [toPropertyId, userId, agentId]
      );

      // Reconcile AFTER the move: the agent row now points at toPropertyId,
      // so this scopes to the destination's queue exactly like setLoadedMedia.
      const { released, held } = await reconcileQueueForMedia(tx.query, agentId, agent.LOADED_MEDIA);

      return {
        id: agentId, propertyId: toPropertyId, requeued: requeued.affectedRows, released, held,
        fromPropertyId: agent.PROPERTY_ID,
      };
    });
    if (result.error) return result;

    // The source property now has no printer at all, so whatever it still has
    // queued or held (including the claims just requeued above) cannot print
    // until a printer is added there — the exact "job 27 sat queued for five
    // days" failure createJob's noAgent flag exists for, but discovered here
    // instead of at queue time. Counted OUTSIDE the transaction: this printer
    // row has already moved, so nothing about this read needs the lock the
    // move held, and the caller gets a true post-move count.
    const leftBehindRows = await _db.query(
      `SELECT COUNT(*) AS cnt FROM TALLY.print_jobs
        WHERE PROPERTY_ID = ? AND STATUS IN ('queued', 'held')`,
      [result.fromPropertyId]
    );
    const leftBehind = leftBehindRows[0].cnt;

    // Logged after commit, not inside the transaction: a rollback must never
    // produce a log line claiming a move that didn't happen.
    _logger?.info?.('printer moved', {
      agentId, fromPropertyId: result.fromPropertyId, toPropertyId, userId,
      requeued: result.requeued, released: result.released, held: result.held, leftBehind,
    });

    return { ...result, leftBehind };
  },
};

module.exports = PrintService;

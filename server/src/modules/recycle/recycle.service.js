/**
 * The recycle bin.
 *
 * Every soft-delete opens a BATCH and stamps the rows it actually touched, so a
 * restore can say precisely what it is undoing. This matters because the
 * cascades guard with `WHERE DELETED_AT IS NULL` — they only stamp rows that
 * were live at that moment — which means a deleted subtree is a mix of rows
 * from different operations. Restoring bin A must not resurrect child bin B
 * that was deleted separately a month earlier, and DELETED_AT alone cannot tell
 * them apart.
 *
 * A batch is the unit the user sees ("you deleted the Garage") and the unit
 * they act on. Members carry DELETE_BATCH_ID; the header carries what was
 * pointed at. Restore clears the members' batch id back to NULL and drops the
 * header, so nothing can be restored twice.
 */

let _db;
let _logger;
let AuditService;
let ItemsService;

// Retention. The list hides a batch once it is this old, restore refuses it,
// and the sweep hard-deletes it. One number, three places, or they disagree.
const RETENTION_DAYS = 30;

// The sweep is lazy (see sweepIfDue): no cron, no scheduler, so it rides the
// bin's own read path and rate-limits itself per process.
const SWEEP_EVERY_MS = 10 * 60 * 1000;
const SWEEP_BATCH_LIMIT = 25;
const SWEEP_ORPHAN_LIMIT = 200;

const RecycleService = {
  init({ db, logger }) {
    _db = db;
    _logger = logger;
    AuditService = require('../audit/audit.service');
    // Required here, not at the top: items.service requires THIS module at
    // load, so a top-level require back would hand one side an empty export.
    ItemsService = require('../inventory/items.service');
    return RecycleService;
  },

  _lastSweepAt: 0,
  _sweeping: null,

  /**
   * Open a batch and return its id. Must run inside the same transaction as the
   * deletes it describes, or a failed delete would leave an empty header behind.
   */
  async openBatch(tx, { propertyId, rootType, rootId, rootName, userId }) {
    const res = await tx.query(
      `INSERT INTO TALLY.delete_batches
         (PROPERTY_ID, ROOT_TYPE, ROOT_ID, ROOT_NAME, DELETED_BY, DELETED_AT)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [propertyId, rootType, rootId, String(rootName || '').slice(0, 255), userId || null]
    );
    return res.insertId;
  },

  /**
   * What is in the bin, one row per delete operation rather than one row per
   * swept-up item. Deleting an area used to mean 340 individual item rows; it
   * is one row that says "Garage · 4 bins, 340 items".
   *
   * Scoped by membership like every other read. The window matches restore
   * and the sweep so the three agree about what is recoverable.
   *
   * Any member may LOOK; only an owner may restore (#347), and the row says
   * which so the client can hide a button that would only ever 403.
   */
  async list(userId, { limit = 100, offset = 0 } = {}) {
    const rows = await _db.query(
      `SELECT
         b.ID, b.ROOT_TYPE, b.ROOT_ID, b.ROOT_NAME, b.DELETED_AT,
         pm.ROLE,
         p.NAME AS PROPERTY_NAME,
         u.DISPLAY_NAME AS DELETED_BY_NAME,
         DATEDIFF(DATE_ADD(b.DELETED_AT, INTERVAL ${RETENTION_DAYS} DAY), NOW()) AS DAYS_LEFT,
         (SELECT COUNT(*) FROM TALLY.areas      x WHERE x.DELETE_BATCH_ID = b.ID) AS AREA_COUNT,
         (SELECT COUNT(*) FROM TALLY.containers x WHERE x.DELETE_BATCH_ID = b.ID) AS CONTAINER_COUNT,
         (SELECT COUNT(*) FROM TALLY.items      x WHERE x.DELETE_BATCH_ID = b.ID) AS ITEM_COUNT
       FROM TALLY.delete_batches b
       JOIN TALLY.properties p ON b.PROPERTY_ID = p.ID
       JOIN TALLY.property_members pm ON b.PROPERTY_ID = pm.PROPERTY_ID
       LEFT JOIN TALLY.users u ON b.DELETED_BY = u.ID
       WHERE pm.USER_ID = ?
         AND b.DELETED_AT > DATE_SUB(NOW(), INTERVAL ${RETENTION_DAYS} DAY)
       ORDER BY b.DELETED_AT DESC
       LIMIT ? OFFSET ?`,
      [userId, limit, offset]
    );
    return rows.map((r) => ({
      id: r.ID,
      rootType: r.ROOT_TYPE,
      rootId: r.ROOT_ID,
      rootName: r.ROOT_NAME,
      propertyName: r.PROPERTY_NAME || null,
      deletedAt: r.DELETED_AT,
      deletedByName: r.DELETED_BY_NAME || null,
      daysLeft: r.DAYS_LEFT != null ? Number(r.DAYS_LEFT) : 0,
      areaCount: Number(r.AREA_COUNT) || 0,
      containerCount: Number(r.CONTAINER_COUNT) || 0,
      itemCount: Number(r.ITEM_COUNT) || 0,
      canRestore: r.ROLE === 'owner',
    }));
  },

  /**
   * Put a batch back.
   *
   * Refuses when the place it would return to is itself deleted — restoring a
   * bin into a recycled area would recreate the exact phantom state this whole
   * feature exists to remove. The user is told which ancestor to restore first,
   * and unlike before, that instruction is now actionable.
   *
   * Owner-only (#347), like every other delete/restore route in the app. The
   * role cannot be a route middleware here — there is no :propertyId in the
   * path for resolvePropertyRole to read; the batch is what names the
   * property — so it rides the same locked read that finds the batch.
   *
   * Same retention window as the list: a batch the bin no longer shows is not
   * quietly restorable by id, because the sweep may already be deleting it.
   */
  async restore(batchId, userId) {
    return _db.withTransaction(async (tx) => {
      const batchRows = await tx.query(
        `SELECT b.ID, b.PROPERTY_ID, b.ROOT_TYPE, b.ROOT_ID, b.ROOT_NAME, pm.ROLE
           FROM TALLY.delete_batches b
           JOIN TALLY.property_members pm ON b.PROPERTY_ID = pm.PROPERTY_ID
          WHERE b.ID = ? AND pm.USER_ID = ?
            AND b.DELETED_AT > DATE_SUB(NOW(), INTERVAL ${RETENTION_DAYS} DAY)
          FOR UPDATE`,
        [batchId, userId]
      );
      // 404 rather than 403 — a batch in someone else's property must not be
      // distinguishable from one that never existed (nor from one that has
      // aged out).
      if (!batchRows.length) {
        const err = new Error('That deletion is not in your recycle bin');
        err.statusCode = 404;
        throw err;
      }
      const batch = batchRows[0];
      // A member, so the batch may be named — but only an owner may act.
      if (batch.ROLE !== 'owner') {
        const err = new Error('Only an owner can restore from the recycle bin');
        err.statusCode = 403;
        throw err;
      }

      await RecycleService._assertAncestorsLive(tx, batch);

      // Order matters: ancestors first, so no row is ever briefly live under a
      // still-deleted parent.
      await tx.query(
        'UPDATE TALLY.areas SET DELETED_AT = NULL, DELETE_BATCH_ID = NULL WHERE DELETE_BATCH_ID = ?',
        [batchId]
      );
      await tx.query(
        'UPDATE TALLY.containers SET DELETED_AT = NULL, DELETE_BATCH_ID = NULL WHERE DELETE_BATCH_ID = ?',
        [batchId]
      );
      // STATUS goes back to 'active', never 'lent': the cascades close open
      // loans on the way down, so there is no loan left to be lent against.
      await tx.query(
        "UPDATE TALLY.items SET DELETED_AT = NULL, STATUS = 'active', DELETE_BATCH_ID = NULL WHERE DELETE_BATCH_ID = ?",
        [batchId]
      );

      // The header has no members left, so it is no longer a bin entry.
      await tx.query('DELETE FROM TALLY.delete_batches WHERE ID = ?', [batchId]);

      AuditService.logChange(userId, batch.ROOT_TYPE, batch.ROOT_ID, 'restored', {}, batch.PROPERTY_ID);
      return { rootType: batch.ROOT_TYPE, rootId: batch.ROOT_ID, rootName: batch.ROOT_NAME };
    });
  },

  /**
   * Enforce retention without a scheduler. Called from the bin's list route,
   * fire-and-forget: the list already hides expired rows, so the caller sees
   * the same page whether the sweep has run yet or not. Runs at most once per
   * SWEEP_EVERY_MS per process, and never rejects into the request — a purge
   * failure is logged, and the next due sweep simply tries again.
   *
   * Same shape as print's sweepStaleClaims and matches' sweepStale: lazy,
   * on a read path, bounded. Deliberately GLOBAL rather than scoped to the
   * caller, unlike those two — retention is a property of the data, not of
   * whoever happens to open the bin, and a property whose owner never looks
   * would otherwise keep its deletions forever.
   */
  sweepIfDue(now = Date.now()) {
    if (RecycleService._sweeping || now - RecycleService._lastSweepAt < SWEEP_EVERY_MS) return null;
    RecycleService._lastSweepAt = now;
    RecycleService._sweeping = RecycleService.purgeExpired()
      .then((r) => {
        if (r.items || r.batches) _logger.info('Recycle bin swept', r);
      })
      .catch((err) => _logger.error('Recycle bin sweep failed', { error: err.message }))
      .finally(() => { RecycleService._sweeping = null; });
    return RecycleService._sweeping;
  },

  /**
   * Permanently delete what has aged out of the bin. Two populations:
   *
   * 1. Items with no batch — rows soft-deleted before 004_delete_batches
   *    stamped anything. The bin never lists them, so nothing but this
   *    would ever remove them.
   * 2. Whole batches, oldest first, a bounded number per sweep. Items go
   *    through ItemsService.permanentDelete — the one path that knows every
   *    child table and cleans object storage — and then the batch's
   *    containers and areas come out in FK order in a single transaction.
   *
   * Open loans are skipped, same as the old items-only purge: the cascades
   * close loans on the way down so a batch should never contain one, but a
   * pre-batch row still can, and a purge must not destroy a live loan record.
   *
   * Oldest-first matters for the FK graph. A bin deleted on its own (batch B)
   * and later its area (batch A) leaves B's container pointing at A's area —
   * purging B first makes A's area row deletable. Where the order is still
   * wrong (B skipped for a loan, say), the FK refuses, the batch's transaction
   * rolls back, it is logged, and the next sweep retries. Wrong order cannot
   * produce a wrong outcome, only a delayed one.
   */
  async purgeExpired() {
    const counts = { items: 0, batches: 0 };

    const orphans = await _db.query(
      `SELECT i.ID FROM TALLY.items i
        WHERE i.DELETED_AT IS NOT NULL
          AND i.DELETED_AT < DATE_SUB(NOW(), INTERVAL ${RETENTION_DAYS} DAY)
          AND i.DELETE_BATCH_ID IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM TALLY.item_lending il
            WHERE il.ITEM_ID = i.ID AND il.RETURNED_AT IS NULL
          )
        LIMIT ?`,
      [SWEEP_ORPHAN_LIMIT]
    );
    for (const row of orphans) {
      await ItemsService.permanentDelete(row.ID);
      counts.items += 1;
    }

    const batches = await _db.query(
      `SELECT ID, PROPERTY_ID, ROOT_TYPE, ROOT_ID, ROOT_NAME
         FROM TALLY.delete_batches
        WHERE DELETED_AT < DATE_SUB(NOW(), INTERVAL ${RETENTION_DAYS} DAY)
        ORDER BY DELETED_AT ASC LIMIT ?`,
      [SWEEP_BATCH_LIMIT]
    );
    for (const batch of batches) {
      try {
        if (await RecycleService._purgeBatch(batch)) counts.batches += 1;
      } catch (err) {
        // One stuck batch must not stop the rest; it is retried next sweep.
        _logger.warn('Recycle purge: batch left for next sweep', {
          batchId: batch.ID, rootType: batch.ROOT_TYPE, rootId: batch.ROOT_ID, error: err.message,
        });
      }
    }
    return counts;
  },

  async _purgeBatch(batch) {
    const items = await _db.query(
      `SELECT i.ID,
              EXISTS (SELECT 1 FROM TALLY.item_lending il
                       WHERE il.ITEM_ID = i.ID AND il.RETURNED_AT IS NULL) AS ON_LOAN
         FROM TALLY.items i WHERE i.DELETE_BATCH_ID = ?`,
      [batch.ID]
    );
    if (items.some((r) => Number(r.ON_LOAN))) {
      _logger.warn('Recycle purge: batch skipped, an item in it is still on loan', {
        batchId: batch.ID, rootType: batch.ROOT_TYPE, rootId: batch.ROOT_ID,
      });
      return false;
    }
    // Each item is its own transaction plus object-storage cleanup; if the
    // container/area transaction below then fails, the batch simply has
    // fewer items next time — every step here is idempotent.
    for (const row of items) await ItemsService.permanentDelete(row.ID);

    await _db.withTransaction(async (tx) => {
      const containerIds = (await tx.query(
        'SELECT ID FROM TALLY.containers WHERE DELETE_BATCH_ID = ?', [batch.ID]
      )).map((r) => r.ID);
      const areaIds = (await tx.query(
        'SELECT ID FROM TALLY.areas WHERE DELETE_BATCH_ID = ?', [batch.ID]
      )).map((r) => r.ID);

      if (containerIds.length) {
        const ph = containerIds.map(() => '?').join(',');
        // entity_tags and share_links are polymorphic (no FK), so nothing
        // would stop them dangling — remove them by hand.
        await tx.query(
          `DELETE FROM TALLY.entity_tags WHERE ENTITY_TYPE = 'container' AND ENTITY_ID IN (${ph})`, containerIds
        );
        await tx.query(
          `DELETE FROM TALLY.share_links WHERE ENTITY_TYPE = 'container' AND ENTITY_ID IN (${ph})`, containerIds
        );
        // The closure table references containers from both columns.
        await tx.query(
          `DELETE FROM TALLY.container_paths WHERE ANCESTOR_ID IN (${ph}) OR DESCENDANT_ID IN (${ph})`,
          [...containerIds, ...containerIds]
        );
        // Self-FK: a nested bin in this batch points at its parent in this
        // batch. Nulling first means the DELETE needs no particular order.
        await tx.query(
          'UPDATE TALLY.containers SET PARENT_CONTAINER_ID = NULL WHERE DELETE_BATCH_ID = ?', [batch.ID]
        );
        await tx.query('DELETE FROM TALLY.containers WHERE DELETE_BATCH_ID = ?', [batch.ID]);
      }

      if (areaIds.length) {
        const ph = areaIds.map(() => '?').join(',');
        await tx.query(
          `DELETE FROM TALLY.entity_tags WHERE ENTITY_TYPE = 'area' AND ENTITY_ID IN (${ph})`, areaIds
        );
        await tx.query(
          `DELETE FROM TALLY.share_links WHERE ENTITY_TYPE = 'area' AND ENTITY_ID IN (${ph})`, areaIds
        );
        await tx.query('DELETE FROM TALLY.areas WHERE DELETE_BATCH_ID = ?', [batch.ID]);
      }

      await tx.query('DELETE FROM TALLY.delete_batches WHERE ID = ?', [batch.ID]);
    });
    // No change_log row: USER_ID is NOT NULL there and this is nobody's
    // action. The soft-delete was audited when it happened; the sweep is
    // retention, and the logger carries it.
    return true;
  },

  /**
   * A batch may only come back if everything above its root is live. Checked
   * inside the restore transaction against the real rows, not inferred — and
   * LOCKED (#88): these SELECTs are what the restore trusts, and without
   * FOR UPDATE a concurrent soft-delete of an ancestor could commit between
   * this read and the un-delete UPDATEs in restore(), bringing rows back
   * under a freshly deleted parent — the exact phantom state the bin exists
   * to remove. Each query reads its ancestor rows by PK join, so the locks
   * are point locks on exactly the rows being trusted, never a range; every
   * delete cascade stamps those same rows, so the two operations serialize —
   * whichever commits first, the other sees it.
   *
   * LOCK ORDER (#87): the joins below lock their rows in whatever order the
   * optimizer walks the join, so two concurrent restores with different root
   * types could acquire the same property/area/container rows in OPPOSITE
   * orders (area-root grabs the property row first; container/item-roots
   * reached it last, through the join) — a deadlock, which withTransaction
   * deliberately does not retry. Every root type therefore takes the SAME
   * first lock: a point lock on the property row. Restores within a property
   * serialize right there, before any multi-row join runs, so the joins'
   * internal order can no longer invert against another restore — and the
   * container-move path's ordered locks never take property rows at all, so
   * no cycle forms against moves either.
   */
  async _assertAncestorsLive(tx, batch) {
    const refuse = (message) => {
      const err = new Error(message);
      err.statusCode = 409;
      throw err;
    };

    // The serializing lock — always first, for every root type. The batch
    // header already names the property, so no discovery read is needed
    // before it. A soft-deleted property refuses every root type here.
    const propRows = await tx.query(
      'SELECT DELETED_AT FROM TALLY.properties WHERE ID = ? FOR UPDATE',
      [batch.PROPERTY_ID]
    );
    if (propRows.length && propRows[0].DELETED_AT) refuse('Restore the property first');

    if (batch.ROOT_TYPE === 'area') {
      if (!propRows.length) refuse('The property this belonged to no longer exists');
      return;
    }

    if (batch.ROOT_TYPE === 'container') {
      const rows = await tx.query(
        `SELECT c.PARENT_CONTAINER_ID, a.DELETED_AT AS AREA_DELETED, p.DELETED_AT AS PROP_DELETED,
                parent.DELETED_AT AS PARENT_DELETED
           FROM TALLY.containers c
           JOIN TALLY.areas a ON c.AREA_ID = a.ID
           JOIN TALLY.properties p ON a.PROPERTY_ID = p.ID
           LEFT JOIN TALLY.containers parent ON c.PARENT_CONTAINER_ID = parent.ID
          WHERE c.ID = ?
          FOR UPDATE`,
        [batch.ROOT_ID]
      );
      if (!rows.length) refuse('That container no longer exists');
      const r = rows[0];
      if (r.PROP_DELETED) refuse('Restore the property first');
      if (r.AREA_DELETED) refuse('Restore the area this was in first');
      // A nested bin whose parent is still in the bin has nowhere to hang.
      if (r.PARENT_CONTAINER_ID && r.PARENT_DELETED) refuse('Restore the bin this was inside first');
      return;
    }

    // item
    const rows = await tx.query(
      `SELECT c.DELETED_AT AS CONTAINER_DELETED, a.DELETED_AT AS AREA_DELETED, p.DELETED_AT AS PROP_DELETED
         FROM TALLY.items i
         JOIN TALLY.containers c ON i.CONTAINER_ID = c.ID
         JOIN TALLY.areas a ON c.AREA_ID = a.ID
         JOIN TALLY.properties p ON a.PROPERTY_ID = p.ID
        WHERE i.ID = ?
        FOR UPDATE`,
      [batch.ROOT_ID]
    );
    if (!rows.length) refuse('That item no longer exists');
    const r = rows[0];
    if (r.PROP_DELETED) refuse('Restore the property first');
    if (r.AREA_DELETED) refuse('Restore the area this was in first');
    if (r.CONTAINER_DELETED) refuse('Restore the bin this was in first');
  },
};

module.exports = RecycleService;

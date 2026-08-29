const { generateCode } = require('../../utils/qr');
const ClosureTableService = require('./closure-table.service');
const AuditService = require('../audit/audit.service');
const RecycleService = require('../recycle/recycle.service');

// #252's freeze argument requires the advisory subtree read and the in-tx
// authoritative re-read to evaluate the SAME predicate — one constant so
// they cannot drift apart silently (a clause appended to one but not the
// other would quietly unfreeze the lemma).
const SUBTREE_IDS_SQL =
  'SELECT DESCENDANT_ID FROM TALLY.container_paths WHERE ANCESTOR_ID = ? AND DEPTH > 0';

const Reconcile = require('./move-reconcile.service');

let _db = null;
let _logger = null;
let _closureTable = null;

const ContainersService = {
  // ── Initialization ─────────────────────────────────────────────────────────

  init({ db, logger }) {
    // Init here rather than relying on recycle.routes running first — a delete
    // must be able to open a batch regardless of module registration order.
    RecycleService.init({ db, logger });
    _db = db;
    _logger = logger;
    _closureTable = new ClosureTableService(db);
  },

  // ── Helpers ────────────────────────────────────────────────────────────────

  _mapContainer(row) {
    return {
      id: row.ID,
      areaId: row.AREA_ID,
      parentContainerId: row.PARENT_CONTAINER_ID || null,
      name: row.NAME,
      type: row.TYPE || null,
      description: row.DESCRIPTION || null,
      qrCode: row.QR_CODE || null,
      createdAt: row.CREATED_AT,
      updatedAt: row.UPDATED_AT,
      deletedAt: row.DELETED_AT || null,
      containerCount: row.CONTAINER_COUNT != null ? Number(row.CONTAINER_COUNT) : undefined,
      itemCount: row.ITEM_COUNT != null ? Number(row.ITEM_COUNT) : undefined,
      // Breadcrumb info (getById)
      areaName: row.AREA_NAME !== undefined ? (row.AREA_NAME || null) : undefined,
      propertyId: row.PROPERTY_ID !== undefined ? (row.PROPERTY_ID || null) : undefined,
      propertyName: row.PROPERTY_NAME !== undefined ? (row.PROPERTY_NAME || null) : undefined,
    };
  },

  _mapItem(row) {
    return {
      id: row.ID,
      containerId: row.CONTAINER_ID,
      name: row.NAME,
      description: row.DESCRIPTION || null,
      quantity: row.QUANTITY != null ? Number(row.QUANTITY) : 1,
      qrCode: row.QR_CODE || null,
      createdAt: row.CREATED_AT,
      updatedAt: row.UPDATED_AT,
      deletedAt: row.DELETED_AT || null,
    };
  },

  // ── Queries ────────────────────────────────────────────────────────────────

  async getByArea(areaId) {
    const rows = await _db.query(
      `SELECT
         c.*,
         (SELECT COUNT(*) FROM TALLY.containers ch WHERE ch.PARENT_CONTAINER_ID = c.ID AND ch.DELETED_AT IS NULL) AS CONTAINER_COUNT,
         (SELECT COUNT(*) FROM TALLY.items i WHERE i.CONTAINER_ID = c.ID AND i.DELETED_AT IS NULL) AS ITEM_COUNT
       FROM TALLY.containers c
       WHERE c.AREA_ID = ? AND c.PARENT_CONTAINER_ID IS NULL AND c.DELETED_AT IS NULL`,
      [areaId]
    );
    return rows.map(ContainersService._mapContainer);
  },

  /**
   * Every container in a property, at every depth, in one query.
   *
   * The nested view needs the whole shape at once. Walking it level by level
   * would be one request per node — fine for a demo, unusable for a garage with
   * forty bins, and the kind of thing that only shows up on real data.
   *
   * Scoped by USER_ID here rather than relying on the route's role middleware.
   * The middleware is present and correct, but this returns a whole property's
   * structure in one payload, so it is worth the join being visible in the
   * query that produces it.
   *
   * Returns a FLAT list; the caller assembles the tree from AREA_ID and
   * PARENT_CONTAINER_ID. Building it here would mean sorting a recursive
   * structure through the API layer for no gain.
   */
  async getPropertyTree(propertyId, userId) {
    const rows = await _db.query(
      `SELECT
         c.*,
         (SELECT COUNT(*) FROM TALLY.containers ch
           WHERE ch.PARENT_CONTAINER_ID = c.ID AND ch.DELETED_AT IS NULL) AS CONTAINER_COUNT,
         (SELECT COUNT(*) FROM TALLY.items i
           WHERE i.CONTAINER_ID = c.ID AND i.DELETED_AT IS NULL) AS ITEM_COUNT
       FROM TALLY.containers c
       JOIN TALLY.areas a ON c.AREA_ID = a.ID AND a.DELETED_AT IS NULL
       JOIN TALLY.property_members pm ON a.PROPERTY_ID = pm.PROPERTY_ID
       WHERE a.PROPERTY_ID = ? AND pm.USER_ID = ? AND c.DELETED_AT IS NULL
       ORDER BY c.NAME`,
      [propertyId, userId]
    );
    return rows.map(ContainersService._mapContainer);
  },

  async getByParent(parentContainerId) {
    const rows = await _db.query(
      `SELECT
         c.*,
         (SELECT COUNT(*) FROM TALLY.containers ch WHERE ch.PARENT_CONTAINER_ID = c.ID AND ch.DELETED_AT IS NULL) AS CONTAINER_COUNT,
         (SELECT COUNT(*) FROM TALLY.items i WHERE i.CONTAINER_ID = c.ID AND i.DELETED_AT IS NULL) AS ITEM_COUNT
       FROM TALLY.containers c
       WHERE c.PARENT_CONTAINER_ID = ? AND c.DELETED_AT IS NULL`,
      [parentContainerId]
    );
    return rows.map(ContainersService._mapContainer);
  },

  async getById(id) {
    const rows = await _db.query(
      `SELECT
         c.*,
         a.NAME AS AREA_NAME,
         a.PROPERTY_ID AS PROPERTY_ID,
         p.NAME AS PROPERTY_NAME,
         (SELECT COUNT(*) FROM TALLY.containers ch WHERE ch.PARENT_CONTAINER_ID = c.ID AND ch.DELETED_AT IS NULL) AS CONTAINER_COUNT,
         (SELECT COUNT(*) FROM TALLY.items i WHERE i.CONTAINER_ID = c.ID AND i.DELETED_AT IS NULL) AS ITEM_COUNT
       FROM TALLY.containers c
       JOIN TALLY.areas a ON c.AREA_ID = a.ID
       JOIN TALLY.properties p ON a.PROPERTY_ID = p.ID
       WHERE c.ID = ?`,
      [id]
    );
    if (!rows.length) return null;

    const container = ContainersService._mapContainer(rows[0]);

    // Build breadcrumb path via closure table ancestors
    const ancestors = await _closureTable.getAncestors(id);
    if (ancestors.length > 0) {
      const ancestorIds = ancestors.map(a => a.ANCESTOR_ID);
      const ancestorRows = await _db.query(
        `SELECT ID, NAME FROM TALLY.containers WHERE ID IN (${ancestorIds.map(() => '?').join(',')})`,
        ancestorIds
      );
      const nameMap = {};
      for (const r of ancestorRows) {
        nameMap[r.ID] = r.NAME;
      }
      // ancestors are ordered by DEPTH DESC (farthest first), so breadcrumb reads top-down
      container.breadcrumb = ancestors.map(a => ({
        id: a.ANCESTOR_ID,
        name: nameMap[a.ANCESTOR_ID] || null,
      }));
    } else {
      container.breadcrumb = [];
    }

    return container;
  },

  async getAllDescendantItems(containerId) {
    const rows = await _db.query(
      `SELECT i.*
       FROM TALLY.items i
       JOIN TALLY.container_paths cp ON i.CONTAINER_ID = cp.DESCENDANT_ID
       WHERE cp.ANCESTOR_ID = ? AND i.DELETED_AT IS NULL`,
      [containerId]
    );
    return rows.map(ContainersService._mapItem);
  },

  async create(data, userId) {
    // Insert the container row and its closure self/ancestor paths atomically:
    // a half-created container (row but no closure path) corrupts every tree read.
    const insertContainer = (qrCode) =>
      _db.withTransaction(async (tx) => {
        if (data.parentContainerId) {
          // Lock the parent row this write is about to trust (#251) — the
          // same check-then-write TOCTOU #88 closed for item create/move,
          // same SQL shape as items.service's _lockLiveContainer, plus the
          // AREA_ID it returns for the same-area rule. This is the tx's
          // first statement, FOR UPDATE OF c: a point lock on the parent's
          // PK, which every path that could invalidate the check stamps —
          // the delete cascades UPDATE this row, and a concurrent move of
          // the parent to another area holds it in its statement-0 lock set
          // — so whichever commits first, the other sees it. An unlocked
          // pre-tx check left a window where the parent was recycled (or
          // moved out of the area) between check and INSERT: an active
          // child under a hidden or cross-area parent, invisible in
          // navigation yet still counted in reports/search.
          const parentRows = await tx.query(
            `SELECT c.AREA_ID FROM TALLY.containers c
             JOIN TALLY.areas a ON c.AREA_ID = a.ID
             WHERE c.ID = ? AND c.DELETED_AT IS NULL AND a.DELETED_AT IS NULL
             FOR UPDATE OF c`,
            [data.parentContainerId]
          );
          if (!parentRows.length) {
            const err = new Error('Parent container not found');
            err.statusCode = 404;
            throw err;
          }
          if (String(parentRows[0].AREA_ID) !== String(data.areaId)) {
            const err = new Error('Parent container must be in the same area');
            err.statusCode = 400;
            throw err;
          }
        }
        const result = await tx.query(
          `INSERT INTO TALLY.containers (AREA_ID, PARENT_CONTAINER_ID, NAME, TYPE, DESCRIPTION, QR_CODE)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [data.areaId, data.parentContainerId || null, data.name, data.type, data.description || null, qrCode]
        );
        await _closureTable.addNode(result.insertId, data.parentContainerId || null, tx);
        return result.insertId;
      });

    let insertId;
    try {
      insertId = await insertContainer(generateCode('container'));
    } catch (err) {
      // Duplicate QR code — retry once with a new code (fresh transaction)
      if (err.code === 'ER_DUP_ENTRY' && err.message.includes('qr_code')) {
        insertId = await insertContainer(generateCode('container'));
      } else {
        throw err;
      }
    }

    const propertyId = await ContainersService.getPropertyIdForContainer(insertId);
    AuditService.logChange(userId, 'container', insertId, 'created', data, propertyId);
    return ContainersService.getById(insertId);
  },

  async update(id, data, userId) {
    const fields = [];
    const values = [];

    if (data.name !== undefined) { fields.push('NAME = ?'); values.push(data.name); }
    if (data.type !== undefined) { fields.push('TYPE = ?'); values.push(data.type); }
    if (data.description !== undefined) { fields.push('DESCRIPTION = ?'); values.push(data.description); }

    if (!fields.length) return ContainersService.getById(id);

    values.push(id);
    await _db.query(
      `UPDATE TALLY.containers SET ${fields.join(', ')} WHERE ID = ?`,
      values
    );

    const propertyId = await ContainersService.getPropertyIdForContainer(id);
    AuditService.logChange(userId, 'container', id, 'updated', data, propertyId);

    return ContainersService.getById(id);
  },

  async move(id, newParentContainerId, newAreaId, userId, opts = {}) {
    // A container can never be moved into itself — cheap to reject up front.
    if (newParentContainerId && Number(newParentContainerId) === Number(id)) {
      const err = new Error('A container cannot be moved into itself');
      err.statusCode = 400;
      throw err;
    }

    // Cross-property: the move and its reconciliation commit or roll back
    // together — a moved subtree with stranded tag/accessory rows would be
    // worse than a refused move. `consequences` is a plain closure variable
    // (matching items.service.js's move()) rather than a property stapled
    // onto the caller's opts object — mutating the caller's own argument is a
    // trap for whoever calls this next.
    let consequences = null;
    const moveArgs = opts.crossProperty && {
      srcPropertyId: opts.crossProperty.srcPropertyId,
      destPropertyId: opts.crossProperty.destPropertyId,
      userId,
      rootType: 'container',
      rootId: Number(id),
      moveChanges: { parentContainerId: newParentContainerId, areaId: newAreaId },
    };

    // Everything that decides the move must happen INSIDE the transaction under
    // row locks. Two generations of this bug:
    //   • The cycle check was once a check-then-act OUTSIDE the tx: two
    //     concurrent mutual moves (A→under B while B→under A) could each pass
    //     a stale "is the other my descendant?" check and both commit a
    //     2-cycle in container_paths that corrupts every tree read.
    //   • Locking just the mover and the destination fixed pairs but not
    //     rings (#87): with A→B→C→D→A, moves 1+3 can commit first, after
    //     which moves 2+4 hold DISJOINT lock pairs — neither waits, each
    //     re-check passes against a state with no cycle yet, and together
    //     they commit the 4-cycle.
    // So the lock set is the mover, the destination, and every CURRENT
    // ancestor of the destination — one ascending-ID FOR UPDATE statement,
    // the same globally consistent order every multi-container lock in this
    // codebase uses, so no two moves can acquire these rows in conflicting
    // orders. Any concurrent move that could change the destination's
    // ancestry has its own mover somewhere in that chain, so it must wait on
    // our locks; the chain is re-read AFTER the locks are held, and if it
    // shifted between the advisory read and the locks we refuse (409) rather
    // than trust a stale chain. The cycle check then reads the same
    // post-lock snapshot: the last member of a ring to get its locks always
    // sees the rest of the ring committed and refuses.
    //
    // The advisory ancestor read runs on the pool, pre-tx, ON PURPOSE:
    // inside the tx a plain SELECT would pin the InnoDB read view BEFORE the
    // lock waits, and every later plain read (the re-check and the cycle
    // check included) would see a snapshot older than the commits we just
    // waited on.
    const expectedAncestors = newParentContainerId
      ? (await _closureTable.getAncestors(newParentContainerId)).map((r) => Number(r.ANCESTOR_ID))
      : [];

    // The mover's whole SUBTREE joins the lock set (#252). moveNode's Step-3
    // DELETE replays ancestors(mover) × subtree(mover) IN-lists materialized
    // by its Step-1/2 reads, and every row a move's rewrite touches has its
    // DESCENDANT in that mover's subtree. Two moves with overlapping subtrees
    // (one mover an ancestor of the other — A→B while W∈subtree(A)→S) used to
    // hold DISJOINT lock sets, run fully concurrently, and whichever Step-3
    // landed second deleted closure rows the partner had just inserted (the
    // fresh R→W edge): a lost ancestry edge, silent — no cycle, no error.
    // With the subtree locked, two rewrites that could touch the same closure
    // row share a subtree member, i.e. a container row in BOTH lock sets, so
    // they serialize. Advisory here (pool, pre-tx) exactly like the ancestor
    // chain above; re-verified post-lock below. Not net-new locking for most
    // moves: the AREA_ID cascade at the end of this tx already X-locks every
    // subtree row — this acquires them up front, in the one global order.
    // Same SQL text as the in-tx re-read on purpose: same predicate, same
    // rows — only the connection (pool vs tx) separates advisory from
    // authoritative.
    const expectedSubtree = (await _db.query(
      SUBTREE_IDS_SQL,
      [id]
    )).map((r) => Number(r.DESCENDANT_ID));

    await _db.withTransaction(async (tx) => {
      const lockIds = [...new Set([
        Number(id),
        ...expectedSubtree,
        ...(newParentContainerId ? [Number(newParentContainerId), ...expectedAncestors] : []),
      ])].sort((a, b) => a - b);
      await tx.query(
        `SELECT ID FROM TALLY.containers WHERE ID IN (${lockIds.map(() => '?').join(', ')}) FOR UPDATE`,
        lockIds
      );

      // Root move into a specific area (#256): lock the destination AREA row
      // right here — the statement immediately after the container lock
      // above, before anything else in this transaction runs. Areas are a
      // DIFFERENT id space from the container family's ascending lock set,
      // so this can't be folded into that IN-list (there is no parent
      // container row to join it through — that's exactly the case the
      // b6-t1 "the cascade takes locks on container rows" reasoning below
      // doesn't cover: a root move plants the mover directly in the area,
      // with no locked container row standing in for it). It has to be its
      // own point lock, and it has to land in ONE fixed position every root
      // move takes it, for the same reason #87 fixed the ancestor lock's
      // position: so no concurrent operation can ever observe these two
      // locks acquired in the opposite order and deadlock against it.
      //
      // The only OTHER operation that ever locks this exact area row is
      // AreasService.cascadeDelete, and its own internal order is
      // CONTAINERS-then-AREA: it soft-deletes every container CURRENTLY in
      // the area (a mass "WHERE AREA_ID = ?" UPDATE, which X-locks each of
      // those rows) before it finally updates — and locks — the area row
      // itself, last. A root mover and its subtree are, by definition, NOT
      // YET in the destination area at any point before this transaction
      // commits, so that cascade's container UPDATE can never match (and so
      // can never contend for) the rows our statement-0 lock above just
      // took. The area row is the ONLY resource the two operations actually
      // share. Taking it here — after our own container lock, before we
      // trust anything about the area — means whichever transaction reaches
      // that one shared row first simply makes the other wait behind it;
      // neither ever holds a row the other one needs, so there is no cycle
      // to deadlock on, in either direction. (This is the same standing
      // family rule recycle.service.js's restore follows for its property
      // lock: an area/property-family lock is always taken in one fixed,
      // predictable position relative to the container-family lock, never
      // left to fall wherever a later branch happens to run it — see
      // _assertAncestorsLive's lock-order comment.)
      //
      // Unlike the ancestor/subtree locks above, there is no separate
      // pre-tx advisory read to drift-check against here: this single
      // locked read IS the authoritative check, so a dead area is a
      // straightforward 404 (matching every other "the thing you're
      // attaching to doesn't exist" case in this family), not a 409 — there
      // is no earlier answer for it to have drifted away from.
      if (!newParentContainerId && newAreaId !== undefined) {
        const areaLockRows = await tx.query(
          'SELECT ID FROM TALLY.areas WHERE ID = ? AND DELETED_AT IS NULL FOR UPDATE',
          [newAreaId]
        );
        if (!areaLockRows.length) {
          const err = new Error('Destination area not found');
          err.statusCode = 404;
          throw err;
        }
      }

      // Post-lock (#252): the subtree must be exactly the rows we locked.
      // Runs for EVERY move — root moves rewrite the closure too. This (or
      // the chain re-read below) is the tx's first plain read, so the read
      // view starts after the lock waits and sees every commit they let
      // through. Drift means a concurrent move re-shaped the subtree between
      // the advisory read and our lock grant — the rows we hold are the wrong
      // mutex and moveNode's lists would replay a stale membership — so
      // refuse and let the retry lock the settled tree. Once verified, the
      // subtree is FROZEN until we commit: a member can only leave as some
      // move's mover (a row we hold), only join as some move's destination
      // (a row we hold), and the mover's own ancestor chain can only change
      // via a move whose locked subtree contains our mover (a row we hold) —
      // so the lists moveNode derives under these locks stay true through
      // its Step-3 DELETE.
      const subtreeNow = await tx.query(
        SUBTREE_IDS_SQL,
        [id]
      );
      const subtreeIds = new Set(subtreeNow.map((r) => Number(r.DESCENDANT_ID)));
      const subtreeDrifted =
        subtreeIds.size !== expectedSubtree.length ||
        expectedSubtree.some((d) => !subtreeIds.has(d));
      if (subtreeDrifted) {
        const err = new Error('The container tree changed while this move was being checked — try again');
        err.statusCode = 409;
        throw err;
      }

      // Effective area: derived from the destination PARENT, never trusted from
      // the caller. Moving under a parent in another area without a matching
      // areaId used to leave the subtree's AREA_ID stale — wrong breadcrumbs,
      // and silently dropped from the items-by-location report (which filters
      // children by PARENT_CONTAINER_ID AND AREA_ID). For a root move (no
      // parent) there is no parent to derive from, so the caller's areaId stands.
      let effectiveAreaId = newAreaId;

      if (newParentContainerId) {
        // Post-lock (#87): the destination's ancestor chain must be exactly
        // the set of rows we locked. Post-lock plain reads (the subtree
        // re-read above opened the read view, after every lock wait) see
        // every commit those waits let through. A drifted chain means a
        // concurrent move re-parented the destination between the advisory
        // read and our locks; the rows we hold are then the wrong mutex, so
        // refuse and let the client retry against the settled tree.
        const ancestorsNow = await tx.query(
          'SELECT ANCESTOR_ID FROM TALLY.container_paths WHERE DESCENDANT_ID = ? AND DEPTH > 0',
          [newParentContainerId]
        );
        const nowIds = new Set(ancestorsNow.map((r) => Number(r.ANCESTOR_ID)));
        const chainDrifted =
          nowIds.size !== expectedAncestors.length ||
          expectedAncestors.some((a) => !nowIds.has(a));
        if (chainDrifted) {
          const err = new Error('The container tree changed while this move was being checked — try again');
          err.statusCode = 409;
          throw err;
        }

        const cycle = await tx.query(
          'SELECT 1 FROM TALLY.container_paths WHERE ANCESTOR_ID = ? AND DESCENDANT_ID = ? LIMIT 1',
          [id, newParentContainerId]
        );
        if (cycle.length) {
          const err = new Error('A container cannot be moved into its own descendant');
          err.statusCode = 400;
          throw err;
        }

        // Parent must be a LIVE container in a LIVE area (join areas — checking
        // only the container's DELETED_AT would let a "live container in a dead
        // area" slip through if that invariant ever loosened).
        const parentRows = await tx.query(
          `SELECT c.AREA_ID FROM TALLY.containers c
           JOIN TALLY.areas a ON c.AREA_ID = a.ID
           WHERE c.ID = ? AND c.DELETED_AT IS NULL AND a.DELETED_AT IS NULL`,
          [newParentContainerId]
        );
        if (!parentRows.length) {
          const err = new Error('Destination parent container not found');
          err.statusCode = 404;
          throw err;
        }
        const parentAreaId = parentRows[0].AREA_ID;
        if (newAreaId !== undefined && Number(newAreaId) !== Number(parentAreaId)) {
          const err = new Error("areaId must match the destination parent's area");
          err.statusCode = 400;
          throw err;
        }
        effectiveAreaId = parentAreaId;
      }
      // else: root move. If newAreaId was given, it was already locked
      // (#256, statement 1 above) and confirmed live BEFORE any of this
      // branch's logic ran; effectiveAreaId already carries it from the
      // `let effectiveAreaId = newAreaId` above. If newAreaId is undefined,
      // the container simply keeps its current area — no cascade needed
      // below.

      const fields = ['PARENT_CONTAINER_ID = ?'];
      const values = [newParentContainerId || null];
      if (effectiveAreaId !== undefined) {
        fields.push('AREA_ID = ?');
        values.push(effectiveAreaId);
      }
      values.push(id);

      await tx.query(`UPDATE TALLY.containers SET ${fields.join(', ')} WHERE ID = ?`, values);
      await _closureTable.moveNode(id, newParentContainerId || null, tx);

      // Cascade the derived area to the whole subtree (moveNode only rewrites
      // the closure). Runs whenever we have an effective area — i.e. any move
      // under a parent, or a root move that carried an areaId.
      if (effectiveAreaId !== undefined) {
        await tx.query(
          `UPDATE TALLY.containers SET AREA_ID = ?
           WHERE ID IN (
             SELECT DESCENDANT_ID FROM TALLY.container_paths WHERE ANCESTOR_ID = ?
           )`,
          [effectiveAreaId, id]
        );
      }

      // Cross-property: reconciliation rides the SAME transaction as the move
      // itself — runs after the cascade so movingSet's closure-table walk
      // (and the item lookup it does per container) sees the subtree's final
      // AREA_ID, though only CONTAINER_ID membership in the closure table
      // actually matters for the set it collects.
      if (moveArgs) {
        const set = await Reconcile.movingSet(tx, 'container', id);
        consequences = await Reconcile.reconcile(tx, set, moveArgs);
      }
    });

    if (moveArgs) {
      // Audited AFTER the transaction resolves — logChange writes through a
      // plain pool connection, not tx, so writing it any earlier would let
      // audit rows outlive a rollback (see move-reconcile.service.js). The
      // plain single-property 'moved' audit below would also be a THIRD,
      // misleading event (it names neither property) if it fired here too.
      Reconcile.auditMove(moveArgs);
      return { container: await ContainersService.getById(id), consequences };
    }

    const propertyId = await ContainersService.getPropertyIdForContainer(id);
    AuditService.logChange(userId, 'container', id, 'moved', { parentContainerId: newParentContainerId, areaId: newAreaId }, propertyId);

    return { container: await ContainersService.getById(id), consequences: null };
  },

  async softDelete(id, userId) {
    const propertyId = await ContainersService.getPropertyIdForContainer(id);
    const nameRows = await _db.query('SELECT NAME FROM TALLY.containers WHERE ID = ?', [id]);
    const rootName = nameRows[0]?.NAME || 'Container';

    await _db.withTransaction(async (tx) => {
      // Open the batch FIRST so every row this cascade stamps carries its id.
      // Without it, a later restore could not tell the rows this operation
      // deleted from rows that were already in the bin — the two UPDATEs below
      // guard on DELETED_AT IS NULL precisely so they don't disturb the latter.
      const batchId = await RecycleService.openBatch(tx, {
        propertyId, rootType: 'container', rootId: id, rootName, userId,
      });

      // Return open loans before the items go. The area cascade has always done
      // this; this path did not, which left an open loan pointing at a recycled
      // item — and purgeExpired then refuses to purge it, forever.
      await tx.query(
        `UPDATE TALLY.item_lending SET RETURNED_AT = NOW()
         WHERE RETURNED_AT IS NULL AND ITEM_ID IN (
           SELECT i.ID FROM TALLY.items i
           WHERE i.DELETED_AT IS NULL AND i.CONTAINER_ID IN (
             SELECT DESCENDANT_ID FROM TALLY.container_paths WHERE ANCESTOR_ID = ?
           )
         )`,
        [id]
      );

      // Cascade the soft-delete to the ENTIRE subtree (this container + every
      // descendant container) and the items inside them, using the closure
      // table. Closure paths are LEFT INTACT so the subtree stays restorable;
      // destroying them belongs to a permanent delete only.
      await tx.query(
        `UPDATE TALLY.containers SET DELETED_AT = NOW(), DELETE_BATCH_ID = ?
         WHERE DELETED_AT IS NULL AND ID IN (
           SELECT DESCENDANT_ID FROM TALLY.container_paths WHERE ANCESTOR_ID = ?
         )`,
        [batchId, id]
      );
      // STATUS = 'removed' matches the area cascade and the single-item delete;
      // this path used to leave recycled items reading 'active'.
      await tx.query(
        `UPDATE TALLY.items SET DELETED_AT = NOW(), STATUS = 'removed', DELETE_BATCH_ID = ?
         WHERE DELETED_AT IS NULL AND CONTAINER_ID IN (
           SELECT DESCENDANT_ID FROM TALLY.container_paths WHERE ANCESTOR_ID = ?
         )`,
        [batchId, id]
      );
    });
    AuditService.logChange(userId, 'container', id, 'deleted', {}, propertyId);
  },

  async getPropertyIdForContainer(containerId) {
    const rows = await _db.query(
      'SELECT a.PROPERTY_ID FROM TALLY.areas a JOIN TALLY.containers c ON c.AREA_ID = a.ID WHERE c.ID = ?',
      [containerId]
    );
    return rows[0]?.PROPERTY_ID || null;
  },

  // Returns the container's AREA_ID iff the container AND its area are both
  // live (not soft-deleted); null otherwise. Used to reject placing items/
  // containers into a recycled container — which would create "phantom"
  // inventory: rows that are active but sit inside a hidden parent, so they
  // never appear in navigation yet still count in reports/search. (Distinct
  // from getPropertyIdForContainer, which intentionally ignores DELETED_AT so
  // the recycle bin can still read deleted containers.)
  async getActiveAreaId(containerId) {
    const rows = await _db.query(
      `SELECT c.AREA_ID FROM TALLY.containers c
       JOIN TALLY.areas a ON c.AREA_ID = a.ID
       WHERE c.ID = ? AND c.DELETED_AT IS NULL AND a.DELETED_AT IS NULL`,
      [containerId]
    );
    return rows.length ? rows[0].AREA_ID : null;
  },
};

module.exports = ContainersService;

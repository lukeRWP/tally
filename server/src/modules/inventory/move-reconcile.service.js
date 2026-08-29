const AuditService = require('../audit/audit.service');

/**
 * Everything a cross-property move must reconcile, in one place.
 *
 * Every function takes an open transaction handle and NEVER opens its own —
 * the caller owns atomicity, because the reconciliation is only correct if it
 * commits or rolls back WITH the move itself.
 */

async function movingSet(tx, entityType, entityId) {
  if (entityType === 'item') return { containerIds: [], itemIds: [Number(entityId)] };

  // The closure table stores a DEPTH-0 self row, so ANCESTOR_ID = root returns
  // the root itself plus every descendant in one read.
  const rows = await tx.query(
    'SELECT DESCENDANT_ID FROM TALLY.container_paths WHERE ANCESTOR_ID = ?',
    [entityId]
  );
  const containerIds = rows.map((r) => r.DESCENDANT_ID);
  // A container with no rows back from the closure walk (shouldn't happen —
  // the DEPTH-0 self row always matches — but a future caller passing a
  // dead/unknown id must not turn this into `IN ()`, invalid SQL) has no
  // items to look up.
  if (!containerIds.length) return { containerIds, itemIds: [] };
  const items = await tx.query(
    `SELECT ID FROM TALLY.items
      WHERE CONTAINER_ID IN (${containerIds.map(() => '?').join(',')})
        AND DELETED_AT IS NULL`,
    containerIds
  );
  return { containerIds, itemIds: items.map((r) => r.ID) };
}

/** The entity_tags rows attached to anything in the set, with tag names. */
async function attachedTags(tx, set) {
  const preds = [];
  const params = [];
  if (set.containerIds.length) {
    preds.push(`(et.ENTITY_TYPE = 'container' AND et.ENTITY_ID IN (${set.containerIds.map(() => '?').join(',')}))`);
    params.push(...set.containerIds);
  }
  if (set.itemIds.length) {
    preds.push(`(et.ENTITY_TYPE = 'item' AND et.ENTITY_ID IN (${set.itemIds.map(() => '?').join(',')}))`);
    params.push(...set.itemIds);
  }
  if (!preds.length) return [];
  return tx.query(
    `SELECT et.TAG_ID, t.NAME, et.ENTITY_TYPE, et.ENTITY_ID
       FROM TALLY.tags t
       JOIN TALLY.entity_tags et ON t.ID = et.TAG_ID
      WHERE ${preds.join(' OR ')}`,
    params
  );
}

/** Half-out accessory links: exactly one end inside the moving set. */
async function halfOutLinks(tx, itemIds) {
  if (!itemIds.length) return [];
  const ph = itemIds.map(() => '?').join(',');
  const links = await tx.query(
    `SELECT ID, ITEM_ID, ACCESSORY_ID FROM TALLY.item_accessories
      WHERE ITEM_ID IN (${ph}) OR ACCESSORY_ID IN (${ph})`,
    [...itemIds, ...itemIds]
  );
  const inSet = new Set(itemIds.map(Number));
  return links.filter((l) => inSet.has(Number(l.ITEM_ID)) !== inSet.has(Number(l.ACCESSORY_ID)));
}

/**
 * Resolve the names of the ends that stay behind, for honest reporting.
 * Deduped by item ID: two moving items linked to the same outside item (e.g.
 * a shared charger) would otherwise produce two rows naming the same
 * outside item — a duplicate the client renders as a duplicate React key.
 */
async function staying(tx, links, itemIds) {
  if (!links.length) return [];
  const inSet = new Set(itemIds.map(Number));
  const stayIds = [...new Set(
    links.map((l) => Number(inSet.has(Number(l.ITEM_ID)) ? l.ACCESSORY_ID : l.ITEM_ID))
  )];
  const rows = await tx.query(
    `SELECT ID, NAME FROM TALLY.items WHERE ID IN (${stayIds.map(() => '?').join(',')})`,
    stayIds
  );
  const names = new Map(rows.map((r) => [Number(r.ID), r.NAME]));
  return stayIds.map((id) => ({ itemId: id, name: names.get(id) ?? `#${id}` }));
}

/**
 * `attached` is one row per entity_tags attachment, so a single tag on three
 * entities in the moving set appears three times — the reported count must
 * be distinct tags, not attachment rows, or "1 tag carried" reads as "3 tags
 * carried". Repointing (in reconcile(), below) still runs once per row.
 */
function distinctTagCount(attached) {
  return new Set(attached.map((a) => a.TAG_ID)).size;
}

/** Plan the tag carry against the destination's existing tags. */
async function tagPlan(tx, set, destPropertyId) {
  const attached = await attachedTags(tx, set);
  if (!attached.length) return { attached, byName: new Map(), toCreate: [] };
  const dest = await tx.query(
    'SELECT ID, NAME FROM TALLY.tags WHERE PROPERTY_ID = ?', [destPropertyId]
  );
  const byName = new Map(dest.map((t) => [t.NAME.toLowerCase(), t.ID]));
  const toCreate = [...new Map(
    attached.filter((a) => !byName.has(a.NAME.toLowerCase())).map((a) => [a.NAME.toLowerCase(), a.NAME])
  ).values()];
  return { attached, byName, toCreate };
}

async function previewConsequences(tx, set, destPropertyId) {
  const { attached, toCreate } = await tagPlan(tx, set, destPropertyId);
  const links = await halfOutLinks(tx, set.itemIds);
  const unlinked = await staying(tx, links, set.itemIds);
  return { unlinked, tagsCarried: distinctTagCount(attached), tagsCreated: toCreate.length };
}

// The 409 confirm gate is pure enough to unit-test on its own, and pulling it
// out of the route handler is what makes that possible — there is no req/res
// to fake, just the preview and the caller's flag. Lives here (rather than in
// items.routes.js, its original home) because both items and containers
// routes need it — shared logic belongs in the shared module.
function needsConfirm(consequences, confirm) {
  return !confirm && consequences.unlinked.length > 0;
}

// Data-only: tags + accessories. Callers audit separately via auditMove,
// after their transaction resolves — see the comment there. The options
// object still accepts the full move-bookkeeping shape (srcPropertyId,
// userId, rootType, rootId, moveChanges) so callers can build one options
// object and pass it to both reconcile() and auditMove(); only destPropertyId
// is actually read here.
async function reconcile(tx, set, { destPropertyId }) {
  // Tags: find-or-create in the destination, then repoint each attachment row.
  const { attached, byName, toCreate } = await tagPlan(tx, set, destPropertyId);
  for (const name of toCreate) {
    let tagId;
    try {
      const res = await tx.query(
        'INSERT INTO TALLY.tags (NAME, COLOR, PROPERTY_ID) VALUES (?, NULL, ?)',
        [name, destPropertyId]
      );
      tagId = res.insertId;
    } catch (err) {
      // A concurrent move raced us to creating this destination tag
      // (uq_tags_name_property, #244): converge on the winner's row instead
      // of 500ing and rolling back a move whose own data was fine — the same
      // catch-ER_DUP_ENTRY-then-re-select pattern as TagsService.findOrCreate
      // (tags.service.js). One difference: here the re-select must be a
      // LOCKING read. This transaction runs REPEATABLE READ, so a plain
      // SELECT would replay our pre-collision snapshot and still see no row;
      // FOR SHARE reads latest committed and holds the winner's row until
      // the repoints below commit against it. (ER_DUP_ENTRY aborts only the
      // statement, not the transaction.)
      if (err.code !== 'ER_DUP_ENTRY') throw err;
      const winner = await tx.query(
        'SELECT ID FROM TALLY.tags WHERE NAME = ? AND PROPERTY_ID = ? LIMIT 1 FOR SHARE',
        [name, destPropertyId]
      );
      if (!winner.length) throw err; // collided yet absent — surface the original error
      tagId = winner[0].ID;
    }
    byName.set(name.toLowerCase(), tagId);
  }
  for (const a of attached) {
    await tx.query(
      'UPDATE TALLY.entity_tags SET TAG_ID = ? WHERE TAG_ID = ? AND ENTITY_TYPE = ? AND ENTITY_ID = ?',
      [byName.get(a.NAME.toLowerCase()), a.TAG_ID, a.ENTITY_TYPE, a.ENTITY_ID]
    );
  }

  // Accessories: delete the half-out links, keep intra-set ones.
  const links = await halfOutLinks(tx, set.itemIds);
  const unlinked = await staying(tx, links, set.itemIds);
  if (links.length) {
    await tx.query(
      `DELETE FROM TALLY.item_accessories WHERE ID IN (${links.map(() => '?').join(',')})`,
      links.map((l) => l.ID)
    );
  }

  // No audit here — see auditMove below for why.
  return { unlinked, tagsCarried: distinctTagCount(attached), tagsCreated: toCreate.length };
}

// Audits both sides of a cross-property move, once per moved root — a
// subtree move is one event on each side.
//
// Deliberately NOT called from inside reconcile(): logChange writes through
// AuditService's module-global _db.query — a plain pool connection, not the
// caller's tx — so an audit row written mid-transaction commits durably the
// instant it's written, independent of whether the move transaction that
// "happened" ever actually commits. A rollback would then leave two audit
// rows describing a move that never took place, while the tag/accessory
// changes they describe vanished. Every other audited op in this codebase
// (items/containers/areas) follows the same rule reconcile() now follows:
// commit the operation first, THEN audit best-effort after — logChange
// swallows its own failures, and an audit failure never rolls back an
// operation. Callers invoke this exactly where the same-property path
// invokes its own single 'moved' audit: after their withTransaction resolves.
async function auditMove({ userId, rootType, rootId, srcPropertyId, destPropertyId, moveChanges }) {
  await AuditService.logChange(userId, rootType, rootId, 'moved-out',
    { ...moveChanges, toPropertyId: destPropertyId }, srcPropertyId);
  await AuditService.logChange(userId, rootType, rootId, 'moved-in',
    { ...moveChanges, fromPropertyId: srcPropertyId }, destPropertyId);
}

module.exports = { movingSet, previewConsequences, reconcile, needsConfirm, auditMove };

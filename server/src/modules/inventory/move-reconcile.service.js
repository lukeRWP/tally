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

/** Resolve the names of the ends that stay behind, for honest reporting. */
async function staying(tx, links, itemIds) {
  if (!links.length) return [];
  const inSet = new Set(itemIds.map(Number));
  const stayIds = links.map((l) => (inSet.has(Number(l.ITEM_ID)) ? l.ACCESSORY_ID : l.ITEM_ID));
  const rows = await tx.query(
    `SELECT ID, NAME FROM TALLY.items WHERE ID IN (${stayIds.map(() => '?').join(',')})`,
    stayIds
  );
  const names = new Map(rows.map((r) => [Number(r.ID), r.NAME]));
  return stayIds.map((id) => ({ itemId: Number(id), name: names.get(Number(id)) ?? `#${id}` }));
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
  return { unlinked, tagsCarried: attached.length, tagsCreated: toCreate.length };
}

// The 409 confirm gate is pure enough to unit-test on its own, and pulling it
// out of the route handler is what makes that possible — there is no req/res
// to fake, just the preview and the caller's flag. Lives here (rather than in
// items.routes.js, its original home) because both items and containers
// routes need it — shared logic belongs in the shared module.
function needsConfirm(consequences, confirm) {
  return !confirm && consequences.unlinked.length > 0;
}

async function reconcile(tx, set, { srcPropertyId, destPropertyId, userId, rootType, rootId, moveChanges }) {
  // Tags: find-or-create in the destination, then repoint each attachment row.
  const { attached, byName, toCreate } = await tagPlan(tx, set, destPropertyId);
  for (const name of toCreate) {
    const res = await tx.query(
      'INSERT INTO TALLY.tags (NAME, COLOR, PROPERTY_ID) VALUES (?, NULL, ?)',
      [name, destPropertyId]
    );
    byName.set(name.toLowerCase(), res.insertId);
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

  // Audit both sides, once per moved root — a subtree move is one event.
  await AuditService.logChange(userId, rootType, rootId, 'moved-out',
    { ...moveChanges, toPropertyId: destPropertyId }, srcPropertyId);
  await AuditService.logChange(userId, rootType, rootId, 'moved-in',
    { ...moveChanges, fromPropertyId: srcPropertyId }, destPropertyId);

  return { unlinked, tagsCarried: attached.length, tagsCreated: toCreate.length };
}

module.exports = { movingSet, previewConsequences, reconcile, needsConfirm };

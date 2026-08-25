# Cross-Property Move Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Moving an item or a container (with its full subtree) to another property works from every existing move entry point, with a confirmation only when the move breaks accessory links.

**Architecture:** The two existing move endpoints fork on destination property. A shared reconciliation module computes the moving set from the closure table, carries tags by find-or-create, breaks half-out accessory links with notice, and writes audit to both properties — all inside the move's transaction. A 409-with-consequences gate makes lossy moves require `confirm: true`. The client adds a consequence sheet, a property switcher on `/move`, and undo wording.

**Tech Stack:** Express 4 (CommonJS), mysql2 (`withTransaction`), Joi, `node:test` + local `fakeDb`; React 18 + TS + TanStack Query v5.

Spec: `docs/superpowers/specs/2026-08-24-cross-property-move-design.md`

## Global Constraints

- **NO migration.** Every write lands on existing tables. If a task seems to need a schema change, the task is wrong — stop and escalate.
- **Same-property moves stay byte-identical.** Regression tests must pin today's behaviour: same SQL, no reconciliation statements issued, no confirm gate.
- **PRIVACY INVARIANT:** every new query joins `items → containers → areas → properties → property_members` with `pm.USER_ID = ?` and four-level `DELETED_AT IS NULL` filters, matching `items.service.js:476`.
- Response helpers take `res` FIRST and send themselves: `success(res, data)`, `error(res, message, statusCode, errors)` — the 4th argument lands in the body as `errors` and is how the consequence payload travels.
- Route prefix `_p_` = PATCH. Service SQL uses `TALLY.` prefixes. DB `UPPER_SNAKE_CASE` → API `camelCase`.
- Server tests: `node --test` from `server/`, local `fakeDb` per file. Server lint must pass (`npm run lint`).
- Client gates: `npx tsc --noEmit` + `npm run build` from `client/`. **There is no client ESLint.**
- Roles: cross-property requires editor/owner in BOTH properties. Source is already resolved by `resolvePropertyFromItem`/`FromContainer` → `requireRole('owner','editor')`; the destination check is new, in-handler.
- `master` is protected; branch `feat/cross-property-move`, PR flow, merge on green (no migration ordering applies).

---

## File Structure

**Created**
| File | Responsibility |
|---|---|
| `server/src/modules/inventory/move-reconcile.service.js` | Moving set, tag carry, accessory break, dual audit, consequence preview. All cross-property logic in one place; both move endpoints call it. |
| `server/test/move-reconcile.test.js` | The helper in isolation |
| `client/src/components/inventory/move-consequences-sheet.tsx` | Renders the 409 payload; Confirm re-sends |

**Modified**
| File | Change |
|---|---|
| `server/src/modules/inventory/items.routes.js` | Fork the same-property guard; dest role check; 409 gate |
| `server/src/modules/inventory/items.service.js` | `move()` gains optional cross-property path in a transaction |
| `server/src/modules/inventory/containers.routes.js` | Same fork for container moves |
| `server/src/modules/inventory/containers.service.js` | Reconcile inside the existing move transaction |
| `server/test/items.move.test.js` (new) + `server/test/containers.move-cross.test.js` (new) | Route+service behaviour, regression pins |
| `client/src/lib/api.ts` | `ApiError` exposes the body's `errors` (check first — may already) |
| `client/src/pages/scan.tsx`, `client/src/store/carry-store.ts` | 409 → sheet → confirm re-send; undo records `unlinkedCount` |
| `client/src/pages/move.tsx` | Property switcher when `properties.length > 1` |

---

## Task 1: The reconciliation helper

**Files:**
- Create: `server/src/modules/inventory/move-reconcile.service.js`
- Test: `server/test/move-reconcile.test.js`

**Interfaces:**
- Consumes: a `tx` (transaction handle with `.query`), `AuditService.logChange(userId, entityType, entityId, action, changes, propertyId)`.
- Produces (all take `tx` as first arg; none open transactions themselves):
  - `movingSet(tx, entityType, entityId) -> {containerIds: number[], itemIds: number[]}` — for an item: itself only; for a container: the container + closure-table descendants + all items in any of those containers.
  - `previewConsequences(tx, set, destPropertyId) -> {unlinked: [{itemId, name}], tagsCarried: number, tagsCreated: number}` — read-only.
  - `reconcile(tx, set, {srcPropertyId, destPropertyId, userId, rootType, rootId, moveChanges}) -> consequences` — performs tag repoint, link deletion, dual audit; returns the same shape as preview.

- [ ] **Step 1: Write the failing tests**

Create `server/test/move-reconcile.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const Reconcile = require('../src/modules/inventory/move-reconcile.service');

// Scriptable tx: routes each query by regex to a canned result and records all.
function fakeTx(routes) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      for (const [re, result] of routes) if (re.test(sql)) return typeof result === 'function' ? result(sql, params) : result;
      return [];
    },
  };
}

test('movingSet for an item is just that item', async () => {
  const tx = fakeTx([]);
  const set = await Reconcile.movingSet(tx, 'item', 7);
  assert.deepEqual(set, { containerIds: [], itemIds: [7] });
  assert.equal(tx.calls.length, 0, 'no queries needed for a single item');
});

test('movingSet for a container walks the closure table and collects items', async () => {
  const tx = fakeTx([
    [/container_paths/, [{ DESCENDANT_ID: 3 }, { DESCENDANT_ID: 9 }, { DESCENDANT_ID: 12 }]],
    [/FROM TALLY\.items/, [{ ID: 101 }, { ID: 102 }]],
  ]);
  const set = await Reconcile.movingSet(tx, 'container', 3);
  assert.deepEqual(set.containerIds, [3, 9, 12], 'root included via closure DEPTH 0 row');
  assert.deepEqual(set.itemIds, [101, 102]);
  const itemsQ = tx.calls.find((c) => /FROM TALLY\.items/.test(c.sql));
  assert.match(itemsQ.sql, /CONTAINER_ID IN/, 'items looked up across the whole subtree');
  assert.match(itemsQ.sql, /DELETED_AT IS NULL/, 'recycled items do not travel');
});

test('carrying tags matches by name case-insensitively and creates the rest', async () => {
  const writes = [];
  const tx = fakeTx([
    // Tags attached to the moving set (two entities share "Fragile")
    [/FROM TALLY\.tags t[\s\S]*entity_tags/, [
      { TAG_ID: 1, NAME: 'Fragile', ENTITY_TYPE: 'item', ENTITY_ID: 101 },
      { TAG_ID: 1, NAME: 'Fragile', ENTITY_TYPE: 'item', ENTITY_ID: 102 },
      { TAG_ID: 2, NAME: 'Tools',   ENTITY_TYPE: 'container', ENTITY_ID: 3 },
    ]],
    // Destination property already has a "fragile" (different case)
    [/FROM TALLY\.tags WHERE PROPERTY_ID/, [{ ID: 40, NAME: 'fragile' }]],
    [/INSERT INTO TALLY\.tags/, (sql, params) => { writes.push({ sql, params }); return { insertId: 41 }; }],
    [/UPDATE TALLY\.entity_tags/, (sql, params) => { writes.push({ sql, params }); return { affectedRows: 1 }; }],
  ]);
  const out = await Reconcile.reconcile(tx,
    { containerIds: [3], itemIds: [101, 102] },
    { srcPropertyId: 1, destPropertyId: 2, userId: 42, rootType: 'container', rootId: 3, moveChanges: {} });
  assert.equal(out.tagsCarried, 3, 'every attachment row is repointed');
  assert.equal(out.tagsCreated, 1, 'only Tools is created; fragile matched case-insensitively');
  const created = writes.find((w) => /INSERT INTO TALLY\.tags/.test(w.sql));
  assert.ok(created.params.includes('Tools'));
  assert.ok(created.params.includes(2), 'created in the DESTINATION property');
});

test('accessory links survive intra-set and break half-out, reported by name', async () => {
  const writes = [];
  const tx = fakeTx([
    [/FROM TALLY\.tags t[\s\S]*entity_tags/, []],
    [/FROM TALLY\.item_accessories/, [
      { ID: 900, ITEM_ID: 101, ACCESSORY_ID: 102 },   // both moving → survives
      { ID: 901, ITEM_ID: 101, ACCESSORY_ID: 555 },   // 555 stays → breaks
      { ID: 902, ITEM_ID: 777, ACCESSORY_ID: 102 },   // 777 stays → breaks
    ]],
    [/FROM TALLY\.items WHERE ID IN/, [{ ID: 555, NAME: 'Battery pack' }, { ID: 777, NAME: 'Charger' }]],
    [/DELETE FROM TALLY\.item_accessories/, (sql, params) => { writes.push({ sql, params }); return { affectedRows: 2 }; }],
  ]);
  const out = await Reconcile.reconcile(tx,
    { containerIds: [], itemIds: [101, 102] },
    { srcPropertyId: 1, destPropertyId: 2, userId: 42, rootType: 'item', rootId: 101, moveChanges: {} });
  assert.equal(out.unlinked.length, 2);
  assert.deepEqual(out.unlinked.map((u) => u.name).sort(), ['Battery pack', 'Charger']);
  const del = writes.find((w) => /DELETE FROM TALLY\.item_accessories/.test(w.sql));
  assert.deepEqual(del.params.sort(), [901, 902], 'deletes exactly the half-out links by ID');
});

test('audit is written to BOTH properties, once per root', async () => {
  const audits = [];
  const AuditService = require('../src/modules/audit/audit.service');
  const orig = AuditService.logChange;
  AuditService.logChange = async (...args) => { audits.push(args); };
  try {
    const tx = fakeTx([[/entity_tags/, []], [/item_accessories/, []]]);
    await Reconcile.reconcile(tx, { containerIds: [], itemIds: [7] },
      { srcPropertyId: 1, destPropertyId: 2, userId: 42, rootType: 'item', rootId: 7,
        moveChanges: { containerId: 30 } });
    assert.equal(audits.length, 2);
    const [out_, in_] = audits;
    assert.equal(out_[3], 'moved-out'); assert.equal(out_[5], 1);
    assert.equal(in_[3], 'moved-in');   assert.equal(in_[5], 2);
  } finally { AuditService.logChange = orig; }
});

test('previewConsequences issues no writes', async () => {
  const tx = fakeTx([
    [/entity_tags/, [{ TAG_ID: 2, NAME: 'Tools', ENTITY_TYPE: 'item', ENTITY_ID: 7 }]],
    [/FROM TALLY\.tags WHERE PROPERTY_ID/, []],
    [/item_accessories/, []],
  ]);
  const out = await Reconcile.previewConsequences(tx, { containerIds: [], itemIds: [7] }, 2);
  assert.equal(out.tagsCreated, 1, 'reports what WOULD be created');
  assert.ok(!tx.calls.some((c) => /INSERT|UPDATE|DELETE/i.test(c.sql)), 'read-only');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npm test -- test/move-reconcile.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `server/src/modules/inventory/move-reconcile.service.js`:

```js
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

module.exports = { movingSet, previewConsequences, reconcile };
```

- [ ] **Step 4: Run to verify all pass**

Run: `cd server && npm test -- test/move-reconcile.test.js`
Expected: 6/6 PASS.

- [ ] **Step 5: Lint and commit**

```bash
cd server && npm run lint
git add src/modules/inventory/move-reconcile.service.js ../server/test/move-reconcile.test.js
git commit -m "feat(inventory): cross-property reconciliation helper"
```

---

## Task 2: Item move crosses properties

**Files:**
- Modify: `server/src/modules/inventory/items.routes.js` (the `/move` handler, ~line 235)
- Modify: `server/src/modules/inventory/items.service.js` (`move()`, ~line 303)
- Test: `server/test/items.move.test.js` (new)

**Interfaces:**
- Consumes: `Reconcile.movingSet/previewConsequences/reconcile` (Task 1), `_db.withTransaction`, `ContainersService.getPropertyIdForContainer`, `ContainersService.getActiveAreaId`.
- Produces: `ItemsService.move(id, newContainerId, userId, opts)` where `opts = {crossProperty?: {srcPropertyId, destPropertyId}}`; returns `{item, consequences|null}`. Route accepts `{containerId, confirm?}` and responds `409` + `errors: consequences` when unconfirmed and lossy.

- [ ] **Step 1: Write the failing tests**

Create `server/test/items.move.test.js` with a `fakeDb` whose `withTransaction(fn)` invokes `fn` with the same scriptable handle, and cases:

```js
// 1. REGRESSION PIN — same-property move issues exactly one UPDATE and no
//    reconciliation statements:
test('same-property move is byte-identical to before', async () => {
  // script: UPDATE items → ok; assert NO query touches entity_tags,
  // item_accessories, container_paths, or tags; assert no withTransaction use
  // beyond what today's code does (none), and audit logged once with 'moved'.
});
// 2. cross-property runs inside ONE transaction: UPDATE items + reconcile
//    calls all through the SAME tx handle (tag the handle, assert identity).
// 3. cross-property audit: exactly 'moved-out'+'moved-in', no plain 'moved'.
// 4. move() with crossProperty returns {item, consequences} with the
//    reconcile result passed through.
```

Write these as real tests (the shapes above are the assertions to make), following `labels.test.js`'s fakeDb idiom. For the route-level confirm gate, test the handler logic through the service seam: the route is thin; its 409 decision is `!confirm && consequences.unlinked.length > 0` computed from `previewConsequences` — put that decision in a small exported function `needsConfirm(consequences, confirm)` in the routes file's module scope and unit-test it directly (`needsConfirm({unlinked:[x]}, false) === true`, `…, true) === false`, `needsConfirm({unlinked:[]}, false) === false`).

- [ ] **Step 2: Run to verify they fail**

`cd server && npm test -- test/items.move.test.js` — FAIL (opts param and needsConfirm don't exist).

- [ ] **Step 3: Implement the service**

In `items.service.js`, replace `move()`:

```js
  async move(id, newContainerId, userId, opts = {}) {
    const cross = opts.crossProperty;
    if (!cross) {
      // The same-property path is UNTOUCHED — same statement, same audit.
      await _db.query(
        'UPDATE TALLY.items SET CONTAINER_ID = ? WHERE ID = ?',
        [newContainerId, id]
      );
      const propertyId = await ItemsService.getPropertyIdForItem(id);
      AuditService.logChange(userId, 'item', id, 'moved', { containerId: newContainerId }, propertyId);
      return { item: await ItemsService.getById(id), consequences: null };
    }

    // Cross-property: the move and its reconciliation commit or roll back
    // together — a moved item with stranded tag rows would be worse than a
    // refused move.
    let consequences = null;
    await _db.withTransaction(async (tx) => {
      await tx.query(
        'UPDATE TALLY.items SET CONTAINER_ID = ? WHERE ID = ?',
        [newContainerId, id]
      );
      const set = await Reconcile.movingSet(tx, 'item', id);
      consequences = await Reconcile.reconcile(tx, set, {
        srcPropertyId: cross.srcPropertyId,
        destPropertyId: cross.destPropertyId,
        userId,
        rootType: 'item',
        rootId: Number(id),
        moveChanges: { containerId: newContainerId },
      });
    });
    return { item: await ItemsService.getById(id), consequences };
  },
```

Add `const Reconcile = require('./move-reconcile.service');` at the top.

- [ ] **Step 4: Implement the route fork**

In `items.routes.js`, the `/move` handler: keep validation and the live-destination check. Replace the same-property refusal with:

```js
      const destPropertyId = await ContainersService.getPropertyIdForContainer(value.containerId);
      const srcPropertyId = req.params.propertyId;
      if (!destPropertyId) {
        return error(res, 'Destination container not found', 404);
      }
      let crossProperty = null;
      if (String(destPropertyId) !== String(srcPropertyId)) {
        // Cross-property: the caller must be editor/owner THERE too — the
        // same-property guard was partly a tenancy rule, and this preserves it.
        const destRole = await _db.query(
          'SELECT ROLE FROM TALLY.property_members WHERE PROPERTY_ID = ? AND USER_ID = ?',
          [destPropertyId, req.user.id]
        );
        if (!['owner', 'editor'].includes(destRole[0]?.ROLE)) {
          return error(res, 'You need editor access to the destination property', 403);
        }
        crossProperty = { srcPropertyId: Number(srcPropertyId), destPropertyId: Number(destPropertyId) };

        // Lossy moves need an explicit confirm; clean ones keep the scan rhythm.
        if (!value.confirm) {
          const preview = await _db.withTransaction(async (tx) => {
            const set = await Reconcile.movingSet(tx, 'item', req.params.itemId);
            return Reconcile.previewConsequences(tx, set, destPropertyId);
          });
          if (needsConfirm(preview, value.confirm)) {
            return error(res, 'This move unlinks accessories', 409, preview);
          }
        }
      }
      // …existing getActiveAreaId liveness check stays here, unchanged…
      const out = await ItemsService.move(req.params.itemId, value.containerId, req.user.id, { crossProperty });
      success(res, out);
```

Module scope: `function needsConfirm(consequences, confirm) { return !confirm && consequences.unlinked.length > 0; } module.exports.needsConfirm = needsConfirm;` — exported for the unit test. Add `confirm: Joi.boolean()` to the `moveItem` schema in `items.schema.js`.

- [ ] **Step 5: Run tests, lint, commit**

`cd server && npm test && npm run lint` — full suite green (319 + new), lint clean.

```bash
git add src/modules/inventory/items.routes.js src/modules/inventory/items.service.js src/modules/inventory/items.schema.js test/items.move.test.js
git commit -m "feat(inventory): item moves cross properties with reconciliation and confirm gate"
```

---

## Task 3: Container move crosses properties

**Files:**
- Modify: `server/src/modules/inventory/containers.routes.js` (the `/move` handler, ~line 162)
- Modify: `server/src/modules/inventory/containers.service.js` (`move()`, ~line 228)
- Test: `server/test/containers.move-cross.test.js` (new)

**Interfaces:**
- Consumes: Task 1's helper; the existing `withTransaction` body in `containers.service.js` `move()` (cycle check, effective-area derivation, AREA_ID cascade — all unchanged).
- Produces: `ContainersService.move(id, newParentContainerId, newAreaId, userId, opts)` with the same `opts.crossProperty` shape and `{container, consequences|null}` return.

- [ ] **Step 1: Write the failing tests**

`server/test/containers.move-cross.test.js`:

```js
// 1. REGRESSION PIN — same-property container move issues exactly the same
//    statement sequence as today (lock, cycle check, area derivation, cascade)
//    and NOTHING touching tags/accessories.
// 2. cross-property: reconcile runs INSIDE the existing transaction (same
//    handle identity as the lock/cascade queries).
// 3. cross-property: movingSet is computed from the closure table and the
//    consequence payload covers subtree items' accessories, not just the root.
// 4. route: destination area in another property + no membership there → 403;
//    with editor membership → proceeds.
// 5. route: unconfirmed lossy move → 409 with errors payload; confirm:true → 200.
```

Write these fully, reusing the fakeTx idiom from Task 1's test file (copy the helper into this file — each test file is self-contained by repo convention).

- [ ] **Step 2: Run to verify they fail**

`cd server && npm test -- test/containers.move-cross.test.js` — FAIL.

- [ ] **Step 3: Implement**

Service: add `opts = {}` parameter; inside the existing `withTransaction` callback, after the AREA_ID cascade completes, add:

```js
      if (opts.crossProperty) {
        const set = await Reconcile.movingSet(tx, 'container', id);
        opts._consequences = await Reconcile.reconcile(tx, set, {
          srcPropertyId: opts.crossProperty.srcPropertyId,
          destPropertyId: opts.crossProperty.destPropertyId,
          userId,
          rootType: 'container',
          rootId: Number(id),
          moveChanges: { parentContainerId: newParentContainerId, areaId: newAreaId },
        });
      }
```

After the transaction, when `opts.crossProperty` is set, skip the existing single-property `logChange('moved')` call (the reconcile wrote moved-out/moved-in instead) and return `{container: …, consequences: opts._consequences}`; otherwise return today's shape wrapped as `{container, consequences: null}`.

Route: mirror Task 2's fork exactly — resolve the destination property from `areaId` (or `parentContainerId` when nesting under a container), destination role check → 403, preview → `needsConfirm` → 409, then pass `crossProperty` through. Reuse `needsConfirm` by requiring it from `./items.routes` — or, cleaner, move `needsConfirm` into `move-reconcile.service.js` in this task and update Task 2's import; state in the commit which you did.

Update the two callers' response handling (`success(res, out)` with the new shape) and add `confirm: Joi.boolean()` to `moveContainer` in `containers.schema.js`.

- [ ] **Step 4: Run tests, lint, commit**

Full suite + lint. Commit: `feat(inventory): container subtree moves cross properties`

---

## Task 4: Client — sheet, switcher, undo wording

**Files:**
- Create: `client/src/components/inventory/move-consequences-sheet.tsx`
- Modify: `client/src/lib/api.ts` (only if `ApiError` doesn't already expose the body's `errors`)
- Modify: `client/src/pages/scan.tsx` (move-mode 409 handling), `client/src/store/carry-store.ts` (record `unlinkedCount`), `client/src/pages/move.tsx` (property switcher)

**Interfaces:**
- Consumes: the 409 shape `{message, errors: {unlinked: [{itemId, name}], tagsCarried, tagsCreated}}`; `useProperties()`.
- Produces: `<MoveConsequencesSheet consequences onConfirm onCancel />`.

- [ ] **Step 1: Check `ApiError`**

Read `client/src/lib/api.ts`. If the error object does not already carry the response body's `errors` field, add it (`this.errors = body.errors`) — the 409 payload rides there. `tsc` will confirm downstream usage.

- [ ] **Step 2: The sheet**

`move-consequences-sheet.tsx` — a `Dialog` (same primitives as `ConfirmDialog`) rendering: title "Move to the other property?", a line per unlinked accessory ("Unlinks from {name}"), a muted summary line ("{tagsCarried} tags carried, {tagsCreated} created"), Cancel + "Move anyway" (destructive-adjacent styling, matching existing confirm patterns). Derive exact markup from `client/src/components/ui/dialog.tsx` and an existing confirm dialog — match, don't invent.

- [ ] **Step 3: Wire the scan-move path**

In `scan.tsx`'s move-mode mutation error handling: on `ApiError` with `status === 409` and `errors?.unlinked`, stash the pending move + consequences in component state and open the sheet; `onConfirm` re-sends with `confirm: true`; `onCancel` drops the pending move and stays in move mode. On success of ANY cross-property move (the response's `consequences` non-null), toast `Moved to the other property · N tags carried` and pass `unlinkedCount` into the carry store's recorded move.

- [ ] **Step 4: Undo wording**

In `carry-store.ts`, the recorded-move type gains `unlinkedCount?: number`. Where the undo completes (find the existing undo toast), when the recorded move has `unlinkedCount > 0`, the toast reads `Moved back · unlinked accessories were not restored`.

- [ ] **Step 5: The `/move` property switcher**

In `move.tsx`: `useProperties()`; when `properties.length > 1`, render a segmented control (same visual pattern as the roll selector on the print settings page — `Button` variants in a row) above the bin picker, defaulting to the current property; the picker's data hooks take the selected propertyId. When 1 property, render exactly today's UI (regression: no new wrapper elements).

- [ ] **Step 6: Gates + screenshots**

```bash
cd client && npx tsc --noEmit && npm run build
```

Then harness-shoot `/move` at 390/768/1600 and the sheet (drive it with a fixture that 409s the first move attempt — add that to the scratchpad harness `server.js`, noting its fixtures return arrays AS `data`). Look at the PNGs.

- [ ] **Step 7: Commit**

`feat(client): cross-property move — consequence sheet, property switcher, undo wording`

---

## Task 5: Ship

- [ ] **Step 1: Full gates** — server `npm test` + `npm run lint`; client `npx tsc --noEmit` + `npm run build` + `npx vitest run`.
- [ ] **Step 2: PR** — body states: no migration; same-property moves regression-pinned; the confirm gate fires only on accessory breakage; printer scoping explicitly out of scope (link the spec).
- [ ] **Step 3: Merge on green.** No migration ordering applies to this branch. Verify the deployed bundle hash against a local build of master afterwards.

---

## Self-Review

**Spec coverage:** §1 fork → Tasks 2–3. §2 auth → Tasks 2 (route) and 3 (mirror). §3.1 tags → Task 1 (plan/create/repoint) exercised via 2–3. §3.2 accessories → Task 1 + subtree case in Task 3. §3.3 audit → Task 1, skip-single-audit in Task 3 Step 3. §3.4 free-riders → no code, asserted by regression pins. §4 gate → `needsConfirm` + 409 payload, Tasks 2–3; client re-send Task 4. §5 subtree → Task 3 rides existing transaction. §6 client → Task 4 (scan path, switcher, undo, sheet). §7 exclusions → nothing builds them. §8 tests → Tasks 1–4. Gap check: none found.

**Placeholders:** Task 2/3 Step 1 test lists are specified as assertion inventories with the fakeDb idiom named — deliberate, matching how Task 6 was specified in the previous plan (structural spec + named source to copy), which executed cleanly. All logic code is complete.

**Type consistency:** `opts.crossProperty = {srcPropertyId, destPropertyId}` identical in Tasks 2 and 3; `{item|container, consequences|null}` return shapes match what Task 4's client reads (`consequences` non-null ⇒ cross-property); the 409 `errors` payload `{unlinked, tagsCarried, tagsCreated}` is the same object `previewConsequences` returns and the sheet renders. `needsConfirm`'s home is resolved in Task 3 (move to the helper, update the import) with the ambiguity called out rather than left to drift.

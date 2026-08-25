# Cross-property move: design

**Goal:** moving an item or a container (with its full contents) to another
property works from every place a move already works — same buttons, same
scans — with a confirmation only when the move would break something.

**Status:** approved 2026-08-24 (verbal). Motivated by a real house move:
"Moving Tote 1" lives in a second property, and every move path refused with
"must be in the same property".

**No migration.** Every write lands on existing tables. There is no schema
change and therefore no migrate-before-merge ordering to arrange.

---

## 1. What changes conceptually

The same-property guards on `PATCH /api/items/_p_/:id/move` and
`PATCH /api/containers/_p_/:id/move` stop being refusals and become a fork:

- **Same property** — exactly today's behaviour, byte for byte.
- **Different property** — the move is allowed if the caller holds
  editor/owner in **both** properties, and it runs a reconciliation
  (§3) in the same transaction as the move itself.

Scope: **items, and containers with their entire subtree** (nested bins and
all items inside). Areas do not move; the destination of a cross-property
container move is an area (or container) in the other property.

## 2. Authorization

Roles are per-property, and the existing guard exists partly for tenancy: an
editor of property A must not be able to relocate entities into or out of a
property they have no role in.

The route already resolves the **source** property's role
(`resolvePropertyFromItem`/`FromContainer` → `resolvePropertyRole` →
`requireRole('owner','editor')`). For a cross-property destination, the
handler additionally resolves the caller's role in the **destination**
property and requires editor/owner there too. Failing that is a 403 naming
the destination property — not a 400 about "same property".

Membership scoping on every lookup remains the standard five-table join.

## 3. Reconciliation

Runs inside the move's transaction. "The moving set" is the entity itself
plus, for a container, every container and item in its subtree.

### 3.1 Tags — carried

For each `entity_tags` row attached to anything in the moving set:

1. Find a tag in the destination property with the same name
   (case-insensitive, matching the uniqueness the tags module already
   enforces); create it if absent.
2. Repoint the `entity_tags` row to the destination tag's ID.

Counts are reported in the response (`tagsCarried`, `tagsCreated`). Nothing
is lost; the two properties' tag lists remain independent.

### 3.2 Accessories — broken with notice, unless travelling together

For each `item_accessories` link touching an item in the moving set:

- **Both ends in the moving set** (same tote): the link survives untouched.
- **One end stays behind**: the link is deleted, and the response lists each
  broken link by name (`unlinked: [{itemId, name}]`).

Undo does **not** resurrect broken links (§6).

### 3.3 Audit — both sides

Two entries per moved entity root (not per subtree member): `moved-out`
logged against the source property and `moved-in` against the destination,
both carrying `{from, to}` container/area and property IDs. A member of
either property sees the movement in their activity feed.

### 3.4 Everything else — follows the entity for free

Files, condition snapshots, lending history, dates, product matches: all
item-scoped, reached through joins, no property column. They move with the
item with zero writes. A currently-lent item may move — the loan record
travels with it.

**Queued print jobs** reference entities by ID and render at claim time as
the queuing user. A job queued before a cross-property move renders the
entity's *new* location on an *old* property's printer — accepted; the label
is honest about where the thing now is, and re-queuing is one tap.

## 4. The confirm gate

A cross-property move that would **break accessory links** is refused with
`409` and a consequence payload unless the request carries `confirm: true`:

```json
{ "success": false, "message": "This move unlinks accessories",
  "consequences": { "unlinked": [{"itemId": 12, "name": "DeWalt battery pack"}],
                     "tagsCarried": 3, "tagsCreated": 1 } }
```

The client shows one sheet rendering that list; confirming re-sends with
`confirm: true`.

A cross-property move that breaks nothing (tags always carry; they are not
"breakage") proceeds **without** confirmation — a toast reports
`Moved to <property> · 3 tags carried`, keeping scan-scan-done rhythm
intact. Same-property moves are completely untouched.

## 5. Container subtree mechanics

The existing move already does the hard part: cycle check under FOR UPDATE
locks, effective-area derivation from the destination parent, and an
AREA_ID cascade across the whole subtree. Cross-property reuses all of it —
the destination area simply belongs to another property, and the cascade
re-areas the subtree into it. Items reference only CONTAINER_ID and follow
without a write.

The route guard change: instead of rejecting a destination area/parent in
another property, resolve which property it is in and apply §2.

## 6. Client

- **Scan-move (phone)** — the destination check becomes property-blind. TLY
  codes are globally unique, so scanning a bin at the new house just works.
  On a 409, the confirmation sheet lists what breaks; confirm re-sends.
- **`/move` (desk)** — the bin picker gains a property switcher, shown only
  when the user belongs to more than one property.
- **Carry banner / item page / container select** — no UI change; they call
  the same endpoints and inherit the behaviour.
- **Undo** — stays. Undoing a cross-property move is a second cross-property
  move back: tags re-carry (find-or-create is idempotent), but broken
  accessory links stay broken. The undo toast says so when links were
  broken: `Moved back · unlinked accessories were not restored`.

## 7. Out of scope

- **Printer visibility across properties.** The Pi stays bound to one
  property. The workflow this spec supports: label totes where the printer
  lives, move the records when the boxes physically move. "Print from either
  property" is its own future design.
- **Moving whole areas.** Containers and items only.
- **Merging properties** or bulk "move everything".

## 8. Testing

Server (`fakeDb` + `node:test`):
- same-property move: behaviour and SQL identical to today (regression)
- cross-property without destination role → 403; with → proceeds
- tag reconciliation: existing tag matched by name, missing tag created,
  entity_tags repointed; counts correct
- accessory: intra-set link survives; half-out link deleted and reported
- 409-without-confirm carries the consequence payload; confirm:true commits
- audit: moved-out and moved-in against the correct properties
- container subtree: nested containers and items re-area'd, tags across the
  whole subtree reconciled

Client: `tsc --noEmit` + build, plus harness screenshots of the confirmation
sheet and the `/move` property switcher at 390/768/1600.

## 9. Risks

- **Tag name collisions with different meanings** ("Fragile" meaning
  different things per property) merge silently. Accepted: names are the
  only identity tags have.
- **Reconciliation widens the move transaction.** Bounded: a tote's subtree
  is tens of entities, not thousands; all statements are indexed lookups.
- **The fakeDb test gap applies here too** — SQL semantics (find-or-create
  race, repoint correctness) get their first real exercise in staging/prod.
  Mitigated by the transaction and by the small blast radius of a wrong
  move (it is visible and reversible, unlike a wrong deletion).

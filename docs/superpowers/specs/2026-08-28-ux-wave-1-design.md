# UX Wave 1 — restore the loops: design

**Goal:** the four P0 fixes from the 2026-08-28 deep UX review — the ones
carrying most of the hundred-item session's wasted taps, scans, and waits.
Closes #221, #222, #223, #224.

**Status:** approved 2026-08-28 via the standing goal ("work the substantial
list to completion"). The review report (artifact "The Hundred-Item Session")
and the four issues are the requirements; this spec locks the design choices
the issues left open.

**Client-only except one doc file. No migration, no server change.**

---

## 1. #222 — Restore scan-once, move-many on `/move`

The biggest change. `/move` becomes a *station* you stay at, with two modes
that mirror how hands actually work at a shelf:

### Gather (while carrying, before a landing)

- Scanned **bin/area** code → the destination: land the whole carry (today's
  behaviour).
- Scanned **item/container** code not already in the carry → `addToCarry`
  (the orphaned store function finally gets its call site). Toast
  `Carrying 4`. The carry banner count updates. Scanning a code already
  carried → toast "Already carrying", no state change.

### Distribute (after a landing — the classic scan-scan-done)

- After a successful land, **stay on `/move`**. The destination stays
  **pinned**, shown as a persistent banner (`Moving to: Bin C — Done`).
- Scanned **item/container** code → move it to the pinned destination
  immediately (single-entity move, the existing mutation), toast with the
  running count (`Moved 3 to Bin C · Undo`).
- Scanned **bin/area** code → re-pin to the new destination (toast the
  change; nothing moves).
- **Done** (button, or Esc at a desk) → leave to the pinned destination's
  page, exactly where today's auto-navigation went. Leaving is now the
  explicit act; staying is the default.

### Supporting changes, all inside #222

- **Parallel batch:** `usePutDown`'s same-property fast path fires
  `Promise.allSettled` for the whole batch; only entities that 409 drop into
  the existing sequential confirm loop. Busy label becomes `Moving… N of M`.
- **"Apply to all remaining"** on `MoveConsequencesSheet`: a checkbox the
  batch loop consults, so ten linked items cost one decision, not ten.
- **Last-destination memory:** the most recent successful destination
  (session-only, in the carry store) renders as a one-tap default chip on
  `/move` when nothing is pinned yet.
- **Typed-code fallback:** the same `TLY-…` field `/scan` keeps, rendered
  under the scanner on `/move` — a damaged label must not force the picker
  cascade.
- **Undo** continues to work per landing; the distribute-mode per-item moves
  each get the standard toast undo (move it back).
- **CLAUDE.md**'s "Scan-Scan-Done Workflow" section is rewritten to describe
  this actual behaviour — the doc-drift the review caught ends here.

### Explicitly not in scope

Deleting `MoveItemDialog` (#229/#215), keyboard nav on the picker (#225).

## 2. #221 — "Scan in" routes to the page that reads its params

`container-detail.tsx:333-339` navigates to `/scan?containerId=…` which reads
nothing; the params are shaped for `/capture`, which pins the destination.
Fix: navigate to `buildCaptureUrl`-consistent `/capture` with the same
params. One line plus a route-guard test asserting the params survive into
capture's destination pin.

## 3. #223 — Optimistic capture commit

`commit()` currently awaits create, then awaits photo upload, then resets.
New shape:

1. On commit: append a **placeholder receipt** to the session list
   immediately (name, dest, `pending` marker), `resetDraft()` +
   `setPhase('photo')` immediately — the scanner is live again while the
   network works.
2. In the background: `createItem` → on success, patch the receipt with the
   real id, then fire the photo upload and the product-match queue (both
   already fire-and-forget-safe) with that id.
3. On create failure: the receipt flips to a `failed` state with a **Retry**
   affordance (re-submits the same draft payload) and a toast names the item.
   On upload failure: the receipt shows a small `photo failed · retry` note —
   the item exists; only the photo is missing.
4. The receipts list is the reconciliation surface — this is why it exists.
   Ordering within the session list is append-order and stable.

Invariants: the product-match gate still reads the vision state captured at
commit time (snapshot it into the background closure — the next item's scan
must not race it). Session receipts remain client-state only.

## 4. #224 — Home search survives Back

Home's four search-state pieces (`searchInput`/`searchQuery`, `selectedTagIds`,
`selectedCondition`, `selectedStatus`) move to `useSearchParams` with
`{replace: true}` on the debounced value — the exact pattern and reasoning
`search.tsx:56-74` already carries. Back from a result rehydrates query,
filters, and the searching view. Filters encode compactly (`tags=1,2`);
absent params mean the recents view, so plain `/` behaviour is unchanged.
The split-preview/keyboard gaps stay with #225 (wave 2).

## 5. Testing

- Vitest: carry-store gather/distribute transitions; queue of receipt
  states (pending → real id → failed → retry); Home URL-sync round-trip
  (the search.tsx param-merge bug class — merge, never rebuild).
- Harness driven checks: gather two items by scan then land; land then
  distribute two more scans to the pinned dest; Done exits to the dest page;
  #221's params surviving into capture's pin; commit resets to scan-ready
  BEFORE the create resolves (assert on network timing); Back from a Home
  result restoring the query.
- Regression pins: fine-desk `/move` picker flow unchanged; phone capture
  commit path produces identical server calls (order may differ, set may not).

## 6. Risks

- Optimistic commit changes failure UX: an item can "exist" in the receipts
  for seconds before the server confirms. The receipt marker + retry is the
  honest surface; the review judged the trade worth it and the pattern
  matches the queue/vision precedents.
- Distribute-mode moves are per-scan single moves — deliberately not batched;
  each is small and undo-able, and latency hides behind the next aim.
- `/move` gains modes; the pinned banner + Done make state legible. The
  screen-map artifact is NOT updated for wave 1 (the flows, not the boards,
  changed); noted for a later design pass if wanted.

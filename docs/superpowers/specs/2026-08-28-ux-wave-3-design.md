# UX Wave 3 — the session taxes and dead ends: design

**Goal:** the remaining findings from the 2026-08-28 deep UX review — scroll
restoration, the USB-scanner desk path, bulk delete/tag, and the
small-friction batch. Closes #229, #230, #231, #232.

**Status:** approved 2026-08-28 via the standing goal. The review report and
the four issues are the requirements; this spec locks the open choices.

**Client-only. No migration, no server change, no new dependency.** Bulk
operations loop existing single-entity endpoints sequentially (the Wave-2
bulk-clear precedent); the recycle ancestor-block gets a link to the
blocker, never an automatic cascade restore.

---

## 1. #232 — Scroll restoration, app-wide

`root-layout.tsx:232-235` scrolls the shared main container to top on every
pathname change. New behaviour:

- A per-route cache (module-level `Map<pathname, number>`, mirrored to
  `sessionStorage` under one key so reloads keep it) records the main
  container's `scrollTop`, written on scroll (throttled via rAF) or at
  minimum on route-leave.
- On pathname change: `useNavigationType() === 'POP'` → restore the cached
  value for the new pathname (after paint; 0 if none); PUSH/REPLACE → reset
  to top and clear that pathname's stale entry.
- Restoration is best-effort: if content is shorter than the cached offset
  (data changed), the browser clamps — no compensation logic.

## 2. #230 — ManualCreate: the USB-scanner desk path

Three fixes inside `capture.tsx`'s ManualCreate:

- **Barcode lookup + dupe check:** on Enter or blur of a non-empty barcode
  field, run the same product lookup + check-duplicate the camera flow's
  `handleCode` runs, populating name/fields identically and showing the
  same duplicate warning surface. Enter in the barcode field must NOT
  submit the form (USB scanners send Enter — preventDefault and lookup
  instead). A lookup in flight shows the field's existing spinner idiom if
  one exists, else disables submit until settled.
- **Focus return:** after a successful create, focus returns to the Name
  field (`pending` true→false transition or the optimistic submit path —
  whichever ManualCreate now uses post-Wave-1; the report must say).
- **Vision review parity:** pass the vision/review props into ManualCreate
  so a dropped photo's suggestions render the same review block and
  unconfirmed-name styling the camera flow shows; a confidently-applied
  name keeps the dashed "unconfirmed" treatment until touched.

## 3. #231 — Select mode: bulk Delete and bulk Tag

Container-detail's select-mode action bar gains:

- **Delete:** one confirm naming the counts by kind ("Delete 12 items and
  3 bins?" — recycle-bin language, it's a soft delete), then a sequential
  loop over the existing delete endpoints with per-entity error isolation
  (print-queue's pattern): continue on failure, truthful outcome toast
  (`Deleted N · K failed`), failed entities stay selected, succeeded leave
  the list via the usual invalidation.
- **Tag:** a Tag action opening the existing TagPicker in a batch mode:
  chosen tags are ADDED to every selected item (no removal semantics in
  batch — additive only, stated in the sheet copy). Containers in the
  selection are skipped with the count shown ("tags apply to items only").
  Sequential loop, same error isolation.

## 4. #229 — The small-friction batch

Six independent fixes:

1. **DestinationPicker empty-area state:** an inline "Create a container
   here" button opening the existing CreateContainerDialog seeded with the
   picker's current area; on create, `onPick` fires with the new container.
   Works identically inside ManualCreate (the desk dead end).
2. **QR resolve:** split 404 ("code doesn't exist") from other failures
   ("couldn't check — try again"); add a "Scan again" button beside "Go to
   home" on both.
3. **Alerts:** acting from a notification detail returns to the list (pass
   `{state:{from}}`, render a back link); bulk dismiss = client loop over
   the single-dismiss endpoint with a truthful outcome (mark-all-read stays
   as is).
4. **Recycle bin:** selectable rows (reuse the RuledRow selectable pattern)
   with bulk Restore looping the existing restore endpoint, per-entity
   isolation; an ancestor-blocked restore's error names AND LINKS the
   blocking ancestor (client renders the link from the error payload's id
   if present; if the payload lacks the id, show the name text only — no
   server change).
5. **Capture step dots:** the dots become a lightweight back control —
   tapping a previous step's dot returns there without touching the draft
   (place → identify; identify → photo keeps the photo). Forward taps
   remain inert.
6. **MoveItemDialog:** delete the component and its imports (unreachable
   since the move-station work; #215's disposition executed here).

## 5. Testing

- Vitest: scroll cache (POP restores, PUSH resets, sessionStorage
  round-trip); ManualCreate barcode Enter → lookup-not-submit, dupe warning,
  focus return, vision block rendering; bulk delete/tag loops (counts,
  partial failure, containers-skipped copy); picker empty-state create →
  onPick; QR 404 vs 500 rendering; alerts back-link + bulk dismiss; recycle
  bulk restore + blocked-link rendering; step-dot back transitions.
- Harness driven checks: scroll restore on a long container list (item 30 →
  detail → Back lands at item 30, measured scrollTop); USB-scanner
  simulation (type barcode + Enter at ManualCreate — name populates, no
  submit); bulk delete of a mixed selection with one rigged failure;
  the picker dead-end create at a desk; step-dot back preserving the photo.
- Regression pins: Waves 1+2 driven scripts re-run; PUSH navigation still
  lands at top.

## 6. Risks

- Scroll restoration touches every page via root-layout — the POP/PUSH
  split is the entire risk surface; the driven pass measures both.
- Bulk delete's per-entity isolation means partial failure leaves a mixed
  state; truthful counts + kept selection make it recoverable.
- Step-dot back must not create a state the phase machine can't leave —
  transitions limited to the two named, both already-valid phases.

# UX Wave 2 — the per-repetition taxes: design

**Goal:** the five P1s from the 2026-08-28 deep UX review — the costs paid
once per item, per match, or per label, hundreds of times a session.
Closes #219, #225, #226, #227, #228.

**Status:** approved 2026-08-28 via the standing goal ("work the substantial
list to completion"). The review report and the five issues are the
requirements; this spec locks the design choices the issues left open.

**Client-only. No migration, no server change, no new dependency.**

---

## 1. #219 — /scan follows the coarse-pointer fork

`scan.tsx` keys on bare `atDesk`; it is now the only camera surface that
gives a landscape iPad the typed-code page. Apply the exact predicate fork
shipped twice already (put-down, capture): `showScanner = !atDesk ||
coarse` via `useCoarsePointer`; scanner-first with the typed `TLY-…` field
rendered below it (one tap away, never removed); the typed field's
autofocus is dropped when `coarse` (no keyboard pop on arrival). Fine desk
unchanged: typed-first, autofocus kept. Tablet height cap uses the
flex-chain-safe pattern (`flex flex-col flex-1 min-h-0` unconditional,
clamp tablet-only) — the same corrected classes capture carries.

## 2. #227 — Instant-commit safety

Two same-family fixes:

- **Undo on capture's destination commit.** The create-success toast (fired
  from the optimistic receipt's background create) gains a sonner
  `action: {label: 'Undo'}`. Undo soft-deletes the created item via the
  existing recycle-bin delete endpoint and flips the receipt to a terminal
  `undone` state (row stays, struck-through name, no Retry). Rules: the
  action captures the created id in its closure (per-toast, same pattern as
  distribute undo); a photo upload or product-match still in flight for that
  item is NOT awaited or cancelled — the item is already soft-deleted, and a
  late photo/match against it is harmless (server tolerates; match rows for
  deleted items are invisible by the existing joins). Undo is single-shot:
  the handler guards on the receipt not already being `undone`.
- **Print dialog closes on success.** `label-print-dialog.tsx`: Print and
  Generate `onSuccess` handlers call `onOpenChange(false)` exactly as
  Add-to-queue already does — closing removes the re-enabled button that
  double-fires duplicate labels. No other dialog behaviour changes.

## 3. #228 — /matches: auto-advance + bulk-clear

- **Auto-advance:** resolve and dismiss `onSuccess` select the next pending
  row instead of `select(null)` — computed from the CURRENT `rows` at
  success time: the first `pending` row after the just-resolved row's index,
  wrapping to the top; none left → `select(null)` (empty placeholder is then
  correct). Phone gets the same behaviour (detail view advances in place —
  no bounce to the list between matches).
- **Bulk-clear failed:** the list header shows `Clear N failed` when any
  `none`/`failed` rows exist; it loops the existing dismiss path client-side
  (sequential, reusing the single-row mutation), with a running
  `Clearing… i of N` label and a single outcome toast. No new endpoint.

## 4. #225 — Keyboard nav on every list surface

Wire the existing `use-keyboard-nav.ts` (/, j/k, Enter, Esc) + the
`onVisibleOrder` pattern from areas.tsx/structure-tree.tsx into:

1. **/matches** — j/k over rows (all statuses), Enter opens/selects, Esc
   clears selection. Composes with #228: auto-advance moves the highlight.
2. **container-detail** — one keyboard ring over the visible order of both
   lists (nested bins then items, as rendered); Enter navigates.
3. **Home results** — j/k over search results, Enter opens the item;
   `/` focuses the search input (already the hook's contract).
4. **DestinationPicker** — j/k over the bin list, Enter picks. The picker
   renders inside dialogs/sheets: keys bind only while it is mounted and
   scoped to it (the hook's existing focus-scoping); Esc keeps its
   dialog-close meaning (picker never swallows it).

Invariants (the hook already enforces; the wiring must not break them):
keys are inert while ANY input/textarea has focus — a USB scanner typing
into a focused field never collides with j/k; highlight follows
`onVisibleOrder` so filtering/searching re-ranks the ring; no keyboard
UI is rendered on coarse-pointer-only surfaces (the hook is harmless
there, and phones simply never fire the keys).

## 5. #226 — In-page camera for the photo step

Capture step 1's `<input capture="environment">` becomes an embedded live
preview with an in-page shutter — the OS app-switch disappears.

- **New component `photo-camera.tsx`** (sibling of camera-scanner.tsx,
  reusing its stream-lifecycle idiom): `getUserMedia({video: {facingMode:
  'environment'}})`, live `<video>` fill, one shutter button. Shutter draws
  the current frame to a canvas at the video's native resolution and emits
  a JPEG (quality 0.85) as a File — straight into the existing
  `acceptPhotoFile` path. No confirm step (a confirm re-adds the tap the
  feature exists to remove); the identify phase's existing thumbnail is the
  review surface, and the X/retake affordances there are unchanged.
- **Fallback:** `getUserMedia` absent, or the permission denied → the
  current `<input capture>` button renders instead (same handler), plus the
  desk drop-zone path stays untouched. The fallback decision is made per
  mount and re-checked on a visible "Use system camera" link under the
  preview (escape hatch for a bad stream).
- **Lifecycle:** stream acquired when phase is `photo` and the page is
  visible; released on phase change, unmount, and `visibilitychange`
  hidden (the scanner components' existing discipline). The scanner phases
  (barcode/tag) keep camera-scanner.tsx — one camera at a time, released
  before the next acquires.
- **On-device caveat:** iPadOS/Safari behaviour must be confirmed on real
  hardware after deploy (same caveat every scanner surface shipped with);
  the driven pass uses the fake-camera harness.

## 6. Testing

- Vitest: /scan predicate fork (coarse → scanner-first, no autofocus);
  undo toast action (soft-delete fired with the right id, receipt →
  `undone`, single-shot); print dialog closes on both successes (and the
  double-fire is impossible once closed); matches auto-advance (middle,
  wrap, last-one → null) + bulk-clear loop (counts, partial-failure toast);
  keyboard ring order on container-detail (bins-then-items) and picker
  Enter-picks; photo-camera shutter emits a File into acceptPhotoFile and
  the fallback renders when getUserMedia rejects.
- Harness driven checks: tablet /scan shows the camera scanner-first with
  typed field below; phone capture full loop through the in-page shutter
  (fake camera) — commit still produces the master-identical request set
  with the photo attached; undo a commit and see the item in the recycle
  bin fixture call; /matches keyboard sitting: resolve → highlight advances
  → Enter opens next; print dialog closes after Print.
- Regression pins: fine-desk /scan byte-identical behaviour (typed-first,
  autofocus); phone /move and capture flows from Wave 1 untouched (their
  suites already pin them).

## 7. Risks

- The in-page camera is the largest UI change; the per-mount fallback and
  the "Use system camera" escape hatch bound the failure mode to "as bad
  as today", and the OS-input path stays fully wired.
- Keyboard wiring touches four surfaces; the hook's focus-scoping is the
  guard rail, and each surface's wiring is mechanical (visible order +
  Enter handler).
- Undo-after-create interacts with in-flight photo/match work; the spec
  rules it non-blocking by design (soft-delete tolerates late arrivals).

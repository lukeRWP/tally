# Tablet capture: design

**Goal:** an iPad in landscape gets the full photo → barcode → bin capture
flow — the product-scanning experience a tablet's camera is for — while a
mouse-and-webcam desk keeps the manual form, untouched.

**Status:** approved 2026-08-25 (verbal).

**No migration, no server change.** Client-only.

---

## 1. The problem

Chrome is chosen by how the device is held: `useLayoutMode()` returns
`'sidebar'` at `(min-width: 1024px) and (orientation: landscape)`. That is
right for chrome — an iPad in landscape wants the sidebar and the split
views. But `capture.tsx` reuses the same answer for *input modality*:
`atDesk` swaps the entire three-step camera flow for the one-screen
`ManualCreate` form. So a landscape iPad — a device with a rear camera,
held at a shelf — can only type.

The sidebar already knows better: its Scan entry gates on `useHasCamera()`
with a comment noting the rail "also serves iPad landscape, which very much
has one." The pages never got the same nuance.

## 2. The detector — and the trap it avoids

`useHasCamera()` alone cannot be the gate: **every iMac and MacBook has a
webcam**, pointed at the operator's face. Camera-presence would hand the
capture flow to exactly the machines the desk form was built for.

The honest tablet signal is the **primary pointer**:

- New hook `client/src/hooks/use-coarse-pointer.ts` —
  `matchMedia('(pointer: coarse)')` with a change listener, mirroring
  `use-layout-mode.ts`'s structure and comment style.
- "Tablet" is a fact derived locally in `capture.tsx`:
  `const tablet = atDesk && coarsePointer;`

`useLayoutMode()`'s contract does not change. Every other `=== 'sidebar'`
call site (item detail split, `/matches`, `/move`, the sidebar itself) keeps
treating landscape-iPad as desk chrome, which remains correct — those are
layout decisions, not input decisions.

Convertibles report the *primary* pointer: a Surface with its keyboard
attached counts as fine-pointer and gets the form. That is the right answer,
not a limitation.

## 3. Capture becomes a three-way branch

| Device | Experience | Change |
|---|---|---|
| Phone (bottom-nav chrome) | Three-step camera flow | none |
| Desk, fine pointer | `ManualCreate` form | none |
| Desk, coarse pointer (tablet) | **Three-step camera flow**, wide layout | new |

The tablet branch renders the same step components the phone uses — same
draft object, same commit path, same product-match gate and pending chip —
with two layout accommodations:

1. Steps stay centered at their existing `max-w-lg`; the wide screen gets
   whitespace, not stretched controls.
2. The camera viewport gets an explicit height cap. `html5-qrcode` sizes
   video by width only (the portrait-stream blowup from the responsive
   pass); a landscape tablet stream constrained to the column width plus a
   `max-h` cannot take over the page.

## 4. Switching modes

- In the tablet camera flow's header: a **"Type it instead"** action that
  swaps to `ManualCreate`.
- In `ManualCreate`, only when `tablet`: a mirror **"Use camera"** action
  back into the three-step flow.
- Mode is component state, session-only. Every cold open of `/capture` on a
  tablet starts in the camera flow (the decided default). No persistence.
- The draft survives the switch in both directions — a photo taken before
  switching stays attached; a name typed in the form stays when switching
  back. Same `draft`, different editors.
- The fine-pointer desk sees neither switch; its form is byte-identical to
  today.

## 5. Out of scope

- **`/scan` at desk chrome** stays the typed-code page (USB readers are
  keyboards). Explicitly scoped out by the user; the capture flow's own
  step-3 bin scanner covers the shelf workflow on tablets.
- No change to phone capture, `ManualCreate`'s internals, the vision
  identify/product-match pipeline, or the server.
- No persistence of the mode choice ("remember last" was considered and
  not chosen).

## 6. Testing

- `npx tsc --noEmit` and `npm run build` from `client/` (no client ESLint).
- Harness screenshots, dark, of `/capture`:
  - tablet landscape 1024×768 and 1194×834 — camera flow renders, steps
    centered, viewport capped (fake-camera technique from the scanner-layout
    notes; the harness cannot grant a real camera).
  - 1600×1000 fine-pointer — `ManualCreate`, pixel-identical to today
    (regression).
  - phone 390×844 — unchanged (regression).
- The coarse-pointer branch is exercised in Playwright via context options
  (`hasTouch`, or CDP touch emulation) — state plainly in the report if the
  harness cannot emulate it, rather than claiming coverage.

## 7. Risks

- **`pointer: coarse` in the harness** may need explicit emulation flags;
  if Playwright's defaults report fine-pointer for a tablet-sized viewport,
  the shots must force it or the tablet branch silently never renders in
  verification.
- **The barcode step on iPad Safari**: html5-qrcode is already in
  production on iPhones; the same engine on iPadOS is the expected-boring
  case, but it has never been exercised there. First real use is the test.
- Small: the mode switch introduces one new piece of state to `capture.tsx`,
  which is already the largest page in the app. The branch must stay a
  render-time fork, not a second copy of the flow.

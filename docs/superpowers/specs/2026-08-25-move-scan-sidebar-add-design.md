# Move-scan on tablets + sidebar container creation: design

**Goal:** two entry-point gaps found in real iPad use — the move flow's
destination can be *scanned* on a tablet instead of picked from a list, and
the sidebar's ADD can create a *container*, not just an item.

**Status:** approved 2026-08-25 (verbal), from live usage — the user stood
with a carried entity and a camera, facing a dropdown.

**Client-only. No migration, no server change, no new dependency**
(`@radix-ui/react-dropdown-menu` is already installed, just unwrapped).

---

## 1. Scan the move destination on tablets

### What exists

`put-down.tsx` already renders the full `TagScanner` — pause-on-confirm,
batch semantics, everything — gated `!atDesk`, with a comment written before
tablets had an identity: "leading with a viewfinder there shows a denial for
a device that has no camera to deny." Phones are scanner-first with "Pick a
bin from the list" as the fallback.

### The change

The gate becomes a three-way fork on the same predicates capture shipped:

```
const coarse = useCoarsePointer();
const showScanner = !atDesk || coarse;   // phone, or tablet landscape
```

- **Tablet (sidebar + coarse):** scanner-first — landing on `/move` with a
  carry shows the camera immediately, "Pick a bin from the list" below it.
  Same camera-first rule as capture; walking a tote to a labelled shelf is
  the shelf case.
- **Fine-pointer desk:** picker-only, exactly today.
- **Phone:** untouched.

The scanner's wrapper on tablets gets the height cap treatment — **with the
flex-chain classes** (`flex flex-col flex-1 min-h-0` unconditionally, the
`max-h` clamp tablet-only), the corrected pattern from the tablet-capture
Critical, using capture's bin-step clamp (`clamp(230px,36vh,280px)`).
Verified by `offsetHeight` measurement, not eyeballing.

The stale "no camera to deny" comment is rewritten to name the three-way
reality and point at `useCoarsePointer`'s rationale.

Everything else in the flow — the picker's property switcher, the batch
pause/resume, the reentrancy gate on `land()`, undo — is untouched; the
scanner path feeds the same `handleCode` the phone uses.

## 2. Sidebar ADD becomes a two-item menu

### What exists

The sidebar ADD navigates straight to `buildCaptureUrl(...)`. Container
creation is `EntityForm type="container"` (name, type dropdown, optional
description), always fed its `areaId` by the page it sits on. Radix
dropdown-menu is a dependency with no `ui/` wrapper.

### The change

1. **New primitive `client/src/components/ui/dropdown-menu.tsx`** — a thin
   Radix wrapper styled to tally's vocabulary: 2px radius, 1.5px ink border,
   `--color-card` surface, mono uppercase item labels, visible focus state,
   Escape closes menu only.
2. **The sidebar ADD** opens it with two items:
   - **Item** — `buildCaptureUrl(...)`, byte-identical destination to today.
   - **Container** — opens the container dialog over the current page.
3. **The container dialog from the sidebar** is `EntityForm
   type="container"` extended with a "where does it live" section, rendered
   only when the form has no seeded area:
   - Property: segmented buttons, only when the user belongs to >1 property
     (the established pattern from printing/put-down).
   - Area: a `select` of the chosen property's areas.
   - When the current route provides area context (area or container detail
     page), the section collapses to a one-line confirmation of the seeded
     location — behaviour on those pages is otherwise unchanged.
4. **On create**, navigate to the new container's detail page — the natural
   next actions (print its label, fill it) live there.

### Edge cases

- A property with **zero areas**: the area select is replaced by a short
  line — "No areas here yet — create one on the Areas page first" — with
  the submit disabled. Never an empty dropdown.
- The menu must not trap focus after navigation; ADD keeps its
  focus-visible ring; Escape closes the menu and nothing else.
- The **phone's centre ADD is explicitly out of scope** — one chrome at a
  time; thumb-reach economics deserve their own pass.

## 3. Out of scope

- Phone chrome changes of any kind.
- `/scan` page changes (still typed-code at fine-pointer desks).
- Creating areas or properties from the sidebar.
- Menu on the phone's centre ADD button.

## 4. Testing

- Gates: `npx tsc --noEmit`, `npx vitest run`, `npm run build` (no client
  ESLint); server suite untouched but run once to prove it.
- Harness, dark, with proven `pointer: coarse` emulation (assert matchMedia
  before any tablet shot — the tablet-capture discipline):
  - 1194×834 coarse `/move` with a carry: scanner-first with the picker
    button, cap **measured** binding at its clamp value.
  - 1600×1000 fine `/move`: picker-only, pixel-regression vs today.
  - 390×844 `/move`: untouched phone flow, scanner `offsetHeight` equal to
    master's (the yesterday-class regression check).
  - Sidebar ADD menu open; container dialog with the where-section (multi-
    property fixture), with seeded context (collapsed line), and the
    zero-areas state.
- The scanner-path move on tablet drives one real fixture move end-to-end
  (scan → land → toast), reusing the fake-camera technique.

## 5. Risks

- `EntityForm` gaining a conditional section risks disturbing its existing
  page-seeded uses — the section must key strictly on "no seeded area", and
  the area/container page regressions are part of the shot list.
- The dropdown primitive is new surface in the accessibility tree; keep it
  to Radix defaults plus styling — no custom focus management.
- Camera-first on `/move` assumes the destination is labelled; the picker
  button directly below is the unlabelled-bin path, one tap, same as the
  phone has lived with successfully.

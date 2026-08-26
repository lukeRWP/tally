# Tablet Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An iPad in landscape gets the full photo → barcode → bin camera capture flow, camera-first with a two-way switch to the manual form, while phones and fine-pointer desks stay byte-identical.

**Architecture:** One new hook (`useCoarsePointer`) mirrors `useLayoutMode`'s matchMedia pattern. `capture.tsx` derives `tablet = atDesk && coarse` and forks three ways at render time — the tablet branch renders the *existing* phone step components with per-step viewport height caps, plus a session-only mode switch into `ManualCreate` (which gains one optional prop). No second copy of the flow.

**Tech Stack:** React 18 + TS, Tailwind v4 tokens, `matchMedia`, html5-qrcode (already in use), vitest for the hook, Playwright + the fixture harness for visual verification.

Spec: `docs/superpowers/specs/2026-08-25-tablet-capture-design.md` (screen map linked in its header — the approved look for every board).

## Global Constraints

- Client-only. **No migration, no server change, no new dependency.**
- Client gates: `npx tsc --noEmit` and `npm run build` from `client/`. **There is no client ESLint.** Client vitest exists: `npx vitest run`.
- **Hooks before any early return** — a hook after a conditional return changes the hook count and React throws; this exact bug crashed the item page once.
- **`useLayoutMode()`'s contract does not change** and no call site outside `capture.tsx` is touched.
- **Phone and fine-pointer-desk output must be byte-identical to today.** The decision rule for every existing `atDesk` reference in `capture.tsx`: if it chooses *form vs flow*, re-point it to `showForm`; if it's a tablet-only addition, gate on `tablet`; never leave one on `atDesk` without deciding which it is.
- Tailwind v4 CSS custom-property tokens only; no raw hex.
- The mode-switch weights follow the approved screen map: "Type it instead" is **ghost**; "Use camera" is **bordered** (`outline`). Deliberate asymmetry — the road back to the tablet default earns the louder button.
- `master` is protected; branch `feat/tablet-capture`, PR flow, merge on green.

---

## File Structure

| File | Change |
|---|---|
| `client/src/hooks/use-coarse-pointer.ts` | **Create** — the primary-pointer hook |
| `client/src/hooks/use-coarse-pointer.test.ts` | **Create** — vitest, mocked matchMedia |
| `client/src/pages/capture.tsx` | **Modify** — three-way branch, switches, viewport caps |

Nothing else. `ManualCreate` lives inside `capture.tsx` (line ~1286), so its optional prop is part of the same file's change.

---

## Task 1: The coarse-pointer hook

**Files:**
- Create: `client/src/hooks/use-coarse-pointer.ts`
- Test: `client/src/hooks/use-coarse-pointer.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `useCoarsePointer(): boolean` and `COARSE_QUERY = '(pointer: coarse)'`. Task 2 calls the hook.

- [ ] **Step 1: Write the failing test**

Create `client/src/hooks/use-coarse-pointer.test.ts`:

```ts
// @vitest-environment jsdom
import { renderHook, act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useCoarsePointer, COARSE_QUERY } from './use-coarse-pointer';

function mockMatchMedia(initial: boolean) {
  let matches = initial;
  const listeners = new Set<(e: { matches: boolean }) => void>();
  const mql = {
    get matches() { return matches; },
    media: COARSE_QUERY,
    addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.delete(fn),
  };
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(mql));
  return {
    flip(next: boolean) { matches = next; listeners.forEach((fn) => fn({ matches: next })); },
    listenerCount: () => listeners.size,
  };
}

describe('useCoarsePointer', () => {
  it('reads the primary pointer on first render, no flash', () => {
    mockMatchMedia(true);
    const { result } = renderHook(() => useCoarsePointer());
    expect(result.current).toBe(true);
  });

  it('tracks change events (keyboard docked onto a convertible)', () => {
    const mq = mockMatchMedia(true);
    const { result } = renderHook(() => useCoarsePointer());
    act(() => mq.flip(false));
    expect(result.current).toBe(false);
  });

  it('unsubscribes on unmount', () => {
    const mq = mockMatchMedia(false);
    const { unmount } = renderHook(() => useCoarsePointer());
    expect(mq.listenerCount()).toBe(1);
    unmount();
    expect(mq.listenerCount()).toBe(0);
  });
});
```

If `@testing-library/react` is not already a devDependency, check what `capture.kill-switch.test.tsx` uses and follow its idiom instead — do not add a dependency for this test.

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && npx vitest run src/hooks/use-coarse-pointer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `client/src/hooks/use-coarse-pointer.ts`:

```ts
import { useEffect, useState } from 'react';

/**
 * Is the PRIMARY pointer a finger?
 *
 * This is the tablet detector behind capture's input-modality fork, and it is
 * deliberately not camera detection: every iMac and MacBook has a webcam,
 * pointed at the operator's face, so `useHasCamera()` would hand the camera
 * flow to exactly the machines the manual form was built for. The primary
 * pointer tracks what the hands are actually doing.
 *
 * Convertibles report the pointer that is primary RIGHT NOW: a Surface with
 * its keyboard docked is fine-pointer (form), undocked it is coarse (camera
 * flow). The change listener makes docking mid-session take effect without a
 * reload. That is the right answer, not a limitation.
 *
 * Mirrors use-layout-mode.ts: a hook, not a Tailwind variant, because
 * `pointer-coarse:` emits no CSS in this project's build (verified there),
 * and because exactly one capture experience should render.
 */
export const COARSE_QUERY = '(pointer: coarse)';

/** Read once, so the first paint is already correct rather than flipping. */
function currentlyCoarse(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(COARSE_QUERY).matches;
}

export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState<boolean>(currentlyCoarse);

  useEffect(() => {
    const mq = window.matchMedia(COARSE_QUERY);
    const onChange = () => setCoarse(mq.matches);
    // Re-read on mount: a dock/undock between the initial render and this
    // effect would otherwise stick until the next change event.
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return coarse;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd client && npx vitest run src/hooks/use-coarse-pointer.test.ts`
Expected: 3/3 PASS. Then `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add client/src/hooks/use-coarse-pointer.ts client/src/hooks/use-coarse-pointer.test.ts
git commit -m "feat(client): useCoarsePointer — the tablet detector that isn't camera detection"
```

---

## Task 2: The three-way capture branch

**Files:**
- Modify: `client/src/pages/capture.tsx` (the `atDesk` derivation ~line 202, the width line ~758, the progress row ~761, the fork ~867, the photo-input attrs ~908, the scanner call sites ~1091/1097, `ManualCreate` ~1286)

**Interfaces:**
- Consumes: `useCoarsePointer()` from Task 1.
- Produces: no new exports. The predicates other steps of this task share:
  - `const coarse = useCoarsePointer();` — called adjacent to `atDesk`, **above every early return**.
  - `const tablet = atDesk && coarse;`
  - `const [typedMode, setTypedMode] = React.useState(false);` — session-only, camera-first on cold open.
  - `const showForm = atDesk && (!coarse || typedMode);` — the single form-vs-flow predicate.

- [ ] **Step 1: Derive the predicates**

At ~line 202, replace the lone `atDesk` derivation with the block above (keeping `atDesk` itself). All four lines sit with the other hooks, above every conditional return.

- [ ] **Step 2: Audit every `atDesk` reference in the file**

`grep -n atDesk client/src/pages/capture.tsx`, and for each hit apply the Global Constraints decision rule:

- The **fork** (~867): `atDesk ?` → `showForm ?`.
- The **width** (~758): `atDesk ? 'w-full max-w-[900px]' : 'max-w-lg'` → `showForm ? 'w-full max-w-[900px]' : 'max-w-lg'` — the tablet camera flow keeps the phone's `max-w-lg` column (spec §3.1: whitespace, not stretched controls).
- The **progress/destination row** (~761): `atDesk && 'hidden'` → `showForm && 'hidden'` — the tablet camera flow shows step progress like a phone.
- The **photo input attrs** (~908): `{...(atDesk ? {} : { capture: 'environment' as const })}` → key on `showForm` — the tablet camera flow wants the rear camera; the form (any device) wants a file picker.
- The **drop-zone handlers and copy** (~915–933): these render inside markup reachable from the flow; key their form-vs-flow choices on `showForm` too. If any hit is genuinely dead code in one branch, say so in the report rather than silently leaving it.
- The **skip-button copy** (~944–946): `showForm`.

The test of a correct audit: with a fine pointer, every predicate evaluates exactly as `atDesk` did before (since `showForm === atDesk` when `!coarse`), so the fine-desk and phone render trees are unchanged by construction.

- [ ] **Step 3: The "Type it instead" switch**

In the flow's top region (the progress/destination row area), visible only in the tablet camera flow:

```tsx
{tablet && !showForm && (
  <Button
    variant="ghost"
    size="sm"
    className="ml-auto shrink-0"
    onClick={() => setTypedMode(true)}
  >
    <Keyboard className="w-4 h-4" />
    Type it instead
  </Button>
)}
```

(`Keyboard` from lucide-react, already the icon family.) Ghost weight per the approved map — leaving the default shouldn't shout.

- [ ] **Step 4: The "Use camera" switch on ManualCreate**

`ManualCreate` gains one optional prop, `onUseCamera?: () => void`, rendered in its header row only when present:

```tsx
{onUseCamera && (
  <Button variant="outline" size="sm" className="shrink-0" onClick={onUseCamera}>
    <Camera className="w-4 h-4" />
    Use camera
  </Button>
)}
```

The call site passes it only for tablets: `onUseCamera={tablet ? () => setTypedMode(false) : undefined}`. Bordered weight per the map. With the prop absent (fine desk), `ManualCreate`'s output is unchanged.

- [ ] **Step 5: Viewport height caps**

At the three camera surfaces, add a cap **only when `tablet`** (phone stays exactly as-is). Wrap each in (or add to its existing container) a conditional class:

- Photo step viewfinder region: `tablet && 'max-h-[clamp(260px,50vh,420px)] overflow-hidden'`
- `ProductScanner` (~1091) wrapper: `tablet && 'max-h-[clamp(240px,38vh,300px)] overflow-hidden'`
- `TagScanner` (~1097) wrapper: `tablet && 'max-h-[clamp(230px,36vh,280px)] overflow-hidden'`

The clamp bounds are the approved screen map's per-step range (260–420 across 768px- and 834px-tall tablets); vh flexes them between the two device heights. html5-qrcode sizes video by width only, so the cap is what keeps a landscape stream from taking over the page.

- [ ] **Step 6: The draft survives the switch**

No code should be needed — `draft` state lives above both branches — but verify by reading: nothing in the switch path resets `draft`, `dest`, or the photo. If a reset exists on branch change, remove it for the switch case and say so in the report.

- [ ] **Step 7: Gates**

```bash
cd client && npx tsc --noEmit && npx vitest run && npm run build
```

Expected: clean, all existing tests (including `capture.kill-switch.test.tsx`) still pass.

- [ ] **Step 8: Commit**

```bash
git add client/src/pages/capture.tsx
git commit -m "feat(client): tablet landscape gets the camera capture flow, camera-first"
```

---

## Task 3: Visual verification

**Files:** none in the repo (harness scratch only). The harness lives at `/private/tmp/claude-501/-Users-luketurner-dev/41f754c2-af9e-42be-9f4d-1cb84d238e63/scratchpad/uiharness/` and serves `client/dist` at http://localhost:4178.

- [ ] **Step 1: Rebuild and baseline**

`cd client && npm run build`. Shoot the two regression boards from **master's** build first if no pre-branch shots exist (`git stash` or a worktree build), else reuse existing shots: fine-desk `/capture` at 1600×1000 and phone at 390×844.

- [ ] **Step 2: Prove the pointer emulation before trusting any tablet shot**

In the Playwright script, create the tablet context with `browser.newContext({ viewport: {width: 1194, height: 834}, hasTouch: true, colorScheme: 'dark' })`, then **assert** before shooting:

```js
const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
if (!coarse) { /* fall back to CDP: */
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  // re-assert; if STILL false, abort and report plainly — do not ship shots
  // of a branch that never rendered.
}
```

A tablet shot taken while `(pointer: coarse)` is false silently renders the desk form and proves nothing — the assert is the difference between verification and theatre.

- [ ] **Step 3: Fake the camera** (scanner-layout memory technique)

Before the page loads (`context.addInitScript`), patch `navigator.mediaDevices.getUserMedia` to return `canvas.captureStream(30)` from a canvas driven by **`setInterval`, not rAF** (rAF throttles to zero unfocused and the video sits at 0×0), returning a **fresh stream per call** (`scanner.stop()` ends tracks; a shared stream is dead by the second scanner).

- [ ] **Step 4: Shoot the matrix, then look**

Dark scheme throughout:
- 1194×834 coarse: photo step, barcode step (drive past photo), bin step, and the form after tapping "Type it instead" (then "Use camera" back — assert the typed name survived).
- 1024×768 coarse: barcode step (the tightest board).
- 1600×1000 fine: `ManualCreate`, compared against the Step-1 baseline — no switch present, layout unchanged.
- 390×844: phone flow, compared against baseline.

**Read every PNG.** Compare against the approved screen map boards. Anything cramped, clipped, or off-map is a fix in Task 2's code, not a caveat in the report.

- [ ] **Step 5: Commit any fixes** from looking, re-shoot, and write the verification summary into the task report.

---

## Task 4: Ship

- [ ] **Step 1: Full gates** — `cd client && npx tsc --noEmit && npx vitest run && npm run build`; server suite untouched but run `cd server && npm test` once to prove it.
- [ ] **Step 2: PR** — body states: client-only, no migration; the detector (coarse pointer, not camera presence, and why); phone and fine-desk regression-verified byte-identical; link the spec and the screen map artifact; note the iPadOS html5-qrcode first-real-use caveat from spec §7.
- [ ] **Step 3: Merge on green.** Verify the deployed bundle hash against a local build of master afterwards.

---

## Self-Review

**Spec coverage:** §2 detector → Task 1 (with the iMac-webcam reasoning in the hook comment). §3 three-way branch + both accommodations → Task 2 Steps 1–2, 5. §4 switches, session-only, camera-first, draft survival → Task 2 Steps 3, 4, 6. §5 exclusions → no task touches `/scan`, other pages, or the server. §6 testing → Tasks 3 (including the coarse-emulation proof and fake camera) and 4. §7 risks → Task 3 Step 2 (emulation), PR body (iPadOS caveat), Task 2's render-time-fork constraint (Global Constraints).

**Placeholders:** none — every code step carries real code; the two "say so in the report" branches (dead `atDesk` hits, draft-reset discovery) are explicit report obligations, not deferred work.

**Type consistency:** `useCoarsePointer(): boolean` + `COARSE_QUERY` are consumed by name in Task 2; `showForm`/`tablet`/`typedMode` are defined once in Task 2 Step 1 and referenced identically in Steps 2–5; `onUseCamera?: () => void` matches its call site. The byte-identity claim is structural: `showForm === atDesk` whenever `!coarse`, so unchanged devices take unchanged branches.

**Known judgment call:** the clamp bounds in Task 2 Step 5 are the map's values translated to vh-flexed ranges; if the Task 3 look shows a step scrolling at 1024×768, tighten the clamp minimum in code and note it — the map's intent (every step one screen tall) governs over the literal pixel numbers.

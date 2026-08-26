# Move-Scan + Sidebar Container Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tablets scan the move destination instead of picking from a list, and the sidebar's ADD creates containers as well as items.

**Architecture:** Feature 1 is a one-predicate fork: put-down's existing `TagScanner` (pause-on-confirm already wired) un-gates on `!atDesk || coarse`, with capture's corrected flex-chain-safe cap. Feature 2 is three composable pieces: a styled Radix dropdown primitive (dependency already installed), a `CreateContainerDialog` owning the where-does-it-live section, and two generic props on `EntityForm` so page-seeded uses are untouched.

**Tech Stack:** React 18 + TS, `@radix-ui/react-dropdown-menu` (installed, unwrapped), TanStack Query hooks (`useAreas`, `useCreateContainer`, `useContainer`), `useCoarsePointer` (shipped), TagScanner, vitest + harness.

Spec: `docs/superpowers/specs/2026-08-25-move-scan-sidebar-add-design.md`

## Global Constraints

- Client-only. **No migration, no server change, no new dependency.**
- Client gates: `npx tsc --noEmit`, `npx vitest run`, `npm run build` from `client/`. **No client ESLint.**
- **Hooks before any early return** — the hook-count crash class.
- **Fine-pointer desks and phones byte-identical** on the move flow: with a fine pointer `showScanner === !atDesk`, so unchanged devices take unchanged branches. The phone scanner's `offsetHeight` must be MEASURED equal to master's (the yesterday-class regression check).
- The cap wrapper carries `flex flex-col flex-1 min-h-0` UNCONDITIONALLY plus the clamp tablet-only — the corrected pattern from tablet-capture's Critical (commit `700618b`); a classless-on-phone wrapper collapses the scanner.
- Tailwind v4 tokens only. Menu/dialog styling speaks tally's vocabulary: 2px radius, 1.5px ink borders, mono uppercase tracked labels.
- `EntityForm`'s existing page-seeded uses (area-detail, container-detail) must not change behaviour — new props are optional with inert defaults.
- `master` protected; branch `feat/move-scan-sidebar-add`; PR flow, merge on green.

---

## File Structure

| File | Change |
|---|---|
| `client/src/pages/put-down.tsx` | **Modify** — scanner fork + cap + comment rewrite |
| `client/src/components/ui/dropdown-menu.tsx` | **Create** — styled Radix wrapper |
| `client/src/components/inventory/create-container-dialog.tsx` | **Create** — dialog + where-section |
| `client/src/components/inventory/create-container-dialog.test.tsx` | **Create** — vitest for the where-section states |
| `client/src/components/inventory/entity-form.tsx` | **Modify** — `extraFields?`, `submitDisabled?` |
| `client/src/components/layout/root-layout.tsx` | **Modify** — ADD opens the menu |

---

## Task 1: Scan the move destination on tablets

**Files:**
- Modify: `client/src/pages/put-down.tsx` (imports ~line 15, `atDesk` ~line 60, the scanner block ~lines 414–431)

**Interfaces:**
- Consumes: `useCoarsePointer()` from `@/hooks/use-coarse-pointer` (shipped in tablet-capture).
- Produces: no exports; the predicates `coarse` and `showScanner = !atDesk || coarse`.

- [ ] **Step 1: Derive the predicates**

Next to `const atDesk = useLayoutMode() === 'sidebar';` (above every early return):

```tsx
const coarse = useCoarsePointer();
// Scanner where a rear camera plausibly exists: phones, and tablets in
// landscape (sidebar chrome + coarse pointer — see use-coarse-pointer.ts
// for why camera-presence is NOT the test). Fine-pointer desks keep the
// picker-only flow.
const showScanner = !atDesk || coarse;
```

Add the import: `import { useCoarsePointer } from '@/hooks/use-coarse-pointer';`

- [ ] **Step 2: Re-gate the scanner with the flex-safe cap**

Replace the `!atDesk && (<TagScanner …/>)` block (keeping every existing prop and its comments verbatim) with:

```tsx
          {/* Scanner-first wherever a rear camera plausibly exists: phones,
              and tablets in landscape. Fine-pointer desks stay picker-only —
              the earlier "no camera to deny" reasoning was written before
              tablets had an identity; useCoarsePointer is that identity.
              The wrapper's flex classes are unconditional ON PURPOSE: the
              scanner's own flex-1 needs a flex ancestor in the step's sizing
              chain, and a classless-on-phone wrapper collapses it (the
              tablet-capture Critical). The clamp binds on tablets only. */}
          {showScanner && (
            <div className={cn('flex flex-col flex-1 min-h-0', atDesk && coarse && 'max-h-[clamp(230px,36vh,280px)] overflow-hidden')}>
              <TagScanner
                // Paused while a confirm sheet is up — the decode loop otherwise
                // keeps running underneath it and a second scan would call
                // confirmPrompt again, stomping the paused batch's resolver.
                isActive={!pendingConfirm}
                label={pendingConfirm ? 'Paused — resolve the prompt' : busy ? 'Moving…' : 'Scan tote/area tag'}
                onTag={handleCode}
                onClose={() => navigate(-1)}
              />
            </div>
          )}
```

The "Pick a bin from the list" button below stays exactly as it is — it is now the tablet's one-tap fallback as well as the phone's.

- [ ] **Step 3: Gates**

```bash
cd client && npx tsc --noEmit && npx vitest run && npm run build
```

Expected: all clean (no test covers put-down directly; the suite guards regressions elsewhere).

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/put-down.tsx
git commit -m "feat(client): tablets scan the move destination, picker one tap away"
```

---

## Task 2: Sidebar ADD menu + container creation

**Files:**
- Create: `client/src/components/ui/dropdown-menu.tsx`
- Create: `client/src/components/inventory/create-container-dialog.tsx`
- Test: `client/src/components/inventory/create-container-dialog.test.tsx`
- Modify: `client/src/components/inventory/entity-form.tsx` (props interface ~line 17, submit button, fields render)
- Modify: `client/src/components/layout/root-layout.tsx` (the ADD block, ~lines 60–72)

**Interfaces:**
- Consumes: `useProperties()`, `useAreas(propertyId)`, `useCreateContainer()` (returns `api.post<{container: Container}>`), `useContainer(id)` for route seeding, `EntityForm`.
- Produces:
  - `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuItem` from `ui/dropdown-menu`.
  - `<CreateContainerDialog open onOpenChange seedAreaId? seedAreaName? seedPropertyId? />`.
  - `EntityForm` gains `extraFields?: React.ReactNode` (rendered between the field list and the submit row) and `submitDisabled?: boolean` (AND-ed with its existing disable logic). Both optional; omitted = today's behaviour.

- [ ] **Step 1: The dropdown primitive**

Create `client/src/components/ui/dropdown-menu.tsx`:

```tsx
import * as React from 'react';
import * as RadixDropdown from '@radix-ui/react-dropdown-menu';
import { cn } from '@/lib/utils';

/**
 * Tally-voiced wrapper over Radix DropdownMenu. Radix owns focus, keyboard
 * and dismissal (Escape closes the menu and ONLY the menu); this file owns
 * nothing but paint — no custom focus management, ever.
 */
export const DropdownMenu = RadixDropdown.Root;
export const DropdownMenuTrigger = RadixDropdown.Trigger;

export function DropdownMenuContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof RadixDropdown.Content>) {
  return (
    <RadixDropdown.Portal>
      <RadixDropdown.Content
        sideOffset={6}
        className={cn(
          'z-50 min-w-[200px] rounded-[var(--radius-sm)] border-[1.5px] border-[var(--color-text)]',
          'bg-[var(--color-card)] p-1 shadow-lg',
          className,
        )}
        {...props}
      >
        {children}
      </RadixDropdown.Content>
    </RadixDropdown.Portal>
  );
}

export function DropdownMenuItem({
  className,
  ...props
}: React.ComponentProps<typeof RadixDropdown.Item>) {
  return (
    <RadixDropdown.Item
      className={cn(
        'flex min-h-[44px] cursor-pointer items-center gap-2 rounded-[2px] px-3',
        'font-mono text-xs font-bold uppercase tracking-[0.12em] text-[var(--color-text)]',
        'outline-none data-[highlighted]:bg-[var(--color-elevated)]',
        className,
      )}
      {...props}
    />
  );
}
```

- [ ] **Step 2: EntityForm's two inert props**

In `entity-form.tsx`: add to `EntityFormProps`:

```ts
  /** Rendered between the field list and the submit row — e.g. a location
      section a caller owns. EntityForm knows nothing about its contents. */
  extraFields?: React.ReactNode;
  /** AND-ed with the form's own validity — a caller's veto, never a grant. */
  submitDisabled?: boolean;
```

Render `{extraFields}` after the mapped fields, before the submit row; add `|| submitDisabled` to the submit button's `disabled` expression. Nothing else changes — both default to absent/false, so area-detail and container-detail render byte-identically.

- [ ] **Step 3: Write the failing dialog tests**

Create `create-container-dialog.test.tsx` (jsdom, `@testing-library/react`, mock the three hooks with `vi.mock`):

```tsx
// @vitest-environment jsdom
// Cases (write them fully, following capture.kill-switch.test.tsx's mocking idiom):
// 1. seeded (seedAreaId + seedAreaName given): renders the one-line location
//    confirmation, NO property buttons, NO area select.
// 2. unseeded, 1 property, areas present: no property buttons; area select
//    lists the areas; submit enabled once name+type set.
// 3. unseeded, >1 property: segmented property buttons render; switching
//    property resets the area choice.
// 4. unseeded, property with ZERO areas: shows the guidance line
//    ("No areas here yet — create one on the Areas page first"), area select
//    absent, submit disabled even with name+type filled.
// 5. successful create navigates to `/container/<id>` (mock useNavigate,
//    createContainer.mutateAsync resolving {container: {id: 77, …}}).
```

- [ ] **Step 4: Run to verify they fail**

Run: `cd client && npx vitest run src/components/inventory/create-container-dialog.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 5: The dialog**

Create `create-container-dialog.tsx`:

```tsx
import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { EntityForm } from '@/components/inventory/entity-form';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useAreas, useCreateContainer, useProperties } from '@/hooks/use-inventory';

interface CreateContainerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present when the current page already answers "where" — the section
      collapses to a confirmation line and these win over any selection. */
  seedAreaId?: number;
  seedAreaName?: string;
  seedPropertyId?: number;
}

export function CreateContainerDialog({
  open, onOpenChange, seedAreaId, seedAreaName, seedPropertyId,
}: CreateContainerDialogProps) {
  const navigate = useNavigate();
  const { data: properties } = useProperties();
  const createContainer = useCreateContainer();

  const [propertyId, setPropertyId] = React.useState<number | undefined>(seedPropertyId);
  const effectivePropertyId = seedPropertyId ?? propertyId ?? properties?.[0]?.id;
  const { data: areas } = useAreas(seedAreaId ? 0 : (effectivePropertyId ?? 0));
  const [areaId, setAreaId] = React.useState<number | undefined>(undefined);

  const seeded = seedAreaId != null;
  const effectiveAreaId = seedAreaId ?? areaId;
  const noAreas = !seeded && (areas?.length ?? 0) === 0;
  const showPropertyButtons = !seeded && (properties?.length ?? 0) > 1;

  function submit(data: Record<string, unknown>) {
    return createContainer.mutateAsync(
      { ...data, areaId: effectiveAreaId } as {
        name: string; type: string; description?: string; areaId: number;
      },
    )
      .then((res) => {
        toast('Container created');
        onOpenChange(false);
        navigate(`/container/${res.container.id}`);
      })
      .catch((err: Error) => { toast(err.message); throw err; });
  }

  const where = seeded ? (
    <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
      Goes in <span className="text-[var(--color-text)]">{seedAreaName}</span>
    </p>
  ) : (
    <div className="flex flex-col gap-2">
      <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
        Where does it live?
      </span>
      {showPropertyButtons && (
        <div className="flex flex-wrap gap-2">
          {properties!.map((p) => (
            <Button
              key={p.id}
              size="sm"
              variant={p.id === effectivePropertyId ? 'default' : 'outline'}
              onClick={() => { setPropertyId(p.id); setAreaId(undefined); }}
            >
              {p.name}
            </Button>
          ))}
        </div>
      )}
      {noAreas ? (
        <p className="text-xs text-[var(--color-text-muted)]">
          No areas here yet — create one on the Areas page first.
        </p>
      ) : (
        <select
          aria-label="Area"
          className="h-10 rounded-[var(--radius-sm)] border-[1.5px] border-[var(--color-border)] bg-[var(--color-card)] px-3 text-sm"
          value={areaId ?? ''}
          onChange={(e) => setAreaId(e.target.value ? Number(e.target.value) : undefined)}
        >
          <option value="">Pick an area…</option>
          {(areas ?? []).map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
      )}
    </div>
  );

  return (
    <EntityForm
      open={open}
      onOpenChange={onOpenChange}
      type="container"
      onSubmit={submit}
      isPending={createContainer.isPending}
      extraFields={where}
      submitDisabled={effectiveAreaId == null}
    />
  );
}
```

(Adjust `EntityForm`'s exact prop names for pending state to what the file uses — read it; area-detail passes `isPending={createContainer.isPending}`.)

- [ ] **Step 6: The sidebar menu**

In `root-layout.tsx`'s `Sidebar`, replace the ADD `<button>` block: the same styled element becomes the `DropdownMenuTrigger` (`asChild`), with:

```tsx
<DropdownMenu>
  <DropdownMenuTrigger asChild>
    {/* the existing button markup, unchanged classes, aria-label="Add" */}
  </DropdownMenuTrigger>
  <DropdownMenuContent align="start">
    <DropdownMenuItem onSelect={() => navigate(buildCaptureUrl(location.pathname))}>
      <Package className="w-4 h-4" /> Item
    </DropdownMenuItem>
    <DropdownMenuItem onSelect={() => setCreateContainerOpen(true)}>
      <Box className="w-4 h-4" /> Container
    </DropdownMenuItem>
  </DropdownMenuContent>
</DropdownMenu>
{/* rendered beside the nav, outside the menu */}
<CreateContainerDialog
  open={createContainerOpen}
  onOpenChange={setCreateContainerOpen}
  seedAreaId={routeSeed?.areaId}
  seedAreaName={routeSeed?.areaName}
  seedPropertyId={routeSeed?.propertyId}
/>
```

Route seeding (`routeSeed`), derived with hooks called unconditionally (the `?? 0`-with-`enabled` pattern from `container-preview.tsx`):
- `/area/:id` → that area (`useArea(areaIdFromPath ?? 0)` for its name/property).
- `/container/:id` → `useContainer(containerIdFromPath ?? 0)` → its `areaId` + area name from the breadcrumb.
- any other route → `undefined` (full where-section).

Icons: check what lucide icons the file already imports; `Package`/`Box` or the nearest already-in-use equivalents — match the file's set rather than adding near-duplicates.

- [ ] **Step 7: Run the tests, then all gates**

```bash
cd client && npx vitest run src/components/inventory/create-container-dialog.test.tsx
npx tsc --noEmit && npx vitest run && npm run build
```

Expected: 5/5 new, whole suite green, build clean.

- [ ] **Step 8: Commit**

```bash
git add client/src/components/ui/dropdown-menu.tsx client/src/components/inventory/create-container-dialog.tsx client/src/components/inventory/create-container-dialog.test.tsx client/src/components/inventory/entity-form.tsx client/src/components/layout/root-layout.tsx
git commit -m "feat(client): sidebar ADD menu — items as before, containers from anywhere"
```

---

## Task 3: Visual verification

**Files:** none in-repo. Harness at `/private/tmp/claude-501/-Users-luketurner-dev/41f754c2-af9e-42be-9f4d-1cb84d238e63/scratchpad/uiharness/` serving `client/dist` on :4178 (start it: `node server.js /Users/luketurner/dev/tally/client/dist 4178`; fixture routes return arrays AS `data`).

- [ ] **Step 1: Prove the pointer emulation** — context `hasTouch: true`, assert `matchMedia('(pointer: coarse)').matches` via `page.evaluate` BEFORE any tablet shot; CDP `Emulation.setTouchEmulationEnabled` fallback; abort and report if still false.
- [ ] **Step 2: Fake the camera** — `addInitScript` patching `getUserMedia` → `canvas.captureStream(30)`, canvas driven by `setInterval` (not rAF), fresh stream per call.
- [ ] **Step 3: The matrix, measured** (dark):
  - 1194×834 coarse `/move` with a fixture carry: scanner-first, picker button below; **measure** the wrapper's `offsetHeight` equals the clamp's computed value.
  - 390×844 `/move`: scanner present; **measure** `offsetHeight` equals master's value at this viewport (build master in a stash/worktree for the number, or read it from the tablet-capture task-3 report if recorded).
  - 1600×1000 fine `/move`: picker-only — no scanner in the DOM (`document.querySelector` assert, not just pixels).
  - Sidebar ADD menu open (1600): two items, tally-voiced.
  - Container dialog: unseeded multi-property (buttons + select), seeded from `/container/1` (confirmation line), zero-areas fixture (guidance, submit disabled).
  - Drive one end-to-end tablet move via the fake camera: scan a fixture tag → land → toast.
- [ ] **Step 4: Read every PNG.** Fix-and-reshoot anything off; commit fixes.

---

## Task 4: Ship

- [ ] **Step 1: Full gates** — client `tsc` + vitest + build; server `npm test` once (untouched but proven).
- [ ] **Step 2: PR** — body: client-only, no migration; the scanner fork's predicate and why fine desks are excluded; the menu + dialog; EntityForm's two inert props; link the spec; note the measured heights.
- [ ] **Step 3: Merge on green**; verify the deployed bundle hash against a local master build.

---

## Self-Review

**Spec coverage:** §1 fork/cap/comment → Task 1 (comment rewritten in the new block; cap flex-safe with clamp `230/36vh/280`). §2 primitive/menu/dialog/edge-cases → Task 2 (zero-areas = case 4 with submit veto; Escape-closes-menu-only is Radix default, asserted by not adding focus code; seeded collapse = case 1; navigate-on-create = case 5). §3 exclusions → no task touches phone ADD, `/scan`, or area/property creation. §4 testing → Tasks 3 (measured, proven emulation, e2e fake-camera move, EntityForm page regression via the seeded-dialog shot plus untouched-props argument) and 4. §5 risks → EntityForm props inert-by-default (Task 2 Step 2), Radix-defaults-only (Step 1 comment), camera-first fallback = the existing picker button (Task 1 Step 2).

**Placeholders:** Task 2 Step 3 lists test cases as specifications with the mocking idiom named — the pattern that executed cleanly twice in this repo's previous plans; all component/logic code is complete. One deliberate instruction to verify rather than assume: EntityForm's pending-prop name (Task 2 Step 5 note).

**Type consistency:** `CreateContainerDialog` props match its Task 2 Step 6 call site; `extraFields`/`submitDisabled` named identically in Steps 2 and 5; `showScanner`/`coarse` used only in Task 1; `res.container.id` matches `useCreateContainer`'s `api.post<{container: Container}>` shape.

import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { PackageOpen, List, Undo2, X, ArrowRight } from 'lucide-react';
import { TagScanner } from '@/components/scanner/tag-scanner';
import { DestinationPicker } from '@/components/inventory/destination-picker';
import { MoveConsequencesSheet } from '@/components/inventory/move-consequences-sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TitleBar } from '@/components/ui/title-bar';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { extractTlyCode } from '@/lib/tly';
import { useCarryStore, type CarriedItem, type PinnedTarget } from '@/store/carry-store';
import { usePutDown, type ConfirmPrompt } from '@/hooks/use-put-down';
import { useMoveItem, useMoveContainer, useProperties, type MoveConsequences } from '@/hooks/use-inventory';
import { cn } from '@/lib/utils';
import { useLayoutMode } from '@/hooks/use-layout-mode';
import { useCoarsePointer } from '@/hooks/use-coarse-pointer';

/**
 * Put it down — and then keep putting things down.
 *
 * Scanning is not one activity. Adding an item asks "what is this?" and wants a
 * product barcode; putting something away asks "where does this go?" and wants
 * a bin label. They were the same screen, so tapping Move on an item opened a
 * page offering to add an item and search a product catalogue — an answer to a
 * question nobody had asked.
 *
 * This screen has exactly one question, but it stays open for as long as you
 * are standing at the shelf. Two modes answer it:
 *
 *   GATHER     — while carrying, every scan either adds another thing to the
 *                load (an item/bin not already in hand) or lands the whole
 *                load (a bin/area).
 *   DISTRIBUTE — after a landing, the destination stays pinned. Every scan
 *                either moves one more thing straight there, or re-pins to a
 *                new destination. Leaving is the explicit act (Done); staying
 *                is the default.
 *
 * A product barcode is not an error in either mode — it is just the wrong
 * kind of answer, and is told so.
 */

interface ResolvedEntity {
  type: 'property' | 'area' | 'container' | 'item';
  id: number;
  name: string;
  exists: boolean;
}

/**
 * One entity's paused confirm, while usePutDown's batch loop awaits a
 * decision. Set by confirmPrompt (passed into the hook) and cleared by
 * decide() — the hook itself never renders anything, so this bridges its
 * "ask the user" step to this page's Dialog.
 */
interface PendingConfirm {
  entityName: string;
  index: number;
  total: number;
  consequences: MoveConsequences;
}

/**
 * A distribute-mode scan arrives with no known origin — unlike a pickUp,
 * which captures it from the page the load was gathered on, this is an
 * ad-hoc scan of something never added to the carry. The "standard toast
 * undo" this mode promises has to know where to send the thing BACK, so one
 * extra read buys that: the entity's own detail endpoint already returns
 * exactly enough (an item's current container, a container's parent or
 * area) to make the move reversible through the exact same lastMove/undo
 * machinery a landing uses. Failing quietly (empty object) is not a new
 * failure mode — an entity with no known origin was already a documented
 * "not reversible" case (see CompletedMove in the carry store); this is
 * just one more way to land there.
 */
async function resolveOrigin(entity: ResolvedEntity): Promise<Pick<CarriedItem, 'fromContainerId' | 'fromAreaId'>> {
  try {
    if (entity.type === 'item') {
      const { item } = await api.get<{ item: { containerId: number } }>(`/api/items/_x_/${entity.id}`);
      return { fromContainerId: item.containerId };
    }
    const { container } = await api.get<{ container: { parentContainerId: number | null; areaId: number } }>(
      `/api/containers/_x_/${entity.id}`,
    );
    return container.parentContainerId
      ? { fromContainerId: container.parentContainerId }
      : { fromAreaId: container.areaId };
  } catch {
    return {};
  }
}

export function PutDown() {
  const atDesk = useLayoutMode() === 'sidebar';
  const coarse = useCoarsePointer();
  // Scanner where a rear camera plausibly exists: phones, and tablets in
  // landscape (sidebar chrome + coarse pointer — see use-coarse-pointer.ts
  // for why camera-presence is NOT the test). Fine-pointer desks keep the
  // picker-only flow for GATHER's landing step.
  const showScanner = !atDesk || coarse;
  const navigate = useNavigate();
  const carried = useCarryStore((s) => s.carried);
  const lastMove = useCarryStore((s) => s.lastMove);
  const pinnedDest = useCarryStore((s) => s.pinnedDest);
  const lastDest = useCarryStore((s) => s.lastDest);
  const pinDest = useCarryStore((s) => s.pinDest);
  const clearPin = useCarryStore((s) => s.clearPin);
  const addToCarry = useCarryStore((s) => s.addToCarry);
  const clear = useCarryStore((s) => s.clear);
  const clearLastMove = useCarryStore((s) => s.clearLastMove);
  const { putDown, progress } = usePutDown();
  const moveItem = useMoveItem();
  const moveContainer = useMoveContainer();

  const gathering = carried.length > 0;
  const distributing = !gathering && !!pinnedDest;

  // Fine-pointer desks have no scanner to land on, so they still open
  // straight into the list. Coarse tablets DO have a scanner now (see
  // showScanner above) — defaulting them into the list too would silently
  // undo "landing on /move with a carry shows the camera immediately" from
  // this feature's own design (only the render fork was updated below; this
  // flag pre-dates it and was never taught about `coarse`).
  const [picking, setPicking] = React.useState(atDesk && !coarse);
  const [busy, setBusy] = React.useState(false);
  // Mirrors `busy` for the reentrancy guard inside land()/moveToPin (below).
  // Both are useCallbacks that do not — and should not — depend on `busy`
  // (they have no reason to be recreated when it flips), so reading the
  // STATE there would close over a stale value from whenever they were last
  // created. The ref is written alongside every setBusy call via
  // setBusyBoth and is always current.
  const busyRef = React.useRef(false);
  function setBusyBoth(value: boolean) {
    busyRef.current = value;
    setBusy(value);
  }
  const [pendingConfirm, setPendingConfirm] = React.useState<PendingConfirm | null>(null);
  // The loop that's paused lives inside usePutDown's Promise chain, not in
  // this component — this is the resume handle for it. The resolution
  // widened to carry applyToRest (the sheet's "apply to the rest of this
  // batch" checkbox) alongside the choice — see ConfirmPrompt.
  const decisionRef = React.useRef<((decision: { choice: 'confirm' | 'cancel'; applyToRest: boolean }) => void) | null>(null);
  // Set false in the SAME unmount cleanup that resolves a pending decision as
  // cancel (below) — land()/moveToPin check it after putDown resolves so
  // that an unmount mid-batch (browser Back while the confirm sheet is up, a
  // bottom-nav tap) can't still navigate the user forward or toast on a page
  // they've already left. completeMove (inside usePutDown) already ran by
  // then and is NOT gated on this — only the navigation/UI tail is.
  const mountedRef = React.useRef(true);

  // Distribute mode's per-scan "Moved N to X" toast needs a running total.
  // Never rendered, so it lives in a ref rather than state — there is no
  // reason to trigger a re-render for it.
  const runningCountRef = React.useRef(0);

  const pin = React.useCallback((dest: PinnedTarget) => {
    pinDest(dest);
    runningCountRef.current = 0;
  }, [pinDest]);

  // The property switcher only appears with more than one property — most
  // households have exactly one, and that case must render today's UI with
  // no new elements at all.
  const { data: properties } = useProperties();
  const [selectedPropertyId, setSelectedPropertyId] = React.useState(0);
  const showSwitcher = (properties?.length ?? 0) > 1;

  // The load's OWN property — derived from where it was picked up, exactly
  // the way DestinationPicker itself resolves a seeded area's property
  // (same endpoint, same shape). Needed here too so the switcher can default
  // to the CURRENT property instead of an arbitrary properties[0] (that was
  // the regression: a two-property user's ordinary same-property desk move
  // started in the wrong property), and so seedAreaId below is only handed
  // to the picker when the selected property actually matches the area it
  // names — undefined while unresolved, null once resolved-but-unknown (no
  // carried origin, or the lookup failed) so the properties[0] fallback
  // waits for it instead of racing it.
  const carriedFromAreaId = carried[0]?.fromAreaId;
  const [homePropertyId, setHomePropertyId] = React.useState<number | null | undefined>(undefined);
  React.useEffect(() => {
    if (!carriedFromAreaId) { setHomePropertyId(null); return; }
    setHomePropertyId(undefined);
    let cancelled = false;
    (async () => {
      try {
        const { area } = await api.get<{ area: { propertyId: number } }>(`/api/areas/_x_/${carriedFromAreaId}`);
        if (!cancelled) setHomePropertyId(area?.propertyId ?? null);
      } catch {
        if (!cancelled) setHomePropertyId(null);
      }
    })();
    return () => { cancelled = true; };
  }, [carriedFromAreaId]);

  React.useEffect(() => {
    if (selectedPropertyId) return;
    if (homePropertyId) { setSelectedPropertyId(homePropertyId); return; }
    if (homePropertyId === null && properties && properties.length > 0) {
      setSelectedPropertyId(properties[0].id);
    }
  }, [homePropertyId, properties, selectedPropertyId]);

  // The scanner callback is handed to the camera once, so it must not close
  // over a stale load.
  const carriedRef = React.useRef(carried);
  React.useEffect(() => { carriedRef.current = carried; }, [carried]);

  const bins = carried.filter((c) => c.kind === 'container').length;
  const items = carried.length - bins;
  const summary = carried.length === 1
    ? carried[0].name
    : [bins ? `${bins} ${bins === 1 ? 'bin' : 'bins'}` : null,
       items ? `${items} ${items === 1 ? 'item' : 'items'}` : null].filter(Boolean).join(' + ');

  // Bridges usePutDown's per-entity pause (a 409 mid-batch) to this page's
  // Dialog: the hook awaits the returned promise before resuming its loop,
  // and the sheet's Confirm/Cancel buttons (via decide(), below) resolve it.
  // Deliberately NOT gated on `busy` — busy covers the whole batch,
  // including the time this sheet is sitting open waiting on the user, and
  // disabling its buttons for that entire span would leave it unusable.
  const confirmPrompt: ConfirmPrompt = React.useCallback(
    (entity, index, total, consequences) =>
      new Promise((resolve) => {
        decisionRef.current = resolve;
        setPendingConfirm({ entityName: entity.name, index, total, consequences });
      }),
    [],
  );

  function decide(choice: 'confirm' | 'cancel', applyToRest: boolean) {
    decisionRef.current?.({ choice, applyToRest });
    decisionRef.current = null;
    setPendingConfirm(null);
  }

  // An unmount mid-pause (navigating away — the X below, a bottom-nav tap,
  // the browser back button — while the sheet is up) must not leave
  // usePutDown's loop awaiting forever: that is the exact stuck-carry
  // failure this whole round exists to kill, just triggered by navigation
  // instead of a network error.
  //
  // applyToRest is TRUE — not false. A batch with more than one entity
  // waiting on a decision pauses on the FIRST and, once resolved, the loop
  // immediately calls confirmPrompt again for the SECOND — but confirmPrompt
  // just sets state on a component that no longer exists, so that second
  // promise NEVER resolves and putDown hangs forever, completeMove never
  // runs, and every entity that already moved stays stuck showing as
  // carried. applyToRest:true takes the loop's OWN "apply to the rest of
  // this batch" path instead of prompting again: it skips this entity AND
  // every other one still waiting, then stops — no further prompts, no
  // hang. choice stays 'cancel': an unmount means we can no longer ask the
  // user anything, and confirming would commit a lossy cross-property move
  // nobody agreed to. Every skipped entity ends up back in `carried`;
  // completeMove (inside usePutDown) still reconciles whatever DID move
  // before the pause.
  React.useEffect(() => {
    mountedRef.current = true; // re-arm — StrictMode's remount runs setup again
    return () => {
      mountedRef.current = false;
      decisionRef.current?.({ choice: 'cancel', applyToRest: true });
      decisionRef.current = null;
    };
  }, []);

  const land = React.useCallback(async (dest: PinnedTarget) => {
    // One batch at a time, enforced HERE rather than at each entry point —
    // the camera (isActive/handleCode already gate it), the picker's
    // onPick (never gated at all — the gap this guard closes), and anything
    // added later all pass through this same function. A land() call while
    // one is already running (busyRef) or paused on a decision (decisionRef)
    // is dropped, not queued.
    if (busyRef.current || decisionRef.current) return;
    setBusyBoth(true);
    try {
      const result = await putDown(carriedRef.current, dest, confirmPrompt);
      // Unmounted while putDown was paused on a confirm (or just mid-flight)
      // — state reconciliation already happened inside putDown, but this
      // page is gone, so no toast for whoever isn't here to see it.
      if (!mountedRef.current) return;
      if (!result) {
        toast(`Already in ${dest.name}`);
        return;
      }
      const { moved, skipped, abortError, failedCount, crossProperty, tagsCarried } = result;

      // A landing pins the destination (see the store's completeMove/
      // recordMove — it writes the TRUE type, not this `dest`, since a
      // bins-only load landing on an area and an item load landing on that
      // same area resolve to different real places). Reset the running
      // count whenever a NEW landing succeeds, gather or not: distribute
      // mode's count is about THIS pin, not a lifetime total.
      if (moved.length > 0) {
        runningCountRef.current = 0;
      }

      if (moved.length === 0) {
        // Nothing landed — either every entity was declined at its confirm
        // sheet, or the sole entity in the batch hard-failed. Either way
        // there is nowhere to navigate to, and there never was — this
        // screen no longer navigates on success either (below).
        if (failedCount > 0) {
          toast.error(abortError instanceof Error ? abortError.message : 'Could not move it there');
        } else {
          toast('Nothing moved');
        }
        return;
      }

      // Truthful partial-outcome reporting: a batch is not all-or-nothing,
      // so its report can't collapse to "it worked" or "it didn't" either.
      // A hard failure alongside a real success used to hit the OLD
      // `if (aborted) { toast.error(...); return; }` branch first and
      // suppress the success half entirely — eleven moved, one failed, and
      // the toast said only "could not move it there," as if none had.
      if (failedCount > 0) {
        const total = moved.length + skipped.length + failedCount;
        const failureName = abortError instanceof Error ? abortError.message : 'a move failed';
        toast.error(
          `Moved ${moved.length} of ${total} · ${failedCount} failed (${failureName})`
          + (skipped.length > 0 ? ` · skipped ${skipped.length}` : ''),
        );
      } else if (skipped.length > 0) {
        toast.success(`Moved ${moved.length} · skipped ${skipped.length}`);
      } else if (crossProperty) {
        toast.success(`Moved to the other property · ${tagsCarried} tags carried`);
      } else {
        toast.success(
          moved.length === 1 ? `${moved[0].name} → ${dest.name}` : `${moved.length} moved → ${dest.name}`,
        );
      }
      // Stay. The destination is now pinned (see the store's completeMove/
      // recordMove) and rendered as a banner below — leaving is Done's job,
      // not a landing's.
    } catch (err) {
      if (!mountedRef.current) return;
      toast.error(err instanceof Error ? err.message : 'Could not move it there');
    } finally {
      setBusyBoth(false);
    }
  }, [putDown, confirmPrompt]);

  // Puts a set of entities back where they came from, and reports the
  // outcome — the mechanics shared by the whole-lastMove undo (below) and
  // each distribute-mode toast's OWN undo. Deliberately takes the items and
  // unlinkedCount as PARAMETERS rather than reading `lastMove` off the
  // store: distribute is rapid-fire, sonner stacks several ~4s toasts at
  // once, and `lastMove` is a single shared slot that the NEXT scan
  // overwrites before the FIRST toast's Undo is even clicked. A closure
  // that reads `lastMove` at click time reverses whatever is CURRENTLY
  // there, not the move the toast was actually about — reversing move B
  // into move A's origin. Every caller here passes its own captured record,
  // so which move gets reversed is fixed at the moment the toast is created.
  async function undoMove(items: CarriedItem[], unlinkedCount: number | undefined) {
    const reversible = items.filter((i) => i.fromContainerId || i.fromAreaId);
    try {
      await Promise.all(
        reversible.map((i) =>
          i.kind === 'container'
            ? moveContainer.mutateAsync(
                i.fromContainerId
                  ? { id: i.id, parentContainerId: i.fromContainerId }
                  : { id: i.id, parentContainerId: null, areaId: i.fromAreaId as number },
              )
            : moveItem.mutateAsync({ id: i.id, containerId: i.fromContainerId as number }),
        ),
      );
      const skipped = items.length - reversible.length;
      toast(
        unlinkedCount && unlinkedCount > 0
          ? 'Moved back · unlinked accessories were not restored'
          : skipped > 0
            ? `Put ${reversible.length} back — ${skipped} had no previous home`
            : 'Put back',
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not undo the move');
    }
  }

  // DISTRIBUTE mode's per-scan move: one entity, straight to the pin. Reuses
  // putDown wholesale rather than calling the move mutations directly — a
  // single-entity load is just a batch of one, so the exact same "already
  // there" no-op, 409-confirm-sheet, and lastMove/pinnedDest reconciliation
  // a landing gets apply here for free.
  const moveToPin = React.useCallback(async (entity: ResolvedEntity) => {
    if (!pinnedDest || busyRef.current || decisionRef.current) return;
    setBusyBoth(true);
    try {
      const origin = await resolveOrigin(entity);
      const load: CarriedItem[] = [{
        id: entity.id,
        name: entity.name,
        kind: entity.type === 'container' ? 'container' : 'item',
        ...origin,
      }];
      // pinnedDest already IS a {id, name, type} — the store carries the
      // true type now, so there is nothing to reconstruct here.
      const result = await putDown(load, pinnedDest, confirmPrompt);
      if (!mountedRef.current) return;
      if (!result) {
        toast(`Already in ${pinnedDest.name}`);
        return;
      }
      const { moved, aborted, abortError, unlinkedCount } = result;
      if (moved.length === 0) {
        toast.error(
          aborted
            ? (abortError instanceof Error ? abortError.message : 'Could not move it there')
            : 'Not moved',
        );
        return;
      }
      runningCountRef.current += moved.length;
      // Captures THIS move's own `moved`/`unlinkedCount` right now — not a
      // ref to the shared `lastMove`, which a later scan can overwrite
      // before this toast is dismissed or clicked. See undoMove's comment.
      toast.success(`Moved ${runningCountRef.current} to ${pinnedDest.name}`, {
        action: { label: 'Undo', onClick: () => { void undoMove(moved, unlinkedCount); } },
      });
    } catch (err) {
      if (!mountedRef.current) return;
      toast.error(err instanceof Error ? err.message : 'Could not move it there');
    } finally {
      setBusyBoth(false);
    }
  }, [pinnedDest, putDown, confirmPrompt]);

  // Every code the scanner (or the typed fallback below) decodes passes
  // through here, and this is the whole station: which mode is live decides
  // what a code means.
  //
  //   GATHER (carrying)     bin/area  -> land the whole carry (unchanged)
  //                          item/bin -> add to the carry
  //   DISTRIBUTE (pinned)    bin/area  -> re-pin, nothing moves
  //                          item/bin -> move it to the pin now
  //
  // One batch at a time is the rule: while a confirm is pending, TagScanner
  // is handed isActive={false} below, which tears the camera down — but that
  // is a prop change React has to render and commit, not instant. decisionRef
  // is set synchronously (inside confirmPrompt's Promise executor, which the
  // spec runs synchronously) the moment a pause begins, so checking it here
  // closes the gap: a decode that sneaks in before the camera actually stops
  // is dropped, not queued, and never overwrites the paused batch's resolver.
  const handleCode = React.useCallback(async (code: string) => {
    if (decisionRef.current) return;
    try {
      const entity = await api.get<ResolvedEntity>(
        `/api/labels/_x_/resolve/${encodeURIComponent(code)}`,
      );
      if (!entity?.exists) {
        toast.error(`Code ${code} is not in your inventory`);
        return;
      }

      if (carriedRef.current.length > 0) {
        // GATHER — the load is still being built. `entity` stays typed as
        // the whole ResolvedEntity union even inside this narrowed branch
        // (TS narrows a property READ like `entity.type`, not the object's
        // assignability elsewhere), so land() takes a literal built from
        // the narrowed `entity.type` read rather than `entity` itself.
        if (entity.type === 'container' || entity.type === 'area') {
          await land({ id: entity.id, name: entity.name, type: entity.type });
          return;
        }
        // Only 'item' | 'property' remain at this point — the branch above
        // already returned for every other case.
        if (entity.type !== 'item') {
          toast.error('That label is not an item, bin, or area');
          return;
        }
        if (carriedRef.current.some((c) => c.id === entity.id)) {
          toast('Already carrying');
          return;
        }
        addToCarry({ id: entity.id, name: entity.name, kind: entity.type });
        toast(`Carrying ${carriedRef.current.length + 1}`);
        return;
      }

      // DISTRIBUTE — nothing carried. Only reachable once something is
      // pinned (the scanner/typed field below aren't rendered otherwise),
      // so a bin/area code here is always a re-pin, never a first pin.
      if (entity.type === 'container' || entity.type === 'area') {
        pin({ id: entity.id, name: entity.name, type: entity.type });
        toast(`Now moving to ${entity.name}`);
        return;
      }
      if (entity.type !== 'item') {
        toast.error('That label is not an item, bin, or area');
        return;
      }
      if (!pinnedDest) {
        toast.error('Scan a bin first');
        return;
      }
      await moveToPin(entity);
    } catch {
      toast.error('Could not read that label');
    }
  }, [land, addToCarry, pinnedDest, pin, moveToPin]);

  const [typed, setTyped] = React.useState('');
  function submitTyped() {
    // The typed field accepts anything a person can paste — including the
    // full label URL, which is what a phone's share sheet hands back after
    // scanning one — so it runs through the same parser scan.tsx uses
    // rather than trusting the caller.
    const code = extractTlyCode(typed);
    if (!code) { toast('That is not a tally tag'); return; }
    setTyped('');
    void handleCode(code);
  }

  // The shared "last landing" undo — the empty state's button and (while
  // still carrying or freshly pinned) the banner both point here. Reads
  // `lastMove` from the store, unlike undoMove's other callers, because this
  // IS the "undo whatever most recently landed" action — there is only ever
  // one lastMove, and this is the one place that slot is meant to be read.
  async function undo() {
    if (!lastMove) return;
    await undoMove(lastMove.items, lastMove.unlinkedCount);
    clearLastMove();
  }

  const handleDone = React.useCallback(() => {
    if (!pinnedDest) return;
    navigate(pinnedDest.type === 'area' ? `/area/${pinnedDest.id}` : `/container/${pinnedDest.id}`);
    clearPin();
  }, [pinnedDest, navigate, clearPin]);

  // Esc-as-Done at a desk: a keyboard-only convenience for the flow that has
  // no camera to close instead. Skipped while a confirm sheet is open — its
  // own Escape handling (Radix's dialog) owns that keystroke instead.
  React.useEffect(() => {
    if (!atDesk) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && pinnedDest && !pendingConfirm) handleDone();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [atDesk, pinnedDest, pendingConfirm, handleDone]);

  // Nothing in hand and nowhere pinned: this screen has no question to ask.
  if (carried.length === 0 && !pinnedDest) {
    return (
      <div className="flex flex-col gap-4 max-w-lg mx-auto">
        <TitleBar className="w-fit">Move</TitleBar>
        <div className="flex flex-col items-center gap-2 py-12 text-center">
          <PackageOpen className="w-7 h-7 text-[var(--color-text-muted)]" />
          <p className="font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
            Nothing in hand
          </p>
          <p className="text-sm text-[var(--color-text-secondary)] max-w-xs">
            Pick something up — tap Move on an item or a bin — then scan where it goes.
          </p>
          <p className="text-sm text-[var(--color-text-secondary)] max-w-xs">
            Or scan a bin or area here first, then scan items straight to it.
          </p>
          {lastDest && (
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => { pin(lastDest); toast(`Now moving to ${lastDest.name}`); }}
            >
              Again to: {lastDest.name}
            </Button>
          )}
          {lastMove && (
            <Button variant="outline" size="sm" className="mt-2" onClick={undo}>
              <Undo2 className="w-4 h-4" />
              Undo the last move
            </Button>
          )}
        </div>
      </div>
    );
  }

  const scannerLabel = pendingConfirm
    ? 'Paused — resolve the prompt'
    : busy
      ? progress
        ? `Moving… ${progress.done} of ${progress.total}`
        : 'Moving…'
      : distributing
        ? 'Scan item to move · scan a bin to re-pin'
        : 'Scan item, bin, or area';

  const typedCodeForm = (
    <form
      className="flex gap-2 shrink-0"
      onSubmit={(e) => { e.preventDefault(); if (typed.trim()) submitTyped(); }}
    >
      <Input
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        placeholder={showScanner ? 'Or type the code (TLY-…)' : 'Type or scan a code (TLY-…)'}
        autoCapitalize="characters"
        spellCheck={false}
      />
      <Button size="sm" type="submit" className="shrink-0" disabled={!typed.trim()}>
        <ArrowRight className="w-4 h-4" />
        Go
      </Button>
    </form>
  );

  return (
    /*
     * At a desk this is a two-column job, not a stack.
     *
     * The load and the destination are one decision — "put THESE, THERE" — and
     * on a phone they have to take turns because there is no room for both. A
     * desk can show them at once, so what you are carrying (and/or where it's
     * headed) stays visible while you browse or scan, instead of scrolling
     * out of view.
     */
    <div className={cn(
      'h-full',
      atDesk
        ? 'grid w-full max-w-[1100px] grid-cols-[minmax(280px,360px)_minmax(0,1fr)] items-start gap-6 mx-auto'
        : 'flex flex-col gap-3 max-w-lg mx-auto',
    )}>
      {/* Left column at a desk, top of the stack on a phone. Carrying and a
          pin are independent facts (a partial-batch landing can leave both
          true at once) so each renders on its own condition rather than as
          an either/or. */}
      <div className="flex flex-col gap-3 shrink-0">
        {carried.length > 0 && (
          <div className="flex items-center gap-2 border-2 border-[var(--color-primary)] bg-[var(--color-primary-bg)] rounded-[var(--radius-sm)] px-3 py-2">
            <span className="min-w-0 flex-1">
              <span className="block font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-primary)] font-bold">
                carrying
              </span>
              <span className="block text-sm font-semibold truncate">{summary}</span>
              {carried.length === 1 && carried[0].fromContainerName && (
                <span className="block font-mono text-[10px] text-[var(--color-text-muted)] truncate">
                  from {carried[0].fromContainerName}
                </span>
              )}
            </span>
            <button
              type="button"
              aria-label="Put down without moving"
              onClick={() => { clear(); navigate(-1); }}
              className="shrink-0 min-w-[36px] min-h-[36px] flex items-center justify-center text-[var(--color-primary)]"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {pinnedDest && (
          <div className="flex items-center gap-2 border-2 border-[var(--color-text)] bg-[var(--color-bg)] rounded-[var(--radius-sm)] px-3 py-2">
            <span className="min-w-0 flex-1">
              <span className="block font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
                moving to
              </span>
              <span className="block text-sm font-semibold truncate">{pinnedDest.name}</span>
            </span>
            <Button size="sm" onClick={handleDone}>Done</Button>
          </div>
        )}
      </div>

      <div className={cn(atDesk && 'min-w-0')}>
      {gathering && picking ? (
        showSwitcher ? (
          // Cross-property destinations need a deliberate choice, not a
          // dropdown buried inside the picker — same segmented-Button pattern
          // as the loaded-roll selector in printer settings.
          <div className="flex flex-col gap-2 flex-1 min-h-0">
            <div className="flex gap-2 shrink-0">
              {properties!.map((p) => (
                <Button
                  key={p.id}
                  size="sm"
                  variant={p.id === selectedPropertyId ? 'default' : 'outline'}
                  onClick={() => setSelectedPropertyId(p.id)}
                >
                  {p.name}
                </Button>
              ))}
            </div>
            {/* Remounted on property change (via key) so the picker's own
                area/container state resets instead of showing the old
                property's bins under the new one's areas. showPropertySelector
                is false — the switcher above is the ONLY property control, or
                the two would desync the moment either one changed. seedAreaId
                only travels along when the switcher is still on the load's
                own (home) property: on any OTHER property, that area belongs
                to a different property than the one selected and must not be
                force-fed into the picker's area select. */}
            <DestinationPicker
              key={selectedPropertyId}
              seedPropertyId={selectedPropertyId || undefined}
              seedAreaId={selectedPropertyId === homePropertyId ? carriedFromAreaId : undefined}
              showPropertySelector={false}
              onPick={(bin) => { setPicking(false); void land({ type: 'container', id: bin.id, name: bin.name }); }}
              onClose={() => setPicking(false)}
            />
          </div>
        ) : (
          <DestinationPicker
            seedAreaId={carriedFromAreaId}
            onPick={(bin) => { setPicking(false); void land({ type: 'container', id: bin.id, name: bin.name }); }}
            onClose={() => setPicking(false)}
          />
        )
      ) : gathering ? (
        <>
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
                label={scannerLabel}
                onTag={handleCode}
                onClose={() => navigate(-1)}
              />
            </div>
          )}
          {showScanner && typedCodeForm}
          <Button variant="outline" size="sm" className="shrink-0" onClick={() => setPicking(true)}>
            <List className="w-4 h-4" />
            Pick a bin from the list
          </Button>
        </>
      ) : distributing ? (
        <>
          {showScanner && (
            <div className={cn('flex flex-col flex-1 min-h-0', atDesk && coarse && 'max-h-[clamp(230px,36vh,280px)] overflow-hidden')}>
              <TagScanner
                isActive={!pendingConfirm}
                label={scannerLabel}
                onTag={handleCode}
                onClose={handleDone}
              />
            </div>
          )}
          {/* Fine desks have no scanner at all in this mode, so the typed
              field is the ONLY way to keep distributing there — a USB QR
              reader is a keyboard, exactly the reasoning scan.tsx's desk
              layout already leans on. Rendered unconditionally here, unlike
              GATHER's desk flow (unchanged, picker-only), because
              DISTRIBUTE never had a desk story before this feature. */}
          {typedCodeForm}
        </>
      ) : null}
      </div>

      {pendingConfirm && (
        <MoveConsequencesSheet
          entityName={pendingConfirm.entityName}
          progress={{ index: pendingConfirm.index, total: pendingConfirm.total }}
          // total is the whole batch, not just what's still waiting on a
          // decision — remainingCount is what "apply to the rest" actually
          // means, so it has to exclude everything already resolved.
          remainingCount={Math.max(0, pendingConfirm.total - pendingConfirm.index - 1)}
          consequences={pendingConfirm.consequences}
          isPending={moveItem.isPending || moveContainer.isPending}
          onConfirm={(applyToRest) => decide('confirm', applyToRest)}
          onCancel={(applyToRest) => decide('cancel', applyToRest)}
        />
      )}
    </div>
  );
}

export default PutDown;

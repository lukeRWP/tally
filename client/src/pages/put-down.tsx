import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { PackageOpen, List, Undo2, X } from 'lucide-react';
import { TagScanner } from '@/components/scanner/tag-scanner';
import { DestinationPicker } from '@/components/inventory/destination-picker';
import { MoveConsequencesSheet } from '@/components/inventory/move-consequences-sheet';
import { Button } from '@/components/ui/button';
import { TitleBar } from '@/components/ui/title-bar';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useCarryStore } from '@/store/carry-store';
import { usePutDown, type ConfirmPrompt } from '@/hooks/use-put-down';
import { useMoveItem, useMoveContainer, useProperties, type MoveConsequences } from '@/hooks/use-inventory';
import { cn } from '@/lib/utils';
import { useLayoutMode } from '@/hooks/use-layout-mode';
import { useCoarsePointer } from '@/hooks/use-coarse-pointer';

/**
 * Put it down.
 *
 * Scanning is not one activity. Adding an item asks "what is this?" and wants a
 * product barcode; putting something away asks "where does this go?" and wants
 * a bin label. They were the same screen, so tapping Move on an item opened a
 * page offering to add an item and search a product catalogue — an answer to a
 * question nobody had asked.
 *
 * This screen has exactly one question. Every code it sees is read as a
 * destination: a bin nests or receives, an area takes the load into its
 * catch-all. A product barcode is not an error, it is just the wrong kind of
 * answer, and is told so.
 */

interface ResolvedEntity {
  type: string;
  id: number;
  name: string;
  exists: boolean;
}

/** What the property-switcher + picker together decide the load is landing on. */
interface LandTarget {
  type: string;
  id: number;
  name: string;
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

export function PutDown() {
  const atDesk = useLayoutMode() === 'sidebar';
  const coarse = useCoarsePointer();
  // Scanner where a rear camera plausibly exists: phones, and tablets in
  // landscape (sidebar chrome + coarse pointer — see use-coarse-pointer.ts
  // for why camera-presence is NOT the test). Fine-pointer desks keep the
  // picker-only flow.
  const showScanner = !atDesk || coarse;
  const navigate = useNavigate();
  const carried = useCarryStore((s) => s.carried);
  const lastMove = useCarryStore((s) => s.lastMove);
  const clear = useCarryStore((s) => s.clear);
  const clearLastMove = useCarryStore((s) => s.clearLastMove);
  const putDown = usePutDown();
  const moveItem = useMoveItem();
  const moveContainer = useMoveContainer();

  const [picking, setPicking] = React.useState(atDesk);
  const [busy, setBusy] = React.useState(false);
  // Mirrors `busy` for the reentrancy guard inside land() (below). land is a
  // useCallback that does not — and should not — depend on `busy` (it has no
  // reason to be recreated when it flips), so reading the STATE there would
  // close over a stale value from whenever land was last created. The ref is
  // written alongside every setBusy call via setBusyBoth and is always current.
  const busyRef = React.useRef(false);
  function setBusyBoth(value: boolean) {
    busyRef.current = value;
    setBusy(value);
  }
  const [pendingConfirm, setPendingConfirm] = React.useState<PendingConfirm | null>(null);
  // The loop that's paused lives inside usePutDown's Promise chain, not in
  // this component — this is the resume handle for it.
  const decisionRef = React.useRef<((decision: 'confirm' | 'cancel') => void) | null>(null);
  // Set false in the SAME unmount cleanup that resolves a pending decision as
  // cancel (below) — land() checks it after putDown resolves so that an
  // unmount mid-batch (browser Back while the confirm sheet is up, a
  // bottom-nav tap) can't still navigate the user forward or toast on a page
  // they've already left. completeMove (inside usePutDown) already ran by
  // then and is NOT gated on this — only the navigation/UI tail is.
  const mountedRef = React.useRef(true);

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

  function decide(decision: 'confirm' | 'cancel') {
    decisionRef.current?.(decision);
    decisionRef.current = null;
    setPendingConfirm(null);
  }

  // An unmount mid-pause (navigating away — the X below, a bottom-nav tap,
  // the browser back button — while the sheet is up) must not leave
  // usePutDown's loop awaiting forever: that is the exact stuck-carry
  // failure this whole round exists to kill, just triggered by navigation
  // instead of a network error. Resolve as CANCEL, never confirm — an
  // unmount means we can no longer ask the user anything, and silently
  // confirming would commit a lossy cross-property move nobody agreed to.
  // The paused entity ends up skipped; completeMove (inside usePutDown)
  // still reconciles whatever DID move before the pause.
  React.useEffect(() => {
    mountedRef.current = true; // re-arm — StrictMode's remount runs setup again
    return () => {
      mountedRef.current = false;
      decisionRef.current?.('cancel');
      decisionRef.current = null;
    };
  }, []);

  const land = React.useCallback(async (dest: LandTarget) => {
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
      // page is gone, so no navigation and no toast for whoever isn't here
      // to see it.
      if (!mountedRef.current) return;
      if (!result) {
        toast(`Already in ${dest.name}`);
        return;
      }
      const { moved, skipped, aborted, abortError, crossProperty, tagsCarried } = result;

      if (aborted) {
        // Whatever moved before the failure was already reconciled (dropped
        // from carry, undo armed for it) inside usePutDown — this toast is
        // just the honest report that the rest did not go through.
        toast.error(abortError instanceof Error ? abortError.message : 'Could not move it there');
        return;
      }

      if (moved.length === 0) {
        // Every attempted entity was declined at its confirm sheet — nothing
        // landed, so there is nowhere to navigate to.
        toast('Nothing moved');
        return;
      }

      if (skipped.length > 0) {
        toast.success(`Moved ${moved.length} · skipped ${skipped.length}`);
      } else if (crossProperty) {
        toast.success(`Moved to the other property · ${tagsCarried} tags carried`);
      } else {
        toast.success(
          moved.length === 1 ? `${moved[0].name} → ${dest.name}` : `${moved.length} moved → ${dest.name}`,
        );
      }
      // Go to where it landed: the point of the move is that the thing is now
      // somewhere, and this shows you it is.
      if (dest.type === 'area') navigate(`/area/${dest.id}`);
      else navigate(`/container/${dest.id}`);
    } catch (err) {
      if (!mountedRef.current) return;
      toast.error(err instanceof Error ? err.message : 'Could not move it there');
    } finally {
      setBusyBoth(false);
    }
  }, [putDown, navigate, confirmPrompt]);

  // Only tally tags reach here — the scanner decodes nothing else — so this
  // only has to decide whether the tag names somewhere a load can go.
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
      if (entity.type !== 'container' && entity.type !== 'area') {
        toast.error('That label is not a bin or an area');
        return;
      }
      await land(entity);
    } catch {
      toast.error('Could not read that label');
    }
  }, [land]);

  async function undo() {
    if (!lastMove) return;
    const reversible = lastMove.items.filter((i) => i.fromContainerId || i.fromAreaId);
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
      const skipped = lastMove.items.length - reversible.length;
      toast(
        lastMove.unlinkedCount && lastMove.unlinkedCount > 0
          ? 'Moved back · unlinked accessories were not restored'
          : skipped > 0
            ? `Put ${reversible.length} back — ${skipped} had no previous home`
            : 'Put back',
      );
      clearLastMove();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not undo the move');
    }
  }

  // Nothing in hand: this screen has no question to ask.
  if (carried.length === 0) {
    return (
      <div className="flex flex-col gap-4 max-w-lg mx-auto">
        <TitleBar className="w-fit">Move</TitleBar>
        <div className="flex flex-col items-center gap-2 py-12 text-center">
          <PackageOpen className="w-7 h-7 text-[var(--color-text-muted)]" />
          <p className="font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
            Nothing in hand
          </p>
          <p className="text-sm text-[var(--color-text-secondary)] max-w-xs">
            Pick something up first — tap <b>Move</b> on an item or a bin, or select several
            inside a bin and move them together.
          </p>
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

  return (
    /*
     * At a desk this is a two-column job, not a stack.
     *
     * The load and the destination are one decision — "put THESE, THERE" — and
     * on a phone they have to take turns because there is no room for both. A
     * desk can show them at once, so what you are carrying stays visible while
     * you browse for somewhere to put it, instead of scrolling out of view the
     * moment the picker opens.
     */
    <div className={cn(
      'h-full',
      atDesk
        ? 'grid w-full max-w-[1100px] grid-cols-[minmax(280px,360px)_minmax(0,1fr)] items-start gap-6 mx-auto'
        : 'flex flex-col gap-3 max-w-lg mx-auto',
    )}>
      {/* What is in your hands, and the one question this screen asks. */}
      <div className="flex items-center gap-2 border-2 border-[var(--color-primary)] bg-[var(--color-primary-bg)] rounded-[var(--radius-sm)] px-3 py-2 shrink-0">
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

      <div className={cn(atDesk && 'min-w-0')}>
      {picking ? (
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
      ) : (
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
                label={pendingConfirm ? 'Paused — resolve the prompt' : busy ? 'Moving…' : 'Scan tote/area tag'}
                onTag={handleCode}
                onClose={() => navigate(-1)}
              />
            </div>
          )}
          <Button variant="outline" size="sm" className="shrink-0" onClick={() => setPicking(true)}>
            <List className="w-4 h-4" />
            Pick a bin from the list
          </Button>
        </>
      )}
      </div>

      {pendingConfirm && (
        <MoveConsequencesSheet
          entityName={pendingConfirm.entityName}
          progress={{ index: pendingConfirm.index, total: pendingConfirm.total }}
          consequences={pendingConfirm.consequences}
          isPending={moveItem.isPending || moveContainer.isPending}
          onConfirm={() => decide('confirm')}
          onCancel={() => decide('cancel')}
        />
      )}
    </div>
  );
}

export default PutDown;

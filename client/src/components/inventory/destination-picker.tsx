import * as React from 'react';
import { X, MapPin, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { useProperties, useAreas, useContainers } from '@/hooks/use-inventory';
import { useKeyboardNav } from '@/hooks/use-keyboard-nav';
import { CreateContainerDialog } from '@/components/inventory/create-container-dialog';
import { cn } from '@/lib/utils';

export interface PickedBin {
  id: number;
  name: string;
  areaId?: number;
}

/**
 * The keyboard path to a bin: property → area → bin.
 *
 * Every flow that asks "where does this go?" needs one, because the camera is
 * not always the answer — the bin may have no label yet, the label may be
 * damaged, permission may be denied, or you may simply know where it goes.
 * Shared so the create flow and the move flow ask the question identically.
 */
export function DestinationPicker({
  seedAreaId,
  seedPropertyId,
  showPropertySelector = true,
  onPick,
  onClose,
}: {
  /** Pre-select an area (e.g. the page you came from) so the bins are one tap away. */
  seedAreaId?: number;
  seedPropertyId?: number;
  /**
   * False when a control OUTSIDE the picker already owns the property
   * choice (put-down's segmented switcher, shown for a load whose bin
   * picker follows it). Two property selectors for one decision desync the
   * moment either one changes — the picker still USES seedPropertyId to
   * drive its area/container queries, it just doesn't render its own
   * `<select>` for it.
   */
  showPropertySelector?: boolean;
  onPick: (bin: PickedBin) => void;
  onClose: () => void;
}) {
  const [propertyId, setPropertyId] = React.useState(seedPropertyId ?? 0);
  const [areaId, setAreaId] = React.useState(seedAreaId ?? 0);

  const { data: properties } = useProperties();
  const { data: areas } = useAreas(propertyId);
  const { data: containers } = useContainers(areaId);

  // useState initialisers run once, so a seed arriving AFTER mount would be
  // ignored and the picker would sit blank. Adopting it must be a ONE-SHOT
  // event, not a condition: `if (seed && !areaId)` re-fires the moment the
  // user picks a different property (which resets the area to 0), restoring
  // the previous property's area and listing its bins — and it makes the
  // "Area…" placeholder impossible to choose, since selecting it snaps back.
  const seeded = React.useRef(false);
  React.useEffect(() => {
    if (seeded.current) return;
    if (!seedAreaId && !seedPropertyId) return;
    if (seedAreaId) setAreaId(seedAreaId);
    if (seedPropertyId) setPropertyId(seedPropertyId);
    seeded.current = true;
  }, [seedAreaId, seedPropertyId]);

  // One property is the common case; pre-select it so the picker opens on areas.
  React.useEffect(() => {
    if (!propertyId && properties?.length === 1) setPropertyId(properties[0].id);
  }, [properties, propertyId]);

  // An area seeded without its property leaves the cascade blank, so backfill.
  React.useEffect(() => {
    if (!seedAreaId || propertyId) return;
    (async () => {
      try {
        const { area } = await api.get<{ area: { propertyId: number } }>(`/api/areas/_x_/${seedAreaId}`);
        if (area?.propertyId) setPropertyId(area.propertyId);
      } catch { /* the picker still works, it just starts at the property step */ }
    })();
  }, [seedAreaId, propertyId]);

  const containerList = containers ?? [];
  const areaName = areas?.find((a) => a.id === areaId)?.name;
  // The empty-area state used to be a dead end — no bins, no way to make one
  // without abandoning whatever flow opened this picker (capture, put-down).
  // Seeded with the area already selected here, so the only thing left to
  // answer is name + type.
  const [createOpen, setCreateOpen] = React.useState(false);
  // CreateContainerDialog calls useNavigate() unconditionally, so mounting it
  // requires a Router ancestor. Both real hosts (capture.tsx, put-down.tsx)
  // are pages rendered under the app's Router, but the picker itself carries
  // no such guarantee (its own keyboard-nav tests mount it bare) — so it is
  // only ever instantiated once the create affordance has actually been
  // used, never just because an area with no bins happens to be selected.
  const [createEverOpened, setCreateEverOpened] = React.useState(false);
  const [highlightIdx, setHighlightIdx] = React.useState(-1);
  // A new area's bin list means a stale index would point at an unrelated row.
  React.useEffect(() => { setHighlightIdx(-1); }, [areaId]);

  const moveHighlight = React.useCallback((delta: 1 | -1) => {
    if (containerList.length === 0) return;
    setHighlightIdx((at) => (at === -1
      ? (delta === 1 ? 0 : containerList.length - 1)
      : Math.min(containerList.length - 1, Math.max(0, at + delta))));
  }, [containerList.length]);

  useKeyboardNav({
    onMove: moveHighlight,
    onOpen: () => {
      const bin = containerList[highlightIdx];
      if (bin) onPick({ id: bin.id, name: bin.name, areaId: bin.areaId });
    },
    // Deliberately no onEscape: this panel has no Esc-to-close affordance of
    // its own (only the X button calls onClose), and both places that mount
    // this picker (capture.tsx, put-down.tsx) already run their own
    // window-level Escape handling for the surrounding flow — put-down.tsx's
    // Esc-as-Done, in particular. The hook's Escape branch never calls
    // preventDefault/stopPropagation regardless of whether onEscape is
    // supplied, so the keypress was always going to reach them either way;
    // omitting it here just avoids adding a SECOND reaction (closing this
    // picker) to the same keypress on top of whatever the host page does.
  });

  return (
    <>
      <div className="flex flex-col gap-2 border-2 border-[var(--color-text)] rounded-[var(--radius-sm)] p-3 flex-1 min-h-0">
        <div className="flex items-center justify-between shrink-0">
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] font-bold">Choose a bin</span>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="min-w-[32px] min-h-[32px] flex items-center justify-center text-[var(--color-text-muted)]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {showPropertySelector && (properties?.length ?? 0) > 1 && (
          <select
            value={propertyId}
            onChange={(e) => {
              seeded.current = true; // a deliberate choice outranks any seed
              setPropertyId(Number(e.target.value));
              setAreaId(0);
            }}
            className="w-full min-h-[40px] px-2 rounded-[var(--radius-sm)] border border-[var(--color-rule)] bg-[var(--color-bg)] text-sm shrink-0"
          >
            <option value={0}>Property…</option>
            {properties?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}

        <select
          value={areaId}
          onChange={(e) => { seeded.current = true; setAreaId(Number(e.target.value)); }}
          disabled={!propertyId}
          className="w-full min-h-[40px] px-2 rounded-[var(--radius-sm)] border border-[var(--color-rule)] bg-[var(--color-bg)] text-sm disabled:opacity-50 shrink-0"
        >
          <option value={0}>Area…</option>
          {areas?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>

        {areaId > 0 && (
          (containers?.length ?? 0) === 0 ? (
            <div className="flex flex-col gap-2 py-2 shrink-0">
              <p className="font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
                No bins in this area yet — scan its area label to file loose
              </p>
              <button
                type="button"
                onClick={() => { setCreateEverOpened(true); setCreateOpen(true); }}
                className="flex items-center gap-1.5 self-start font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--color-primary)] underline decoration-dotted"
              >
                <Plus className="w-3 h-3" />
                Create a container here
              </button>
            </div>
          ) : (
            <div className="flex flex-col flex-1 min-h-[100px] overflow-y-auto">
              {containerList.map((c, idx) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onPick({ id: c.id, name: c.name, areaId: c.areaId })}
                  className={cn(
                    'flex items-center gap-2 py-2.5 border-b border-[var(--color-rule)] last:border-b-0 text-left',
                    highlightIdx === idx && 'bg-[var(--color-elevated)] ring-1 ring-[var(--color-text)]',
                  )}
                >
                  <MapPin className="w-3.5 h-3.5 shrink-0 text-[var(--color-text-muted)]" />
                  <span className="min-w-0 flex-1 text-sm font-medium truncate">{c.name}</span>
                  <span className="font-mono text-[10px] text-[var(--color-text-muted)]">{c.itemCount ?? 0}</span>
                </button>
              ))}
            </div>
          )
        )}
      </div>

      {/*
        A real Radix Dialog, rendered as a controlled sibling of the panel
        above rather than nested inside it. It doesn't need to be — this
        picker is itself just a bordered div (see the keyboard-nav test's
        header comment), never a Dialog/Sheet in either of its two call sites
        (capture.tsx, put-down.tsx) — but keeping it a sibling here means
        that stays true regardless of what a future host wraps the picker in.

        onCreated skips CreateContainerDialog's default "navigate to the new
        container's page" — from inside a picker, the container was made to
        be picked, not visited. useCreateContainer's onSuccess already
        invalidates the whole container tree (see use-inventory.ts), so
        containerList refetches this area's bins on its own; onPick still
        fires immediately rather than waiting on that refetch, so the choice
        lands without a round trip.
      */}
      {areaId > 0 && createEverOpened && (
        <CreateContainerDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          seedAreaId={areaId}
          seedAreaName={areaName}
          seedPropertyId={propertyId || undefined}
          onCreated={(container) => {
            onPick({ id: container.id, name: container.name, areaId: container.areaId });
          }}
        />
      )}
    </>
  );
}

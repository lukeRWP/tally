import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api';
import {
  useProperties, useAreas, useContainers, useMoveItem, type MoveConsequences,
} from '@/hooks/use-inventory';
import { MoveConsequencesSheet } from '@/components/inventory/move-consequences-sheet';

interface MoveItemDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  itemId: number;
  itemName: string;
  /** Pre-select the item's own property — moves are almost always within it. */
  defaultPropertyId?: number;
  currentContainerId?: number;
  onMoved?: () => void;
}

const selectClass =
  'w-full appearance-none bg-[var(--color-card)] border border-[var(--color-border)] ' +
  'rounded-[var(--radius-md)] px-3 py-2 text-sm text-[var(--color-text)] ' +
  'focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] cursor-pointer';

/**
 * Destination picker for moving an item: Property → Area → Container.
 *
 * This is the picker-based counterpart to Scan's two-scan move mode. Move mode
 * is the right tool when both printed labels are physically in front of you;
 * this is the right tool when you're on the item's page deciding where it
 * should go. The button was a "coming soon" toast while every hook it needs
 * already existed.
 */
export function MoveItemDialog({
  open,
  onOpenChange,
  itemId,
  itemName,
  defaultPropertyId,
  currentContainerId,
  onMoved,
}: MoveItemDialogProps) {
  const [propertyId, setPropertyId] = React.useState(defaultPropertyId ?? 0);
  const [areaId, setAreaId] = React.useState(0);
  const [containerId, setContainerId] = React.useState(0);
  // A cross-property move that would sever accessory links 409s with the
  // consequence payload on ApiError.errors; re-sending the SAME destination
  // with confirm:true is the only way past it — see put-down.tsx's
  // usePutDown, which does the identical dance for a batch.
  const [consequences, setConsequences] = React.useState<MoveConsequences | null>(null);

  const { data: properties } = useProperties();
  const { data: areas } = useAreas(propertyId);
  const { data: containers } = useContainers(areaId);
  const moveItem = useMoveItem();

  // Re-seed the cascade each time the dialog opens, so a previous move's
  // selection never leaks into the next one.
  React.useEffect(() => {
    if (open) {
      setPropertyId(defaultPropertyId ?? 0);
      setAreaId(0);
      setContainerId(0);
      setConsequences(null);
    }
  }, [open, defaultPropertyId]);

  function commit(confirm: boolean) {
    moveItem.mutate(
      { id: itemId, containerId, confirm },
      {
        onSuccess: (res) => {
          const dest = containers?.find((c) => c.id === containerId);
          toast(
            res.consequences
              ? `Moved to the other property · ${res.consequences.tagsCarried} tags carried`
              : `Moved to ${dest?.name ?? 'container'}`,
          );
          setConsequences(null);
          onOpenChange(false);
          onMoved?.();
        },
        onError: (err) => {
          // A lossy cross-property move: pause on the sheet instead of a
          // dead-end toast. Anything else (validation, a real 404/500) is
          // just reported.
          if (err instanceof ApiError && err.status === 409) {
            const body = err.errors as MoveConsequences | undefined;
            if (body?.unlinked) {
              setConsequences(body);
              return;
            }
          }
          toast(err instanceof Error ? err.message : 'Could not move the item');
        },
      },
    );
  }

  function handleMove() {
    commit(false);
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-sm mx-4">
          <DialogHeader>
            <DialogTitle>Move {itemName}</DialogTitle>
            <DialogDescription>
              Pick where it should live. Tip: with the labels in front of you, the
              Scan tab's move mode is faster — scan the destination, then the item.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-[var(--color-text-secondary)]">Property</label>
              {/* Cross-property moves are allowed — with a confirm gate if they'd
                  sever accessory links (handled below via the consequences
                  sheet). Locked only while the property list itself is still
                  loading; once it's loaded the item page must be able to reach
                  every property the user has editor access to, defaultPropertyId
                  pre-selected or not. */}
              <select
                className={selectClass}
                value={propertyId}
                disabled={!properties}
                onChange={(e) => {
                  setPropertyId(Number(e.target.value));
                  setAreaId(0);
                  setContainerId(0);
                }}
              >
                <option value={0}>Select property…</option>
                {properties?.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-[var(--color-text-secondary)]">Area</label>
              <select
                className={selectClass}
                value={areaId}
                disabled={!propertyId}
                onChange={(e) => {
                  setAreaId(Number(e.target.value));
                  setContainerId(0);
                }}
              >
                <option value={0}>Select area…</option>
                {areas?.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-[var(--color-text-secondary)]">Container</label>
              <select
                className={selectClass}
                value={containerId}
                disabled={!areaId}
                onChange={(e) => setContainerId(Number(e.target.value))}
              >
                <option value={0}>Select container…</option>
                {containers?.map((c) => (
                  <option key={c.id} value={c.id} disabled={c.id === currentContainerId}>
                    {c.name}{c.id === currentContainerId ? ' (current)' : ''}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleMove}
              disabled={!containerId || containerId === currentContainerId || moveItem.isPending}
            >
              {moveItem.isPending ? 'Moving…' : 'Move here'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* A separate Dialog, rendered while the move dialog stays open behind
          it — cancelling just clears the pause so the same destination (or a
          different one) can be tried again without losing the picker's
          selection. */}
      {consequences && (
        <MoveConsequencesSheet
          entityName={itemName}
          consequences={consequences}
          isPending={moveItem.isPending}
          onConfirm={() => commit(true)}
          onCancel={() => setConsequences(null)}
        />
      )}
    </>
  );
}

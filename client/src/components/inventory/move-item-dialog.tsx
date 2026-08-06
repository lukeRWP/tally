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
import { useProperties, useAreas, useContainers, useMoveItem } from '@/hooks/use-inventory';

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
    }
  }, [open, defaultPropertyId]);

  function handleMove() {
    moveItem.mutate(
      { id: itemId, containerId },
      {
        onSuccess: () => {
          const dest = containers?.find((c) => c.id === containerId);
          toast(`Moved to ${dest?.name ?? 'container'}`);
          onOpenChange(false);
          onMoved?.();
        },
        onError: (err) => toast(err instanceof Error ? err.message : 'Could not move the item'),
      },
    );
  }

  return (
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
            {/* The server rejects cross-property moves outright ("Destination
                container must be in the same property"), so offering other
                properties is offering guaranteed failures. Locked when we know
                the item's property; free only if the caller could not tell us. */}
            <select
              className={selectClass}
              value={propertyId}
              disabled={!!defaultPropertyId}
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
  );
}

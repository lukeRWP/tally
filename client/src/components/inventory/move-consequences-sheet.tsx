import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { MoveConsequences } from '@/hooks/use-inventory';

export type { MoveConsequences };

/**
 * Shown when a scanned or picked destination turns out to be in a different
 * property than the carried load. Crossing properties can sever accessory
 * links that only made sense within the old one — this is the one chance to
 * see what breaks before committing to it.
 *
 * A batch move pauses on the FIRST entity that needs this, not the whole
 * screen — `progress` (only passed when there is more than one entity in the
 * load) says which one and how many are left, so confirming or cancelling
 * reads as "this one" rather than "the move."
 *
 * Same primitives as ConfirmDialog (Dialog/DialogContent/DialogHeader/
 * DialogFooter), because this IS a confirm dialog — just one with a body that
 * needs more than a single description line.
 */
export function MoveConsequencesSheet({
  entityName,
  progress,
  consequences,
  onConfirm,
  onCancel,
  isPending = false,
}: {
  /** The name of the ONE entity this sheet is pausing the batch for. */
  entityName?: string;
  /** 0-based index + total count, when the load has more than one entity. */
  progress?: { index: number; total: number };
  consequences: MoveConsequences;
  onConfirm: () => void;
  onCancel: () => void;
  isPending?: boolean;
}) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold text-[var(--color-text)]">
            Move to the other property?
          </DialogTitle>
          {entityName && progress && progress.total > 1 && (
            <p className="text-sm text-[var(--color-text-secondary)]">
              {entityName} — {progress.index + 1} of {progress.total}
            </p>
          )}
        </DialogHeader>

        {consequences.unlinked.length > 0 && (
          <div className="flex flex-col gap-1 text-sm text-[var(--color-text-secondary)]">
            {consequences.unlinked.map((a) => (
              <p key={a.itemId}>Unlinks from {a.name}</p>
            ))}
          </div>
        )}

        <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-muted)] mt-3">
          {consequences.tagsCarried} tags carried, {consequences.tagsCreated} created
        </p>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" size="sm" disabled={isPending}>Cancel</Button>
          </DialogClose>
          <Button variant="destructive" size="sm" disabled={isPending} onClick={onConfirm}>
            Move anyway
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

/**
 * The shape the server sends both ways: as the 409 body's `errors` when a
 * lossy cross-property move needs confirmation, and as the success body's
 * `consequences` once one has gone through (confirmed, or clean to begin
 * with).
 */
export interface MoveConsequences {
  unlinked: { itemId: number; name: string }[];
  tagsCarried: number;
  tagsCreated: number;
}

/**
 * Shown when a scanned or picked destination turns out to be in a different
 * property than the carried load. Crossing properties can sever accessory
 * links that only made sense within the old one — this is the one chance to
 * see what breaks before committing to it.
 *
 * Same primitives as ConfirmDialog (Dialog/DialogContent/DialogHeader/
 * DialogFooter), because this IS a confirm dialog — just one with a body that
 * needs more than a single description line.
 */
export function MoveConsequencesSheet({
  consequences,
  onConfirm,
  onCancel,
  isPending = false,
}: {
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

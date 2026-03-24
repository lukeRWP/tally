import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast';
import { useLendItem } from '@/hooks/use-lending';

interface LendFormProps {
  itemId: number;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}

export function LendForm({ itemId, isOpen, onOpenChange }: LendFormProps) {
  const [lentTo, setLentTo] = React.useState('');
  const [dueAt, setDueAt] = React.useState('');
  const [notes, setNotes] = React.useState('');

  const lendItem = useLendItem();

  function reset() {
    setLentTo('');
    setDueAt('');
    setNotes('');
  }

  async function handleSubmit() {
    if (!lentTo.trim()) {
      toast.error('Please enter who the item is lent to');
      return;
    }
    try {
      await lendItem.mutateAsync({
        itemId,
        lentTo: lentTo.trim(),
        dueAt: dueAt || undefined,
        notes: notes.trim() || undefined,
      });
      toast.success(`Item lent to ${lentTo.trim()}`);
      reset();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to lend item');
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) reset(); onOpenChange(open); }}>
      <DialogContent className="mx-4 max-w-sm">
        <DialogHeader>
          <DialogTitle>Lend Item</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div>
            <p className="text-xs font-medium text-[var(--color-text-muted)] mb-2">Lent to</p>
            <Input
              placeholder="Person's name"
              value={lentTo}
              onChange={(e) => setLentTo(e.target.value)}
              autoFocus
            />
          </div>

          <div>
            <p className="text-xs font-medium text-[var(--color-text-muted)] mb-2">Due date</p>
            <input
              type="date"
              value={dueAt}
              onChange={(e) => setDueAt(e.target.value)}
              className={cn(
                'w-full bg-[var(--color-card)] border border-[var(--color-border)] rounded-[var(--radius-md)] px-3 py-2 text-sm text-[var(--color-text)]',
                'focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:ring-offset-1',
              )}
            />
          </div>

          <div>
            <p className="text-xs font-medium text-[var(--color-text-muted)] mb-2">Notes</p>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional notes..."
              rows={3}
              className={cn(
                'w-full px-3 py-2 rounded-[var(--radius-md)] border border-[var(--color-border)]',
                'bg-[var(--color-elevated)] text-sm text-[var(--color-text)]',
                'placeholder:text-[var(--color-text-muted)] resize-none',
                'focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent',
              )}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => { reset(); onOpenChange(false); }}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={lendItem.isPending}
          >
            {lendItem.isPending ? 'Lending...' : 'Lend'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

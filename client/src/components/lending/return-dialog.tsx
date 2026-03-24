import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { useReturnItem } from '@/hooks/use-lending';

interface ReturnDialogProps {
  lendingId: number;
  itemId: number;
  itemName: string;
  lentTo: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ReturnDialog({
  lendingId,
  itemId,
  itemName,
  lentTo,
  isOpen,
  onOpenChange,
}: ReturnDialogProps) {
  const returnItem = useReturnItem();

  async function handleConfirm() {
    try {
      await returnItem.mutateAsync({ lendingId, itemId });
      toast.success(`${itemName} marked as returned from ${lentTo}`);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to mark as returned');
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="mx-4 max-w-sm">
        <DialogHeader>
          <DialogTitle>Mark as Returned</DialogTitle>
        </DialogHeader>

        <p className="text-sm text-[var(--color-text-secondary)]">
          Mark <span className="font-medium text-[var(--color-text)]">{itemName}</span> as
          returned from <span className="font-medium text-[var(--color-text)]">{lentTo}</span>?
        </p>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleConfirm}
            disabled={returnItem.isPending}
          >
            {returnItem.isPending ? 'Returning...' : 'Confirm Return'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

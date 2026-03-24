import * as React from 'react';
import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { useSearchItems } from '@/hooks/use-inventory';
import { useLinkAccessory } from '@/hooks/use-accessories';

const conditionVariant: Record<string, 'success' | 'default' | 'warning' | 'danger'> = {
  new: 'success',
  good: 'default',
  fair: 'warning',
  poor: 'danger',
};

interface AccessoryPickerProps {
  itemId: number;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AccessoryPicker({ itemId, isOpen, onOpenChange }: AccessoryPickerProps) {
  const [query, setQuery] = React.useState('');
  const { data: results } = useSearchItems(query);
  const linkAccessory = useLinkAccessory();

  function reset() {
    setQuery('');
  }

  // Filter out the current item from results
  const filtered = (results ?? []).filter((item) => item.id !== itemId);

  async function handleLink(accessory: { id: number; name: string }) {
    try {
      await linkAccessory.mutateAsync({ itemId, accessoryId: accessory.id });
      toast.success(`Linked ${accessory.name}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to link accessory');
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) reset(); onOpenChange(open); }}>
      <DialogContent className="mx-4 max-w-sm">
        <DialogHeader>
          <DialogTitle>Link Accessory</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
            <Input
              placeholder="Search items..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-9"
              autoFocus
            />
          </div>

          <div className="flex flex-col gap-1.5 max-h-60 overflow-y-auto">
            {query.length >= 1 && filtered.length === 0 && (
              <p className="text-xs text-[var(--color-text-muted)] py-4 text-center">
                No items found
              </p>
            )}
            {filtered.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => handleLink(item)}
                disabled={linkAccessory.isPending}
                className="flex items-center justify-between gap-2 p-2 rounded-[var(--radius-md)] border border-[var(--color-border)] hover:bg-[var(--color-elevated)] transition-colors text-left cursor-pointer disabled:opacity-50"
              >
                <div className="flex flex-col gap-0.5 min-w-0">
                  <p className="text-sm font-medium text-[var(--color-text)] truncate">
                    {item.name}
                  </p>
                  <p className="text-[10px] font-mono text-[var(--color-text-muted)]">
                    {item.qrCode}
                  </p>
                </div>
                <Badge variant={conditionVariant[item.condition] ?? 'default'}>
                  {item.condition}
                </Badge>
              </button>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => { reset(); onOpenChange(false); }}
          >
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

import { useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { useAccessories, useUnlinkAccessory } from '@/hooks/use-accessories';

const conditionVariant: Record<string, 'success' | 'default' | 'warning' | 'danger'> = {
  new: 'success',
  good: 'default',
  fair: 'warning',
  poor: 'danger',
};

interface AccessoryListProps {
  itemId: number;
}

export function AccessoryList({ itemId }: AccessoryListProps) {
  const navigate = useNavigate();
  const { data: accessories, isLoading } = useAccessories(itemId);
  const unlinkAccessory = useUnlinkAccessory();

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (!accessories || accessories.length === 0) {
    return (
      <p className="text-xs text-[var(--color-text-muted)] py-1">No linked accessories.</p>
    );
  }

  function handleUnlink(accessoryId: number, name: string | null) {
    if (!window.confirm(`Unlink ${name ?? 'this accessory'}?`)) return;
    unlinkAccessory.mutate(
      { itemId, accessoryId },
      {
        onSuccess: () => toast.success(`Unlinked ${name ?? 'accessory'}`),
        onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to unlink'),
      },
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {accessories.map((acc) => (
        <div
          key={acc.accessoryId}
          className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] pb-2 last:border-0"
        >
          <button
            type="button"
            onClick={() => navigate(`/items/${acc.accessoryId}`)}
            className="flex flex-col gap-0.5 min-w-0 text-left cursor-pointer hover:opacity-80 transition-opacity"
          >
            <p className="text-xs font-medium text-[var(--color-primary)] truncate">
              {acc.name ?? 'Unknown'}
            </p>
            <p className="text-[10px] font-mono text-[var(--color-text-muted)]">
              {acc.qrCode ?? ''}
            </p>
          </button>
          <div className="flex items-center gap-1.5 shrink-0">
            {acc.condition && (
              <Badge variant={conditionVariant[acc.condition] ?? 'default'}>
                {acc.condition}
              </Badge>
            )}
            <button
              type="button"
              onClick={() => handleUnlink(acc.accessoryId, acc.name)}
              className="p-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-red)] transition-colors cursor-pointer"
              title="Unlink"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

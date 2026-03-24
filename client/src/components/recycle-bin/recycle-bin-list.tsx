import { Trash2, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-client';
import { toast } from '@/components/ui/toast';

interface DeletedItem {
  id: number;
  name: string;
  deletedAt: string;
  purgeAt: string | null;
  propertyName: string | null;
  areaName: string | null;
  containerName: string | null;
}

function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const diff = new Date(dateStr).getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

function locationLabel(item: DeletedItem): string {
  const parts = [item.propertyName, item.areaName, item.containerName].filter(Boolean);
  return parts.length > 0 ? parts.join(' > ') : 'Unknown location';
}

export function RecycleBinList() {
  const qc = useQueryClient();

  const { data: items, isLoading } = useQuery({
    queryKey: [...queryKeys.items.all, 'deleted'],
    queryFn: () => api.get<DeletedItem[]>('/api/items/_x_/deleted'),
  });

  const restore = useMutation({
    mutationFn: (id: number) => api.patch(`/api/items/_p_/${id}/restore`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...queryKeys.items.all, 'deleted'] });
      qc.invalidateQueries({ queryKey: queryKeys.items.all });
      toast('Item restored');
    },
    onError: (err: Error) => toast(err.message),
  });

  const purgeExpired = useMutation({
    mutationFn: () => api.post('/api/items/_y_/purge-expired'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...queryKeys.items.all, 'deleted'] });
      toast('Expired items purged');
    },
    onError: (err: Error) => toast(err.message),
  });

  const list = items ?? [];

  return (
    <div className="flex flex-col gap-3">
      {/* Top bar */}
      <div className="flex items-center justify-between">
        <span className="text-sm text-[var(--color-text-muted)]">
          {list.length} {list.length === 1 ? 'item' : 'items'}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => purgeExpired.mutate()}
          disabled={purgeExpired.isPending}
        >
          <Trash2 className="w-4 h-4" />
          Purge Expired
        </Button>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="flex flex-col gap-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 rounded-[var(--radius-lg)] bg-[var(--color-elevated)] animate-pulse" />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!isLoading && list.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-12 text-[var(--color-text-muted)]">
          <Trash2 className="w-8 h-8" />
          <p className="text-sm">Recycle bin is empty</p>
        </div>
      )}

      {/* Items */}
      {!isLoading && list.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {list.map((item) => {
            const days = daysUntil(item.purgeAt);
            return (
              <div
                key={item.id}
                className="flex items-start gap-3 p-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-card)]"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[var(--color-text)] truncate">{item.name}</p>
                  <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                    {locationLabel(item)}
                  </p>
                  <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
                    Deleted {new Date(item.deletedAt).toLocaleDateString()}
                  </p>
                  {days !== null && (
                    <p className="text-xs font-medium text-[var(--color-red)] mt-0.5">
                      {days === 0 ? 'Permanent deletion today' : `${days} day${days === 1 ? '' : 's'} until permanent deletion`}
                    </p>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => restore.mutate(item.id)}
                  disabled={restore.isPending}
                  className="flex-shrink-0"
                >
                  <RotateCcw className="w-4 h-4" />
                  Restore
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { RotateCcw, Trash2, Box, Package, MapPin } from 'lucide-react';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-client';
import { Button } from '@/components/ui/button';
import { ColHead } from '@/components/ui/col-head';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { useLayoutMode } from '@/hooks/use-layout-mode';

/**
 * The recycle bin, one row per DELETION rather than one row per swept-up item.
 *
 * Deleting an area used to produce hundreds of individual item rows, none of
 * which could actually be restored — their container had been deleted too, so
 * every Restore returned 409 forever. It is now one row that says
 * "Garage · with 4 bins, 340 items" and puts the whole thing back at once.
 */

type RootType = 'area' | 'container' | 'item';

interface DeleteBatch {
  id: number;
  rootType: RootType;
  rootId: number;
  rootName: string;
  propertyName: string | null;
  deletedAt: string;
  deletedByName: string | null;
  /** Days left in the 30-day window, computed server side. */
  daysLeft: number | null;
  areaCount: number;
  containerCount: number;
  itemCount: number;
}

const ICON: Record<RootType, typeof Box> = {
  area: MapPin,
  container: Box,
  item: Package,
};

const NOUN: Record<RootType, string> = {
  area: 'Area',
  container: 'Bin',
  item: 'Item',
};

/**
 * What is coming back with it. The root is itself one of the counts, so a plain
 * single item would otherwise read "with 1 item" — say nothing rather than pad.
 */
function describeContents(b: DeleteBatch): string | null {
  const parts: string[] = [];
  if (b.areaCount > 1) parts.push(`${b.areaCount} areas`);
  const bins = b.rootType === 'container' ? b.containerCount - 1 : b.containerCount;
  if (bins > 0) parts.push(`${bins} ${bins === 1 ? 'bin' : 'bins'}`);
  const items = b.rootType === 'item' ? b.itemCount - 1 : b.itemCount;
  if (items > 0) parts.push(`${items} ${items === 1 ? 'item' : 'items'}`);
  return parts.length ? `with ${parts.join(', ')}` : null;
}

export function RecycleBinList() {
  // Above every early return — hooks must run on each render.
  const wide = useLayoutMode() === 'sidebar';
  const qc = useQueryClient();
  const [purgeOpen, setPurgeOpen] = useState(false);

  const { data: batches, isLoading } = useQuery({
    queryKey: [...queryKeys.items.all, 'recycle'],
    queryFn: () => api.get<{ batches: DeleteBatch[] }>('/api/recycle/_x_/list'),
    select: (data) => data.batches ?? [],
  });

  function invalidateEverything() {
    qc.invalidateQueries({ queryKey: [...queryKeys.items.all, 'recycle'] });
    // A restore can return an area, its bins and their items in one go, so
    // every level is stale — not just the item list.
    qc.invalidateQueries({ queryKey: queryKeys.items.all });
    qc.invalidateQueries({ queryKey: queryKeys.containers.all });
    qc.invalidateQueries({ queryKey: queryKeys.areas.all });
    qc.invalidateQueries({ queryKey: queryKeys.properties.all });
  }

  const restore = useMutation({
    mutationFn: (batchId: number) => api.post(`/api/recycle/_y_/restore/${batchId}`),
    onSuccess: () => {
      invalidateEverything();
      toast.success('Restored');
    },
    // The server refuses with a message naming the ancestor to restore first,
    // and that instruction is now actually followable — surface it verbatim.
    onError: (err: Error) => toast(err.message),
  });

  const purgeExpired = useMutation({
    mutationFn: () => api.post('/api/items/_y_/purge-expired'),
    onSuccess: () => {
      invalidateEverything();
      toast('Expired items purged');
    },
    onError: (err: Error) => toast(err.message),
  });

  const list = batches ?? [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
          {isLoading ? 'Loading' : `${list.length} ${list.length === 1 ? 'deletion' : 'deletions'}`}
        </span>
        <Button variant="outline" size="sm" onClick={() => setPurgeOpen(true)} disabled={purgeExpired.isPending}>
          <Trash2 className="w-4 h-4" />
          Purge Expired
        </Button>
      </div>

      <ConfirmDialog
        open={purgeOpen}
        onOpenChange={setPurgeOpen}
        title="Permanently delete expired items?"
        description="Items past their 30-day recycle window will be permanently deleted. This cannot be undone."
        destructive
        confirmLabel="Delete permanently"
        isPending={purgeExpired.isPending}
        onConfirm={() => {
          purgeExpired.mutate();
          setPurgeOpen(false);
        }}
      />

      {isLoading && (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      )}

      {!isLoading && list.length === 0 && (
        <div className="flex flex-col items-center gap-1 py-10">
          <Trash2 className="w-6 h-6 text-[var(--color-text-muted)]" />
          <p className="font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
            Nothing deleted
          </p>
          <p className="font-mono text-[10px] text-[var(--color-text-muted)]">
            Deleted things wait here for 30 days
          </p>
        </div>
      )}

      {!isLoading && list.length > 0 && (
        <div className="flex flex-col">
          <ColHead>Deletions</ColHead>
          {/* Two columns at a desk. A deletion batch is a receipt line, and 30
              days of them is a long scroll at one per row. */}
          <div className={cn(wide && 'grid grid-cols-2 gap-x-6 items-start')}>
          {list.map((b) => {
            const Icon = ICON[b.rootType] ?? Package;
            const contents = describeContents(b);
            return (
              <div
                key={b.id}
                className="flex items-center gap-3 py-3 border-b border-[var(--color-rule)] last:border-b-0"
              >
                <Icon className="w-4 h-4 shrink-0 text-[var(--color-text-muted)]" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold truncate">{b.rootName}</p>
                  <p className="font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--color-text-muted)] truncate">
                    {NOUN[b.rootType] ?? 'Item'}
                    {contents ? ` · ${contents}` : ''}
                    {b.propertyName ? ` · ${b.propertyName}` : ''}
                  </p>
                  <p className="font-mono text-[10px] text-[var(--color-text-muted)]">
                    {new Date(b.deletedAt).toLocaleDateString()}
                    {b.deletedByName ? ` · ${b.deletedByName}` : ''}
                    {b.daysLeft != null && (
                      <span className="text-[var(--color-red)]">
                        {' · '}
                        {b.daysLeft <= 0 ? 'gone today' : `${b.daysLeft}d left`}
                      </span>
                    )}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => restore.mutate(b.id)}
                  disabled={restore.isPending}
                  className="shrink-0"
                >
                  <RotateCcw className="w-4 h-4" />
                  Restore
                </Button>
              </div>
            );
          })}
          </div>
        </div>
      )}
    </div>
  );
}

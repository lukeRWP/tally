import { useEffect, useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { RotateCcw, Trash2, Box, Package, MapPin, CheckSquare, Check } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
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

/** What restore's error payload might carry when the blocking ancestor is
 * itself named — same three-way shape as every other endpoint's `errors`
 * field (see lib/api.ts's ApiError doc comment): callers narrow it themselves. */
interface AncestorBlockErrors {
  ancestorType?: 'property' | 'area' | 'container';
  ancestorId?: number;
  ancestorName?: string;
}

function ancestorPath(type: 'property' | 'area' | 'container', id: number): string {
  switch (type) {
    case 'property': return `/property/${id}`;
    case 'area': return `/area/${id}`;
    case 'container': return `/container/${id}`;
  }
}

/**
 * Today, `errors` is always undefined here — recycle.routes.js calls
 * `error(res, err.message, err.statusCode)` with no fourth argument (see
 * recycle.service.js:_assertAncestorsLive, which only ever throws a plain
 * message like "Restore the area this was in first"), so this always falls
 * to the plain-message branch in production. It's written to also handle a
 * payload that does carry the ancestor — an id (rendered as a link) or just
 * a name — so nothing here needs to change if that payload ever grows one.
 * No server change accompanies this.
 */
function BlockedRestoreNotice({ error }: { error: unknown }) {
  const info = error instanceof ApiError ? (error.errors as AncestorBlockErrors | undefined) : undefined;

  let body: ReactNode;
  if (info?.ancestorId != null && info.ancestorType) {
    body = (
      <>
        Restore{' '}
        <Link to={ancestorPath(info.ancestorType, info.ancestorId)} className="underline hover:opacity-80">
          {info.ancestorName ?? 'its ancestor'}
        </Link>{' '}
        first
      </>
    );
  } else if (info?.ancestorName) {
    body = `Restore ${info.ancestorName} first`;
  } else {
    body = error instanceof Error ? error.message : 'Could not restore it';
  }

  return (
    <p className="font-mono text-[10px] text-[var(--color-red)] mt-1">
      {body}
    </p>
  );
}

export function RecycleBinList() {
  // Above every early return — hooks must run on each render.
  const wide = useLayoutMode() === 'sidebar';
  const qc = useQueryClient();
  const [purgeOpen, setPurgeOpen] = useState(false);
  // Select mode: minimal on purpose (#229) — a toggle, checkboxes and a
  // bulk Restore, no delete/tag here. Mirrors container-detail's select
  // mode (#231) at a much smaller scale.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [restoreProgress, setRestoreProgress] = useState<{ i: number; total: number } | null>(null);
  // Keyed by batch id — a failed restore (most commonly the ancestor-blocked
  // 409) renders inline on that row rather than as a toast, for both a
  // single-row Restore click and a bulk-restore loop failure alike.
  const [rowErrors, setRowErrors] = useState<Record<number, unknown>>({});

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
    onSuccess: (_data, batchId) => {
      invalidateEverything();
      setRowErrors((prev) => {
        if (!(batchId in prev)) return prev;
        const next = { ...prev };
        delete next[batchId];
        return next;
      });
    },
    // The server refuses with a message naming the ancestor to restore
    // first (recycle.service.js:_assertAncestorsLive) — stashed per-row so
    // it renders (as a link when the payload carries one — see
    // BlockedRestoreNotice) next to whichever row it blocked, for both a
    // single click and a bulk-restore loop failure alike.
    onError: (err, batchId) => {
      setRowErrors((prev) => ({ ...prev, [batchId]: err }));
    },
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

  // A background refetch can remove rows out from under an open selection —
  // prune ghosts so "N selected" only ever counts rows still here.
  useEffect(() => {
    if (!selecting) return;
    const valid = new Set(list.map((b) => b.id));
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => valid.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [selecting, batches]);

  function exitSelectMode() {
    setSelecting(false);
    setSelected(new Set());
  }

  function toggleSelected(batchId: number) {
    // Inert while the restore loop runs (#239) — mirrors container-detail's
    // toggleSelected: a mid-loop click would mutate `selected` only to have
    // the loop's own end-of-run `setSelected(new Set(failed))` silently
    // overwrite it moments later.
    if (bulkRunning) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(batchId)) next.delete(batchId);
      else next.add(batchId);
      return next;
    });
  }

  /**
   * Sequential, continue-on-failure, per-entity isolation: one blocked
   * restore (ancestor still deleted) does not stop the rest of the batch.
   * Failed rows stay selected — same discipline as container-detail's
   * runBulkDelete — with the specific reason visible inline on each one via
   * rowErrors/BlockedRestoreNotice.
   */
  async function runBulkRestore() {
    const targets = [...selected];
    if (targets.length === 0) return;

    let ok = 0;
    const failed: number[] = [];
    for (let idx = 0; idx < targets.length; idx++) {
      setRestoreProgress({ i: idx + 1, total: targets.length });
      const batchId = targets[idx];
      try {
        await restore.mutateAsync(batchId);
        ok += 1;
      } catch {
        failed.push(batchId);
      }
    }

    setRestoreProgress(null);
    setSelected(new Set(failed));
    toast(failed.length ? `Restored ${ok} · ${failed.length} failed` : `Restored ${ok}`);
  }

  const bulkRunning = !!restoreProgress;

  // Same gate as toggleSelected (#239) — the "All" button is already
  // disabled while bulkRunning, but this keeps the function itself honest
  // independent of that, matching container-detail.tsx's shape.
  function handleSelectAll() {
    if (bulkRunning) return;
    setSelected(new Set(list.map((b) => b.id)));
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
          {isLoading ? 'Loading' : `${list.length} ${list.length === 1 ? 'deletion' : 'deletions'}`}
        </span>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setPurgeOpen(true)} disabled={purgeExpired.isPending || bulkRunning}>
            <Trash2 className="w-4 h-4" />
            Purge Expired
          </Button>
          {list.length > 0 && (
            <Button
              variant={selecting ? 'default' : 'outline'}
              size="sm"
              onClick={() => (selecting ? exitSelectMode() : setSelecting(true))}
              disabled={bulkRunning}
            >
              <CheckSquare className="w-4 h-4" />
              Select
            </Button>
          )}
        </div>
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
            const isSelected = selected.has(b.id);
            return (
              <div
                key={b.id}
                className="flex items-center gap-3 py-3 border-b border-[var(--color-rule)] last:border-b-0"
                onClick={selecting ? () => toggleSelected(b.id) : undefined}
                role={selecting ? 'button' : undefined}
                tabIndex={selecting ? 0 : undefined}
                aria-pressed={selecting ? isSelected : undefined}
                aria-label={selecting ? `Select ${b.rootName}` : undefined}
                onKeyDown={selecting ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleSelected(b.id);
                  }
                } : undefined}
              >
                {selecting && (
                  <span
                    className={cn(
                      'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[2px] border-[1.6px]',
                      isSelected
                        ? 'border-[var(--color-text)] bg-[var(--color-text)] text-[var(--color-bg)]'
                        : 'border-[var(--color-text)] text-transparent',
                    )}
                  >
                    <Check className="h-3 w-3" strokeWidth={3} />
                  </span>
                )}
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
                  {rowErrors[b.id] !== undefined && <BlockedRestoreNotice error={rowErrors[b.id]} />}
                </div>
                {!selecting && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => restore.mutate(b.id, { onSuccess: () => toast.success('Restored') })}
                    disabled={restore.isPending}
                    className="shrink-0"
                  >
                    <RotateCcw className="w-4 h-4" />
                    Restore
                  </Button>
                )}
              </div>
            );
          })}
          </div>
        </div>
      )}

      {/* Select-mode action bar — mirrors container-detail's, at the minimum
          this page needs: count, All/Cancel, and the one bulk action. */}
      {selecting && (
        <div className="fixed bottom-[calc(5.5rem+env(safe-area-inset-bottom))] lg:bottom-8 left-4 right-4 lg:left-auto lg:right-8 lg:w-[24rem] z-30 bg-[var(--color-card)] border-2 border-[var(--color-text)] rounded-[var(--radius-md)] shadow-lg px-3 py-2.5 flex flex-wrap items-center gap-2">
          <p className="font-mono text-xs uppercase tracking-[0.06em] text-[var(--color-text)] flex-1 min-w-0 truncate tabular-nums">
            {selected.size} selected
          </p>
          <Button variant="ghost" size="sm" onClick={handleSelectAll} disabled={bulkRunning}>
            All
          </Button>
          <Button variant="outline" size="sm" onClick={exitSelectMode} disabled={bulkRunning}>
            Cancel
          </Button>
          <Button size="sm" variant="outline" disabled={selected.size === 0 || bulkRunning} onClick={runBulkRestore}>
            <RotateCcw className="w-4 h-4" />
            {restoreProgress ? `Restoring… ${restoreProgress.i} of ${restoreProgress.total}` : `Restore ${selected.size}`}
          </Button>
        </div>
      )}
    </div>
  );
}

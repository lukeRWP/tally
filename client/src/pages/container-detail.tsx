import * as React from 'react';
import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ScanLine, Printer, Share2, Plus, Package, Box, CheckSquare, Camera, MoveRight, Trash2, Tag as TagIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { TitleBar } from '@/components/ui/title-bar';
import { ColHead } from '@/components/ui/col-head';
import { Skeleton } from '@/components/ui/skeleton';
import { Breadcrumbs } from '@/components/layout/breadcrumbs';
import { ContainerCard } from '@/components/inventory/container-card';
import { ItemCard } from '@/components/inventory/item-card';
import { EntityForm } from '@/components/inventory/entity-form';
import { ErrorState, SectionError } from '@/components/ui/error-state';
import {
  useContainer,
  useContainerChildren,
  useItems,
  useCreateContainer,
  useCreateItem,
  useDeleteContainer,
  useDeleteItem,
} from '@/hooks/use-inventory';
import { useAddTag } from '@/hooks/use-tags';
import { toast } from '@/components/ui/toast';
import { TagPicker } from '@/components/tags/tag-picker';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { LabelPrintDialog } from '@/components/labels/label-print-dialog';
import { ShareDialog } from '@/components/sharing/share-dialog';
import { usePrintQueueStore } from '@/store/print-queue-store';
import { useCarryStore } from '@/store/carry-store';
import type { Item } from '@/types/inventory';
import { cn } from '@/lib/utils';
import { useLayoutMode } from '@/hooks/use-layout-mode';
import { useKeyboardNav, useNavScrollIntoView } from '@/hooks/use-keyboard-nav';

export function ContainerDetail() {
  // Above every early return — hooks must run on each render.
  const wide = useLayoutMode() === 'sidebar';
  const { containerId } = useParams<{ containerId: string }>();
  const id = Number(containerId);
  const navigate = useNavigate();

  const [createType, setCreateType] = useState<'container' | 'item' | null>(null);
  const [fabOpen, setFabOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // Select mode: checkboxes over the item/nested-container cards, feeding the
  // print-queue staging area in one batch instead of a dialog per label.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Bulk delete/tag from select mode (#231): one confirm/picker for the whole
  // selection instead of a per-row round trip. Progress is tracked separately
  // per action so "N of total" and the disabled state are always about
  // whichever loop is actually running.
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkTagOpen, setBulkTagOpen] = useState(false);
  const [deleteProgress, setDeleteProgress] = useState<{ i: number; total: number } | null>(null);
  const [tagProgress, setTagProgress] = useState<{ i: number; total: number } | null>(null);
  // Snapshotted once when the Tag dialog opens (fix round 1, #231 review):
  // runBulkTag drops succeeded items from `selected` after every apply so
  // the page's own selection state stays truthful, but the dialog stays
  // open to let one visit apply more than one tag. Deriving the loop's
  // target list straight from `selected` meant a second apply, in the same
  // visit, over a selection the first apply had already fully succeeded on,
  // saw zero items and silently no-opped. This snapshot is the dialog's own
  // working set — untouched by the loop, so a retry-apply (including one
  // that failed last time) always reaches the whole original selection.
  const [bulkTagTargets, setBulkTagTargets] = useState<Item[]>([]);

  // Navigating bin→bin only changes :containerId — the component stays
  // mounted, so without this a selection from the previous bin leaks in.
  useEffect(() => {
    setSelecting(false);
    setSelected(new Set());
  }, [id]);

  const { data: container, isLoading: containerLoading, isError: containerError, refetch: refetchContainer } = useContainer(id);
  const { data: children, isLoading: childrenLoading, isError: childrenError, refetch: refetchChildren } = useContainerChildren(id);
  const { data: items, isLoading: itemsLoading, isError: itemsError, refetch: refetchItems } = useItems(id);
  const createContainer = useCreateContainer();
  const createItem = useCreateItem();
  const stageMany = usePrintQueueStore((s) => s.addMany);
  const deleteContainer = useDeleteContainer();
  const deleteItem = useDeleteItem();
  const addTag = useAddTag();
  const pickUp = useCarryStore((s) => s.pickUp);
  const carried = useCarryStore((s) => s.carried);

  /**
   * The ring j/k walks: nested bins THEN item rows, exactly as rendered below.
   * Deriving this straight from the same arrays the JSX maps over means it
   * can never drift from what is actually on screen.
   *
   * Grid linearity (#235): the wide layout draws each section as
   * `grid-cols-2` with the DEFAULT auto-flow (row), which places DOM children
   * row-major — so this DOM-ordered ring IS the grid's reading order (left,
   * right, next row), like text. That equivalence is what keeps j/k sane in
   * two columns; switching either grid to `grid-flow-col` would silently
   * break it (the ring would stride visually by rows while the cards read by
   * columns) and is pinned against in container-detail.keyboard-nav.test.tsx.
   */
  const visibleOrder = React.useMemo(() => [
    ...(children ?? []).map((c) => ({ type: 'container' as const, id: c.id })),
    ...(items ?? []).map((i) => ({ type: 'item' as const, id: i.id })),
  ], [children, items]);
  const visibleKeys = React.useMemo(
    () => visibleOrder.map((e) => `${e.type}:${e.id}`),
    [visibleOrder],
  );

  /**
   * Tracked by (type, id) key, not index — an index survives a bulk delete
   * (#231) shrinking the list right out from under it and silently ends up
   * pointing at whatever row now occupies that slot instead. Mirrors the
   * by-id ring in matches.tsx.
   */
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null);

  // Navigating bin -> bin keeps the component mounted (same as the select-mode
  // reset above) — without this a highlighted row from the PREVIOUS bin would
  // still point at something here, just not the thing the user was looking at.
  useEffect(() => { setHighlightedKey(null); }, [id]);

  // Reconcile only when the highlighted row itself is gone (bulk delete, or
  // any other removal) — a poll/refetch that leaves it in place, even under
  // a brand new array reference, must not touch the cursor at all.
  useEffect(() => {
    if (highlightedKey != null && !visibleKeys.includes(highlightedKey)) {
      setHighlightedKey(null);
    }
  }, [visibleKeys, highlightedKey]);

  const moveHighlight = React.useCallback((delta: 1 | -1) => {
    if (visibleKeys.length === 0) return;
    const at = highlightedKey == null ? -1 : visibleKeys.indexOf(highlightedKey);
    const next = at === -1
      ? (delta === 1 ? 0 : visibleKeys.length - 1)
      : Math.min(visibleKeys.length - 1, Math.max(0, at + delta));
    setHighlightedKey(visibleKeys[next]);
  }, [visibleKeys, highlightedKey]);

  const highlighted = highlightedKey != null
    ? visibleOrder[visibleKeys.indexOf(highlightedKey)] ?? null
    : null;

  useKeyboardNav({
    // Off while the batch-select checkboxes are up — Enter jumping to a whole
    // other page would fight the "pick several, then act" flow that mode is
    // for, and off entirely on touch chrome, where there is no keyboard.
    enabled: wide && !selecting,
    onMove: moveHighlight,
    onOpen: () => {
      if (!highlighted) return false;
      navigate(highlighted.type === 'container' ? `/container/${highlighted.id}` : `/item/${highlighted.id}`);
      return true;
    },
    onEscape: () => setHighlightedKey(null),
  });
  // Keeps the cursor on screen in a bin longer than the viewport (#235) — the
  // row wrappers below carry the matching data-nav-id (same (type, id) key).
  useNavScrollIntoView(highlightedKey);

  // A background refetch (30s staleTime + refetch-on-focus) can remove rows
  // out from under an open selection — prune ghosts so the "N selected"
  // count only ever counts rows that are still here.
  useEffect(() => {
    if (!selecting) return;
    const valid = new Set([
      ...(children ?? []).map((c) => `container:${c.id}`),
      ...(items ?? []).map((i) => `item:${i.id}`),
    ]);
    setSelected((prev) => {
      const next = new Set([...prev].filter((k) => valid.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [selecting, children, items]);

  /**
   * The last row toggled ON, which is what a shift-click measures from.
   * Cleared when selection is emptied so a stale anchor cannot select a range
   * across a list the user has since left.
   */
  const anchor = React.useRef<string | null>(null);

  function toggleSelected(key: string, shift = false) {
    setSelected((prev) => {
      const next = new Set(prev);

      // Shift-click selects everything between the anchor and here, in the
      // order the rows are DRAWN — bins then items, exactly as on screen.
      // Without that order a range would jump around the page.
      if (shift && anchor.current && anchor.current !== key) {
        const order = [
          ...(children ?? []).map((c) => `container:${c.id}`),
          ...(items ?? []).map((i) => `item:${i.id}`),
        ];
        const from = order.indexOf(anchor.current);
        const to = order.indexOf(key);
        if (from !== -1 && to !== -1) {
          const [lo, hi] = from < to ? [from, to] : [to, from];
          // Additive, never subtractive: shift-clicking is how you GROW a
          // selection, and silently dropping rows you had already picked is
          // the behaviour people find out about by losing work.
          for (let i = lo; i <= hi; i++) next.add(order[i]);
          return next;
        }
      }

      if (next.has(key)) next.delete(key);
      else { next.add(key); anchor.current = key; }
      if (next.size === 0) anchor.current = null;
      return next;
    });
  }

  function exitSelectMode() {
    setSelecting(false);
    setSelected(new Set());
  }

  function handleCreateContainer(data: Record<string, unknown>) {
    if (!container) return;
    return createContainer.mutateAsync(
      { ...data, areaId: container.areaId, parentContainerId: id } as {
        name: string;
        type: string;
        description?: string;
        areaId: number;
        parentContainerId: number;
      },
    )
      .then(() => toast('Container created'))
      .catch((err: Error) => { toast(err.message); throw err; });
  }

  function handleCreateItem(data: Record<string, unknown>) {
    return createItem.mutateAsync(
      { ...data, containerId: id } as {
        name: string;
        description?: string;
        containerId: number;
        quantity?: number;
        purchasePrice?: number;
        condition?: string;
      },
    )
      .then(() => toast('Item created'))
      .catch((err: Error) => { toast(err.message); throw err; });
  }

  if (containerLoading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-8 w-36" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  if (containerError) {
    return <ErrorState message="Couldn't load this container." onRetry={() => refetchContainer()} />;
  }

  if (!container) {
    return <p className="text-sm text-[var(--color-text-muted)] text-center py-8">Container not found.</p>;
  }

  const propertyId = (container as unknown as { propertyId?: number }).propertyId
    ?? container.breadcrumb?.find((b) => b.type === 'property')?.id
    ?? 0;

  const hasTags = propertyId > 0;

  // Build full breadcrumb: property > area > ancestor containers
  const breadcrumbItems: import('@/types/inventory').BreadcrumbItem[] = [];
  const ext = container as unknown as { propertyId?: number; propertyName?: string; areaName?: string };
  if (ext.propertyId && ext.propertyName) {
    breadcrumbItems.push({ id: ext.propertyId, name: ext.propertyName, type: 'property' });
  }
  if (container.areaId && ext.areaName) {
    breadcrumbItems.push({ id: container.areaId, name: ext.areaName, type: 'area' });
  }
  // Ancestor containers from the closure table (already ordered top-down)
  if (container.breadcrumb?.length > 0) {
    for (const bc of container.breadcrumb) {
      breadcrumbItems.push({ id: bc.id, name: bc.name, type: 'container' });
    }
  }

  function handleAddSelected() {
    const inputs = [
      ...(children ?? [])
        .filter((c) => selected.has(`container:${c.id}`))
        .map((c) => ({
          id: c.id,
          entityType: 'container' as const,
          name: c.name,
          qrCode: c.qrCode,
          propertyId: propertyId > 0 ? propertyId : undefined,
        })),
      ...(items ?? [])
        .filter((i) => selected.has(`item:${i.id}`))
        .map((i) => ({
          id: i.id,
          entityType: 'item' as const,
          name: i.name,
          qrCode: i.qrCode,
          propertyId: propertyId > 0 ? propertyId : undefined,
        })),
    ];
    if (inputs.length === 0) {
      // Selection outlived the rows (deleted/moved elsewhere mid-selection).
      toast('Those rows are no longer in this bin');
      exitSelectMode();
      return;
    }
    const added = stageMany(inputs);
    toast(
      added > 0
        ? `${added} label${added === 1 ? '' : 's'} added to the print queue`
        : 'All of these are already in the print queue',
    );
    exitSelectMode();
  }

  // Flow C: hand the selection to the carry banner, then send the user off to
  // scan a destination. A selection can mix loose items and nested bins; the
  // carried load records what each one is so the destination scan knows
  // whether to move an item or re-parent a subtree.
  function handleMoveSelected() {
    const pickedItems = (items ?? []).filter((i) => selected.has(`item:${i.id}`));
    const pickedBins = (children ?? []).filter((c) => selected.has(`container:${c.id}`));
    if (pickedItems.length + pickedBins.length === 0) {
      toast('Select something to move first');
      return;
    }
    pickUp([
      ...pickedBins.map((c) => ({
        id: c.id,
        name: c.name,
        kind: 'container' as const,
        fromContainerId: id,
        fromContainerName: container?.name,
        fromAreaId: c.areaId,
      })),
      ...pickedItems.map((i) => ({
        id: i.id,
        name: i.name,
        kind: 'item' as const,
        fromContainerId: id,
        fromContainerName: container?.name,
        fromAreaId: container?.areaId,
      })),
    ]);
    exitSelectMode();
    const n = pickedItems.length + pickedBins.length;
    toast(`Carrying ${n} thing${n === 1 ? '' : 's'} — scan where they go`);
    navigate('/move');
  }

  /**
   * Move THIS bin. Its origin is its parent container if it is nested, or its
   * area if it sits at the top level — undo needs to know which.
   */
  function handleMoveThis() {
    if (!container) return;
    pickUp([{
      id: container.id,
      name: container.name,
      kind: 'container',
      ...(container.parentContainerId ? { fromContainerId: container.parentContainerId } : {}),
      fromAreaId: container.areaId,
    }]);
    toast(`Carrying ${container.name} — scan an area or a bin to put it in`);
    navigate('/move');
  }

  function confirmDelete() {
    if (!container) return;
    deleteContainer.mutate(id, {
      onSuccess: () => {
        setDeleteOpen(false);
        toast('Moved to the recycle bin');
        // Back to the area — this page's subject no longer exists.
        navigate(`/area/${container.areaId}`);
      },
      onError: (err: unknown) =>
        toast(err instanceof Error ? err.message : 'Could not delete it'),
    });
  }

  function handleSelectAll() {
    setSelected(
      new Set([
        ...(children ?? []).map((c) => `container:${c.id}`),
        ...(items ?? []).map((i) => `item:${i.id}`),
      ]),
    );
  }

  const pickedItemsForBulk = (items ?? []).filter((i) => selected.has(`item:${i.id}`));
  const pickedBinsForBulk = (children ?? []).filter((c) => selected.has(`container:${c.id}`));

  /**
   * Sequential, continue-on-failure: one entity's 500 does not stop the rest
   * of the batch. Bins go first, then items — the same order shift-click
   * ranges over — purely so the progress count means something; either kind
   * can fail independently of the other.
   */
  async function runBulkDelete() {
    const targets = [
      ...pickedBinsForBulk.map((c) => ({ key: `container:${c.id}`, id: c.id, kind: 'container' as const })),
      ...pickedItemsForBulk.map((i) => ({ key: `item:${i.id}`, id: i.id, kind: 'item' as const })),
    ];
    if (targets.length === 0) return;

    // Close now, not on completion — a modal dialog marks everything behind
    // it aria-hidden and unclickable, which would bury the progress label
    // and the disabled state on the select-mode bar for the whole loop.
    setBulkDeleteOpen(false);

    const failed: string[] = [];
    let ok = 0;
    for (let idx = 0; idx < targets.length; idx++) {
      setDeleteProgress({ i: idx + 1, total: targets.length });
      const t = targets[idx];
      try {
        if (t.kind === 'item') await deleteItem.mutateAsync(t.id);
        else await deleteContainer.mutateAsync(t.id);
        ok += 1;
      } catch {
        failed.push(t.key);
      }
    }

    setDeleteProgress(null);
    // Failed rows stay selected — the point of the batch is that the user
    // shouldn't have to remember which ones didn't take. Everything else
    // is gone from the underlying lists once the invalidated queries
    // refetch, so there is nothing left to keep selected for it.
    setSelected(new Set(failed));
    toast(failed.length ? `Deleted ${ok} · ${failed.length} failed` : `Deleted ${ok}`);
  }

  /**
   * Additive per-item tag apply, over the dialog's own snapshot
   * (`bulkTagTargets`) — NOT the live selection. Containers are never
   * touched — tags are an item concept here — so they were never part of
   * the snapshot and stay selected exactly as they were.
   */
  async function runBulkTag(tagId: number) {
    if (bulkTagTargets.length === 0) return;

    const failed = new Set<number>();
    let ok = 0;
    for (let idx = 0; idx < bulkTagTargets.length; idx++) {
      setTagProgress({ i: idx + 1, total: bulkTagTargets.length });
      const it = bulkTagTargets[idx];
      try {
        await addTag.mutateAsync({ tagId, entityType: 'item', entityId: it.id });
        ok += 1;
      } catch {
        failed.add(it.id);
      }
    }

    setTagProgress(null);
    setSelected((prev) => {
      const next = new Set(prev);
      for (const it of bulkTagTargets) {
        if (!failed.has(it.id)) next.delete(`item:${it.id}`);
      }
      return next;
    });
    toast(failed.size ? `Tagged ${ok} · ${failed.size} failed` : `Tagged ${ok}`);
  }

  const selectable = (children?.length ?? 0) + (items?.length ?? 0) > 0;
  const bulkRunning = !!deleteProgress || !!tagProgress;

  const bulkDeleteParts: string[] = [];
  if (pickedItemsForBulk.length > 0) {
    bulkDeleteParts.push(`${pickedItemsForBulk.length} item${pickedItemsForBulk.length === 1 ? '' : 's'}`);
  }
  if (pickedBinsForBulk.length > 0) {
    bulkDeleteParts.push(`${pickedBinsForBulk.length} bin${pickedBinsForBulk.length === 1 ? '' : 's'}`);
  }
  const bulkDeleteTitle = `Delete ${bulkDeleteParts.join(' and ') || 'the selection'}?`;
  // Nested bins cascade their own contents on delete (server-side, always —
  // there is no 409 here, see containers.service.js softDelete). Only worth
  // saying out loud when it would actually do something.
  const bulkDeleteCascades = pickedBinsForBulk.some((c) => (c.containerCount ?? 0) > 0 || (c.itemCount ?? 0) > 0);
  const bulkDeleteDescription = "They'll move to the recycle bin, where you can put them back for 30 days."
    + (bulkDeleteCascades ? ' Nested bins bring their contents with them.' : '');

  return (
    <div className="flex flex-col gap-4 pb-16">
      {/* Breadcrumbs */}
      <Breadcrumbs items={breadcrumbItems} />

      {/* Header — inverted title bar, mono code + type badge */}
      <div className="animate-fade-up flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <TitleBar>{container.name}</TitleBar>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-[var(--color-text-muted)]">{container.qrCode}</span>
          <Badge variant="warning">{container.type}</Badge>
        </div>
        {container.description && (
          <p className="text-sm text-[var(--color-text-secondary)] mt-1">{container.description}</p>
        )}
      </div>

      {/* Action Bar — thermal outline buttons */}
      <div className="flex flex-wrap gap-2 animate-fade-up" style={{ animationDelay: '50ms' }}>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            // /capture reads these params and pre-pins this bin as the destination — /scan reads none of them (the old target silently discarded the context).
            // propertyId is the const computed above from the flat field the
            // real getById serves — container.breadcrumb holds ancestor
            // CONTAINERS ({id,name}, no type), so its [0].id was never a
            // property: empty for a top-level bin, a container id for a
            // nested one, and /capture now actually reads what it is handed.
            navigate(`/capture?containerId=${id}&areaId=${container.areaId}&propertyId=${propertyId || ''}`);
          }}
        >
          <ScanLine className="w-4 h-4" />
          Scan in
        </Button>
        <Button variant="outline" size="sm" onClick={() => setPrintOpen(true)}>
          <Printer className="w-4 h-4" />
          Label
        </Button>
        <Button variant="outline" size="sm" onClick={handleMoveThis}>
          <MoveRight className="w-4 h-4" />
          Move
        </Button>
        <Button variant="outline" size="sm" onClick={() => setShareOpen(true)}>
          <Share2 className="w-4 h-4" />
          Share
        </Button>
        <Button variant="outline" size="sm" onClick={() => setDeleteOpen(true)}>
          <Trash2 className="w-4 h-4" />
          Delete
        </Button>
        {selectable && (
          <Button
            variant={selecting ? 'default' : 'outline'}
            size="sm"
            onClick={() => {
              // The FAB is hidden while selecting but its open-menu state is
              // not — without this it reappears pre-expanded after Cancel.
              setFabOpen(false);
              if (selecting) exitSelectMode();
              else setSelecting(true);
            }}
          >
            <CheckSquare className="w-4 h-4" />
            Select
          </Button>
        )}
      </div>

      {/* Tags -- collapsed single line when empty */}
      {hasTags && (
        <div className="animate-fade-up" style={{ animationDelay: '100ms' }}>
          <TagPicker entityType="container" entityId={container.id} propertyId={propertyId} />
        </div>
      )}

      {/* Nested Containers */}
      <section className="animate-fade-up flex flex-col" style={{ animationDelay: '150ms' }}>
        <ColHead>Nested · {children?.length ?? 0}</ColHead>

        {childrenLoading && <Skeleton className="h-14 w-full mt-2" />}

        {childrenError && (
          <SectionError message="Couldn't load nested containers." onRetry={() => refetchChildren()} />
        )}

        {!childrenLoading && !childrenError && children && children.length === 0 && (
          <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-[var(--color-text-muted)] py-3">
            No nested containers
          </p>
        )}

        {/* Two columns at a desk: a ruled row stretched to 1400px puts its
            chevron a screen away from its name, and a bin's contents are the
            reason you opened the page — worth seeing more of at once. */}
        <div className={cn(wide && 'grid grid-cols-2 gap-x-6')}>
        {children?.map((child) => (
          <div
            key={child.id}
            data-nav-id={`container:${child.id}`}
            className={cn(
              'rounded-[var(--radius-sm)] border-b border-[var(--color-rule)] last:border-b-0',
              highlighted?.type === 'container' && highlighted.id === child.id
                && 'bg-[var(--color-elevated)] ring-1 ring-[var(--color-text)]',
            )}
          >
            <ContainerCard
              container={child}
              selectable={selecting}
              selected={selected.has(`container:${child.id}`)}
              onToggle={(shift) => toggleSelected(`container:${child.id}`, shift)}
            />
          </div>
        ))}
        </div>
      </section>

      {/* Items */}
      <section className="animate-fade-up flex flex-col" style={{ animationDelay: '200ms' }}>
        <ColHead>Items · {items?.length ?? 0}</ColHead>

        {itemsLoading && <Skeleton className="h-14 w-full mt-2" />}

        {itemsError && (
          <SectionError message="Couldn't load items." onRetry={() => refetchItems()} />
        )}

        {!itemsLoading && !itemsError && items && items.length === 0 && (
          <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-[var(--color-text-muted)] py-3">
            No items in this container
          </p>
        )}

        <div className={cn(wide && 'grid grid-cols-2 gap-x-6')}>
        {items?.map((item) => (
          <div
            key={item.id}
            data-nav-id={`item:${item.id}`}
            className={cn(
              'rounded-[var(--radius-sm)] border-b border-[var(--color-rule)] last:border-b-0',
              highlighted?.type === 'item' && highlighted.id === item.id
                && 'bg-[var(--color-elevated)] ring-1 ring-[var(--color-text)]',
            )}
          >
            <ItemCard
              item={item}
              selectable={selecting}
              selected={selected.has(`item:${item.id}`)}
              onToggle={(shift) => toggleSelected(`item:${item.id}`, shift)}
            />
          </div>
        ))}
        </div>
      </section>

      {/* Select-mode action bar — replaces the FAB so the two never overlap.
          flex-wrap: Move/Tag/Delete/Queue plus All/Cancel no longer fit one
          line on a phone now that Tag and Delete joined Move and Queue. */}
      {selecting && (
        <div className="fixed bottom-[calc(5.5rem+env(safe-area-inset-bottom))] lg:bottom-8 left-4 right-4 lg:left-auto lg:right-8 lg:w-[26rem] z-30 bg-[var(--color-card)] border-2 border-[var(--color-text)] rounded-[var(--radius-md)] shadow-lg px-3 py-2.5 flex flex-wrap items-center gap-2">
          <p className="font-mono text-xs uppercase tracking-[0.06em] text-[var(--color-text)] flex-1 min-w-0 truncate tabular-nums">
            {selected.size} selected
          </p>
          <Button variant="ghost" size="sm" onClick={handleSelectAll} disabled={bulkRunning}>
            All
          </Button>
          <Button variant="outline" size="sm" onClick={exitSelectMode} disabled={bulkRunning}>
            Cancel
          </Button>
          <Button size="sm" variant="outline" disabled={selected.size === 0 || bulkRunning} onClick={handleMoveSelected}>
            Move
          </Button>
          {hasTags && (
            <Button
              size="sm"
              variant="outline"
              disabled={selected.size === 0 || bulkRunning}
              onClick={() => {
                // Snapshot NOW — this is the dialog's own working set for
                // the whole visit, independent of `selected` shrinking as
                // applies succeed (see bulkTagTargets above).
                setBulkTagTargets(pickedItemsForBulk);
                setBulkTagOpen(true);
              }}
            >
              <TagIcon className="w-4 h-4" />
              {tagProgress ? `Tagging… ${tagProgress.i} of ${tagProgress.total}` : 'Tag'}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={selected.size === 0 || bulkRunning}
            onClick={() => setBulkDeleteOpen(true)}
          >
            <Trash2 className="w-4 h-4" />
            {deleteProgress ? `Deleting… ${deleteProgress.i} of ${deleteProgress.total}` : 'Delete'}
          </Button>
          <Button size="sm" disabled={selected.size === 0 || bulkRunning} onClick={handleAddSelected}>
            Queue
          </Button>
        </div>
      )}

      {/* FAB — hidden while carrying: the carry banner occupies that corner, and
          finishing the move is the active job. It returns when you put down. */}
      {!selecting && carried.length === 0 && (
      <div className="fixed bottom-[calc(6rem+env(safe-area-inset-bottom))] lg:bottom-8 right-4 lg:right-8 flex flex-col items-end gap-2 z-30">
        {fabOpen && (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => { setCreateType('container'); setFabOpen(false); }}
              className="bg-[var(--color-card)] shadow-lg animate-scale-in"
            >
              <Package className="w-4 h-4" />
              Add Container
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => { setCreateType('item'); setFabOpen(false); }}
              className="bg-[var(--color-card)] shadow-lg animate-scale-in"
              style={{ animationDelay: '30ms' }}
            >
              <Box className="w-4 h-4" />
              Add Item
            </Button>
            {/* The capture loop, pre-pinned to this bin: picture → scan → done */}
            <Button
              size="sm"
              onClick={() => {
                try {
                  localStorage.setItem('tally-last-container', JSON.stringify({
                    id, name: container?.name ?? `#${id}`,
                    areaId: container?.areaId, propertyId: propertyId > 0 ? propertyId : undefined,
                  }));
                } catch { /* private mode */ }
                navigate('/capture');
              }}
              className="shadow-lg animate-scale-in"
              style={{ animationDelay: '60ms' }}
            >
              <Camera className="w-4 h-4" />
              Capture
            </Button>
          </>
        )}
        <Button onClick={() => setFabOpen(!fabOpen)} className="shadow-lg">
          <Plus className={`w-4 h-4 transition-transform duration-200 ${fabOpen ? 'rotate-45' : ''}`} />
          Add
        </Button>
      </div>
      )}

      {/* Create Dialogs */}
      <EntityForm
        open={createType === 'container'}
        onOpenChange={(open) => !open && setCreateType(null)}
        type="container"
        onSubmit={handleCreateContainer}
        isPending={createContainer.isPending}
      />
      <EntityForm
        open={createType === 'item'}
        onOpenChange={(open) => !open && setCreateType(null)}
        type="item"
        onSubmit={handleCreateItem}
        isPending={createItem.isPending}
      />
      <LabelPrintDialog
        entities={[{
          id: container.id,
          name: container.name,
          qrCode: container.qrCode,
          type: 'container',
          breadcrumb: container.breadcrumb.map((b) => b.name).join(' > '),
        }]}
        entityType="container"
        isOpen={printOpen}
        onOpenChange={setPrintOpen}
        propertyId={propertyId > 0 ? propertyId : undefined}
      />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete "${container.name}"?`}
        description={
          `This moves the bin${(container.containerCount ?? 0) > 0 ? `, its ${container.containerCount} nested ${container.containerCount === 1 ? 'bin' : 'bins'}` : ''}` +
          ` and ${container.itemCount ?? 0} ${(container.itemCount ?? 0) === 1 ? 'item' : 'items'} to the recycle bin, where you can put it all back for 30 days.`
        }
        destructive
        confirmLabel="Delete"
        isPending={deleteContainer.isPending}
        onConfirm={confirmDelete}
      />

      <ShareDialog
        entityType="container"
        entityId={container.id}
        entityName={container.name}
        isOpen={shareOpen}
        onOpenChange={setShareOpen}
      />

      <ConfirmDialog
        open={bulkDeleteOpen}
        // Ignored while a loop is running — Escape/backdrop must not be able
        // to dismiss the dialog out from under an in-flight batch.
        onOpenChange={(open) => { if (!deleteProgress) setBulkDeleteOpen(open); }}
        title={bulkDeleteTitle}
        description={bulkDeleteDescription}
        destructive
        confirmLabel="Delete"
        isPending={!!deleteProgress}
        onConfirm={runBulkDelete}
      />

      {hasTags && (
        <Dialog open={bulkTagOpen} onOpenChange={(open) => { if (!tagProgress) setBulkTagOpen(open); }}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              {/* bulkTagTargets, not pickedItemsForBulk: the latter shrinks
                  as each apply succeeds and would read "Tag 0 items" right
                  after the first one, even though this dialog stays open to
                  take a second tag against the same original selection. */}
              <DialogTitle className="text-base font-semibold text-[var(--color-text)]">
                Tag {bulkTagTargets.length} item{bulkTagTargets.length === 1 ? '' : 's'}
              </DialogTitle>
              <DialogDescription className="text-sm text-[var(--color-text-secondary)]">
                Adds a tag to every selected item — it never removes tags they already have.
              </DialogDescription>
            </DialogHeader>
            {pickedBinsForBulk.length > 0 && (
              <p className="text-xs text-[var(--color-text-muted)]">
                Tags apply to items — skipping {pickedBinsForBulk.length} bin{pickedBinsForBulk.length === 1 ? '' : 's'}.
              </p>
            )}
            <TagPicker
              entityType="item"
              entityId={0}
              propertyId={propertyId}
              batchMode={{ onApply: runBulkTag, busy: !!tagProgress }}
            />
            {tagProgress && (
              <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-[var(--color-text-muted)] mt-3">
                Tagging… {tagProgress.i} of {tagProgress.total}
              </p>
            )}
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

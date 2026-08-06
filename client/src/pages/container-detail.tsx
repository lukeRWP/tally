import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ScanLine, Printer, Share2, Plus, Package, Box, CheckSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { TitleBar } from '@/components/ui/title-bar';
import { ColHead } from '@/components/ui/col-head';
import { Skeleton } from '@/components/ui/skeleton';
import { Breadcrumbs } from '@/components/layout/breadcrumbs';
import { ContainerCard } from '@/components/inventory/container-card';
import { ItemCard } from '@/components/inventory/item-card';
import { EntityForm } from '@/components/inventory/entity-form';
import { ErrorState } from '@/components/ui/error-state';
import {
  useContainer,
  useContainerChildren,
  useItems,
  useCreateContainer,
  useCreateItem,
} from '@/hooks/use-inventory';
import { toast } from '@/components/ui/toast';
import { TagPicker } from '@/components/tags/tag-picker';
import { LabelPrintDialog } from '@/components/labels/label-print-dialog';
import { ShareDialog } from '@/components/sharing/share-dialog';
import { usePrintQueueStore } from '@/store/print-queue-store';

export function ContainerDetail() {
  const { containerId } = useParams<{ containerId: string }>();
  const id = Number(containerId);
  const navigate = useNavigate();

  const [createType, setCreateType] = useState<'container' | 'item' | null>(null);
  const [fabOpen, setFabOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  // Select mode: checkboxes over the item/nested-container cards, feeding the
  // print-queue staging area in one batch instead of a dialog per label.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Navigating bin→bin only changes :containerId — the component stays
  // mounted, so without this a selection from the previous bin leaks in.
  useEffect(() => {
    setSelecting(false);
    setSelected(new Set());
  }, [id]);

  const { data: container, isLoading: containerLoading, isError: containerError, refetch: refetchContainer } = useContainer(id);
  const { data: children, isLoading: childrenLoading } = useContainerChildren(id);
  const { data: items, isLoading: itemsLoading } = useItems(id);
  const createContainer = useCreateContainer();
  const createItem = useCreateItem();
  const stageMany = usePrintQueueStore((s) => s.addMany);

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

  function toggleSelected(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
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

  function handleSelectAll() {
    setSelected(
      new Set([
        ...(children ?? []).map((c) => `container:${c.id}`),
        ...(items ?? []).map((i) => `item:${i.id}`),
      ]),
    );
  }

  const selectable = (children?.length ?? 0) + (items?.length ?? 0) > 0;

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
          onClick={() =>
            navigate(`/scan?containerId=${id}&areaId=${container.areaId}&propertyId=${container.breadcrumb?.[0]?.id || ''}`)
          }
        >
          <ScanLine className="w-4 h-4" />
          Scan in
        </Button>
        <Button variant="outline" size="sm" onClick={() => setPrintOpen(true)}>
          <Printer className="w-4 h-4" />
          Label
        </Button>
        <Button variant="outline" size="sm" onClick={() => setShareOpen(true)}>
          <Share2 className="w-4 h-4" />
          Share
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

        {children && children.length === 0 && (
          <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-[var(--color-text-muted)] py-3">
            No nested containers
          </p>
        )}

        {children?.map((child) => (
          <ContainerCard
            key={child.id}
            container={child}
            selectable={selecting}
            selected={selected.has(`container:${child.id}`)}
            onToggle={() => toggleSelected(`container:${child.id}`)}
          />
        ))}
      </section>

      {/* Items */}
      <section className="animate-fade-up flex flex-col" style={{ animationDelay: '200ms' }}>
        <ColHead>Items · {items?.length ?? 0}</ColHead>

        {itemsLoading && <Skeleton className="h-14 w-full mt-2" />}

        {items && items.length === 0 && (
          <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-[var(--color-text-muted)] py-3">
            No items in this container
          </p>
        )}

        {items?.map((item) => (
          <ItemCard
            key={item.id}
            item={item}
            selectable={selecting}
            selected={selected.has(`item:${item.id}`)}
            onToggle={() => toggleSelected(`item:${item.id}`)}
          />
        ))}
      </section>

      {/* Select-mode action bar — replaces the FAB so the two never overlap */}
      {selecting && (
        <div className="fixed bottom-[calc(5.5rem+env(safe-area-inset-bottom))] lg:bottom-8 left-4 right-4 lg:left-auto lg:right-8 lg:w-[26rem] z-30 bg-[var(--color-card)] border-2 border-[var(--color-text)] rounded-[var(--radius-md)] shadow-lg px-3 py-2.5 flex items-center gap-2">
          <p className="font-mono text-xs uppercase tracking-[0.06em] text-[var(--color-text)] flex-1 min-w-0 truncate tabular-nums">
            {selected.size} selected
          </p>
          <Button variant="ghost" size="sm" onClick={handleSelectAll}>
            All
          </Button>
          <Button variant="outline" size="sm" onClick={exitSelectMode}>
            Cancel
          </Button>
          <Button size="sm" disabled={selected.size === 0} onClick={handleAddSelected}>
            Add to queue
          </Button>
        </div>
      )}

      {/* FAB */}
      {!selecting && (
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
      <ShareDialog
        entityType="container"
        entityId={container.id}
        entityName={container.name}
        isOpen={shareOpen}
        onOpenChange={setShareOpen}
      />
    </div>
  );
}

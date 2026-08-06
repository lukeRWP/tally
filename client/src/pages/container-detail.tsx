import type React from 'react';
import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ScanLine, Printer, Share2, Plus, Package, Box, Check, CheckSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
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
import { cn } from '@/lib/utils';

/**
 * Overlay that turns any card into a checkbox while select mode is on.
 * Sits on top of the card and swallows the click, so the card's own
 * navigate-on-click never fires while selecting.
 */
function SelectableCard({
  isSelected,
  onToggle,
  children,
}: {
  isSelected: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="relative">
      {children}
      <button
        type="button"
        role="checkbox"
        aria-checked={isSelected}
        onClick={onToggle}
        className={cn(
          'absolute inset-0 rounded-[var(--radius-lg)] border-2 transition-colors',
          isSelected
            ? 'border-[var(--color-primary)] bg-[var(--color-primary-bg)]/60'
            : 'border-transparent hover:border-[var(--color-border)]',
        )}
      >
        <span
          className={cn(
            'absolute top-2 right-2 w-5 h-5 rounded-full border flex items-center justify-center',
            isSelected
              ? 'bg-[var(--color-primary)] border-[var(--color-primary)] text-white'
              : 'bg-[var(--color-card)] border-[var(--color-border)]',
          )}
        >
          {isSelected && <Check className="w-3.5 h-3.5" />}
        </span>
      </button>
    </div>
  );
}

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

      {/* Header */}
      <div className="animate-fade-up">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-bold text-[var(--color-text)]">{container.name}</h1>
          <Badge variant="warning">{container.type}</Badge>
        </div>
        <p className="text-[11px] font-mono text-[var(--color-text-muted)]">{container.qrCode}</p>
        {container.description && (
          <p className="text-sm text-[var(--color-text-secondary)] mt-1">{container.description}</p>
        )}
      </div>

      {/* Action Bar -- compact circular icon buttons */}
      <div className="flex gap-2 animate-fade-up" style={{ animationDelay: '50ms' }}>
        <button
          type="button"
          onClick={() => {
            if (container) {
              navigate(`/scan?containerId=${id}&areaId=${container.areaId}&propertyId=${container.breadcrumb?.[0]?.id || ''}`);
            }
          }}
          className="w-11 h-11 rounded-full border border-[var(--color-border)] bg-[var(--color-card)] flex items-center justify-center text-[var(--color-text-secondary)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] transition-all duration-200"
          title="Scan Into"
        >
          <ScanLine className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => setPrintOpen(true)}
          className="w-11 h-11 rounded-full border border-[var(--color-border)] bg-[var(--color-card)] flex items-center justify-center text-[var(--color-text-secondary)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] transition-all duration-200"
          title="Print Label"
        >
          <Printer className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => setShareOpen(true)}
          className="w-11 h-11 rounded-full border border-[var(--color-border)] bg-[var(--color-card)] flex items-center justify-center text-[var(--color-text-secondary)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] transition-all duration-200"
          title="Share"
        >
          <Share2 className="w-4 h-4" />
        </button>
        {selectable && (
          <button
            type="button"
            onClick={() => (selecting ? exitSelectMode() : setSelecting(true))}
            className={cn(
              'w-11 h-11 rounded-full border flex items-center justify-center transition-all duration-200',
              selecting
                ? 'border-[var(--color-primary)] bg-[var(--color-primary-bg)] text-[var(--color-primary)]'
                : 'border-[var(--color-border)] bg-[var(--color-card)] text-[var(--color-text-secondary)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]',
            )}
            title="Select labels"
          >
            <CheckSquare className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Tags -- collapsed single line when empty */}
      {hasTags && (
        <div className="animate-fade-up" style={{ animationDelay: '100ms' }}>
          <TagPicker entityType="container" entityId={container.id} propertyId={propertyId} />
        </div>
      )}

      {/* Nested Containers */}
      <section className="animate-fade-up" style={{ animationDelay: '150ms' }}>
        <div className="flex items-center gap-2 mb-2">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Nested Containers</h2>
          {children && children.length > 0 && (
            <span className="bg-[var(--color-primary-bg)] text-[var(--color-primary)] w-6 h-6 rounded-full inline-flex items-center justify-center text-xs font-bold">
              {children.length}
            </span>
          )}
        </div>

        {childrenLoading && (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-20 w-full" />
          </div>
        )}

        {children && children.length === 0 && (
          <p className="text-xs text-[var(--color-text-muted)]">No nested containers.</p>
        )}

        {children && children.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {children.map((child) => {
              const card = (
                <div className="border-l-[3px] border-l-[var(--color-amber)] rounded-l-sm">
                  <ContainerCard container={child} />
                </div>
              );
              return selecting ? (
                <SelectableCard
                  key={child.id}
                  isSelected={selected.has(`container:${child.id}`)}
                  onToggle={() => toggleSelected(`container:${child.id}`)}
                >
                  {card}
                </SelectableCard>
              ) : (
                <div key={child.id}>{card}</div>
              );
            })}
          </div>
        )}
      </section>

      {/* Divider */}
      <div className="border-t border-[var(--color-border)]/50" />

      {/* Items */}
      <section className="animate-fade-up" style={{ animationDelay: '200ms' }}>
        <div className="flex items-center gap-2 mb-2">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Items</h2>
          {items && items.length > 0 && (
            <span className="bg-[var(--color-primary-bg)] text-[var(--color-primary)] w-6 h-6 rounded-full inline-flex items-center justify-center text-xs font-bold">
              {items.length}
            </span>
          )}
        </div>

        {itemsLoading && (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-20 w-full" />
          </div>
        )}

        {items && items.length === 0 && (
          <p className="text-xs text-[var(--color-text-muted)]">No items in this container.</p>
        )}

        {items && items.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {items.map((item) =>
              selecting ? (
                <SelectableCard
                  key={item.id}
                  isSelected={selected.has(`item:${item.id}`)}
                  onToggle={() => toggleSelected(`item:${item.id}`)}
                >
                  <ItemCard item={item} />
                </SelectableCard>
              ) : (
                <ItemCard key={item.id} item={item} />
              ),
            )}
          </div>
        )}
      </section>

      {/* Select-mode action bar — replaces the FAB so the two never overlap */}
      {selecting && (
        <div className="fixed bottom-[calc(5.5rem+env(safe-area-inset-bottom))] lg:bottom-8 left-4 right-4 lg:left-auto lg:right-8 lg:w-[26rem] z-30 bg-[var(--color-card)] border border-[var(--color-border)] rounded-[var(--radius-lg)] shadow-lg px-3 py-2.5 flex items-center gap-2">
          <p className="text-sm text-[var(--color-text)] flex-1 min-w-0 truncate">
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
        <Button
          size="icon"
          onClick={() => setFabOpen(!fabOpen)}
          className="w-12 h-12 rounded-full shadow-lg"
        >
          <Plus className={`w-5 h-5 transition-transform duration-200 ${fabOpen ? 'rotate-45' : ''}`} />
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

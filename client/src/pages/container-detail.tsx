import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { ScanLine, Printer, Share2, Plus, Package, Box } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Breadcrumbs } from '@/components/layout/breadcrumbs';
import { ContainerCard } from '@/components/inventory/container-card';
import { ItemCard } from '@/components/inventory/item-card';
import { EntityForm } from '@/components/inventory/entity-form';
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
import { cn } from '@/lib/utils';

export function ContainerDetail() {
  const { containerId } = useParams<{ containerId: string }>();
  const id = Number(containerId);

  const [createType, setCreateType] = useState<'container' | 'item' | null>(null);
  const [fabOpen, setFabOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  const { data: container, isLoading: containerLoading } = useContainer(id);
  const { data: children, isLoading: childrenLoading } = useContainerChildren(id);
  const { data: items, isLoading: itemsLoading } = useItems(id);
  const createContainer = useCreateContainer();
  const createItem = useCreateItem();

  function handleCreateContainer(data: Record<string, unknown>) {
    if (!container) return;
    createContainer.mutate(
      { ...data, areaId: container.areaId, parentContainerId: id } as {
        name: string;
        type: string;
        description?: string;
        areaId: number;
        parentContainerId: number;
      },
      {
        onSuccess: () => toast('Container created'),
        onError: (err) => toast(err.message),
      },
    );
  }

  function handleCreateItem(data: Record<string, unknown>) {
    createItem.mutate(
      { ...data, containerId: id } as {
        name: string;
        description?: string;
        containerId: number;
        quantity?: number;
        purchasePrice?: number;
        condition?: string;
      },
      {
        onSuccess: () => toast('Item created'),
        onError: (err) => toast(err.message),
      },
    );
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
        <p className="text-[10px] font-mono text-[var(--color-text-muted)]">{container.qrCode}</p>
        {container.description && (
          <p className="text-sm text-[var(--color-text-secondary)] mt-1">{container.description}</p>
        )}
      </div>

      {/* Action Bar -- compact circular icon buttons */}
      <div className="flex gap-2 animate-fade-up" style={{ animationDelay: '50ms' }}>
        <button
          type="button"
          onClick={() => toast('Scanning coming in Phase 2')}
          className="w-9 h-9 rounded-full border border-[var(--color-border)] bg-[var(--color-card)] flex items-center justify-center text-[var(--color-text-secondary)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] transition-all duration-200"
          title="Scan Into"
        >
          <ScanLine className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => setPrintOpen(true)}
          className="w-9 h-9 rounded-full border border-[var(--color-border)] bg-[var(--color-card)] flex items-center justify-center text-[var(--color-text-secondary)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] transition-all duration-200"
          title="Print Label"
        >
          <Printer className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => setShareOpen(true)}
          className="w-9 h-9 rounded-full border border-[var(--color-border)] bg-[var(--color-card)] flex items-center justify-center text-[var(--color-text-secondary)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] transition-all duration-200"
          title="Share"
        >
          <Share2 className="w-4 h-4" />
        </button>
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
            {children.map((child) => (
              <div key={child.id} className="border-l-[3px] border-l-[var(--color-amber)] rounded-l-sm">
                <ContainerCard container={child} />
              </div>
            ))}
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
            {items.map((item) => (
              <ItemCard key={item.id} item={item} />
            ))}
          </div>
        )}
      </section>

      {/* FAB */}
      <div className="fixed bottom-24 lg:bottom-8 right-4 lg:right-8 flex flex-col items-end gap-2 z-30">
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

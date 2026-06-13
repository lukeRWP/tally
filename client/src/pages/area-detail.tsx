import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Plus, Printer, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Breadcrumbs } from '@/components/layout/breadcrumbs';
import { ContainerCard } from '@/components/inventory/container-card';
import { EntityForm } from '@/components/inventory/entity-form';
import { useArea, useContainers, useCreateContainer, useDeleteArea } from '@/hooks/use-inventory';
import { toast } from '@/components/ui/toast';
import { TagPicker } from '@/components/tags/tag-picker';
import { LabelPrintDialog } from '@/components/labels/label-print-dialog';

export function AreaDetail() {
  const { areaId } = useParams<{ areaId: string }>();
  const id = Number(areaId);

  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const { data: area, isLoading: areaLoading } = useArea(id);
  const { data: containers, isLoading: containersLoading } = useContainers(id);
  const createContainer = useCreateContainer();
  const deleteArea = useDeleteArea();

  function handleDeleteArea() {
    const containerCount = area?.containerCount ?? 0;
    const itemCount = area?.itemCount ?? 0;
    const confirmed = window.confirm(
      `This will delete the area and all ${containerCount} ${containerCount === 1 ? 'container' : 'containers'} and ${itemCount} ${itemCount === 1 ? 'item' : 'items'} inside it. This action moves everything to the recycle bin.`
    );
    if (!confirmed) return;
    deleteArea.mutate(id, {
      onSuccess: () => {
        toast('Area deleted');
        navigate(area?.propertyId ? `/property/${area.propertyId}` : '/');
      },
      onError: (err) => toast(err.message),
    });
  }

  function handleCreateContainer(data: Record<string, unknown>) {
    createContainer.mutate(
      { ...data, areaId: id } as { name: string; type: string; description?: string; areaId: number },
      {
        onSuccess: () => toast('Container created'),
        onError: (err) => toast(err.message),
      },
    );
  }

  if (areaLoading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  if (!area) {
    return <p className="text-sm text-[var(--color-text-muted)] text-center py-8">Area not found.</p>;
  }

  const breadcrumbItems = area.propertyId && (area as unknown as { propertyName?: string }).propertyName
    ? [{ id: area.propertyId, name: (area as unknown as { propertyName: string }).propertyName, type: 'property' as const }]
    : [];

  return (
    <div className="flex flex-col gap-4">
      {/* Breadcrumbs */}
      <Breadcrumbs items={breadcrumbItems} />

      {/* Header */}
      <div>
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-lg font-bold text-[var(--color-text)] min-w-0 truncate">{area.name}</h1>
          <div className="flex items-center gap-1.5 shrink-0">
            <Button variant="outline" size="sm" onClick={() => setPrintOpen(true)}>
              <Printer className="w-4 h-4" />
              <span className="hidden sm:inline">Print Label</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleDeleteArea}
              disabled={deleteArea.isPending}
              className="text-[var(--color-red)] border-[var(--color-red)] hover:bg-[var(--color-red-bg)]"
            >
              <Trash2 className="w-4 h-4" />
              <span className="hidden sm:inline">Delete</span>
            </Button>
          </div>
        </div>
        <p className="text-[11px] font-mono text-[var(--color-text-muted)]">{area.qrCode}</p>
        {area.description && (
          <p className="text-sm text-[var(--color-text-secondary)] mt-1">{area.description}</p>
        )}
      </div>

      {/* Tags */}
      {area.propertyId > 0 && (
        <Card>
          <h2 className="text-sm font-semibold text-[var(--color-text)] mb-3">Tags</h2>
          <TagPicker entityType="area" entityId={area.id} propertyId={area.propertyId} />
        </Card>
      )}

      {/* Containers */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--color-text)]">Containers</h2>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="w-4 h-4" />
          Add Container
        </Button>
      </div>

      {containersLoading && (
        <div className="flex flex-col gap-2">
          {[1, 2].map((i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      )}

      {containers && containers.length === 0 && (
        <p className="text-sm text-[var(--color-text-muted)] text-center py-8">
          No containers yet. Add one to start organizing.
        </p>
      )}

      {containers && containers.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {containers.map((container) => (
            <ContainerCard key={container.id} container={container} />
          ))}
        </div>
      )}

      <EntityForm
        open={createOpen}
        onOpenChange={setCreateOpen}
        type="container"
        onSubmit={handleCreateContainer}
        isPending={createContainer.isPending}
      />
      <LabelPrintDialog
        entities={[{
          id: area.id,
          name: area.name,
          qrCode: area.qrCode,
          type: 'area',
          breadcrumb: breadcrumbItems.map((b) => b.name).join(' > '),
        }]}
        entityType="area"
        isOpen={printOpen}
        onOpenChange={setPrintOpen}
      />
    </div>
  );
}

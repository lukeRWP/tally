import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Plus, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Breadcrumbs } from '@/components/layout/breadcrumbs';
import { ContainerCard } from '@/components/inventory/container-card';
import { EntityForm } from '@/components/inventory/entity-form';
import { useArea, useContainers, useCreateContainer } from '@/hooks/use-inventory';
import { toast } from '@/components/ui/toast';
import { TagPicker } from '@/components/tags/tag-picker';
import { LabelPrintDialog } from '@/components/labels/label-print-dialog';

export function AreaDetail() {
  const { areaId } = useParams<{ areaId: string }>();
  const id = Number(areaId);

  const [createOpen, setCreateOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const { data: area, isLoading: areaLoading } = useArea(id);
  const { data: containers, isLoading: containersLoading } = useContainers(id);
  const createContainer = useCreateContainer();

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

  const breadcrumb = 'breadcrumb' in area ? area.breadcrumb : [];

  return (
    <div className="flex flex-col gap-4">
      {/* Breadcrumbs */}
      {breadcrumb.length > 0 && <Breadcrumbs items={breadcrumb} />}

      {/* Header */}
      <div>
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-lg font-bold text-[var(--color-text)]">{area.name}</h1>
          <Button variant="outline" size="sm" onClick={() => setPrintOpen(true)}>
            <Printer className="w-4 h-4" />
            Print Label
          </Button>
        </div>
        <p className="text-[10px] font-mono text-[var(--color-text-muted)]">{area.qrCode}</p>
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
          breadcrumb: (breadcrumb as { name: string }[]).map((b) => b.name).join(' > '),
        }]}
        entityType="area"
        isOpen={printOpen}
        onOpenChange={setPrintOpen}
      />
    </div>
  );
}

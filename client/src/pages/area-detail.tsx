import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Plus, Printer, Tags, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Breadcrumbs } from '@/components/layout/breadcrumbs';
import { ContainerCard } from '@/components/inventory/container-card';
import { EntityForm } from '@/components/inventory/entity-form';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ErrorState } from '@/components/ui/error-state';
import { useArea, useContainers, useCreateContainer, useDeleteArea } from '@/hooks/use-inventory';
import { toast } from '@/components/ui/toast';
import { TagPicker } from '@/components/tags/tag-picker';
import { LabelPrintDialog } from '@/components/labels/label-print-dialog';
import { usePrintQueueStore } from '@/store/print-queue-store';

export function AreaDetail() {
  const { areaId } = useParams<{ areaId: string }>();
  const id = Number(areaId);

  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const { data: area, isLoading: areaLoading, isError: areaError, refetch: refetchArea } = useArea(id);
  const { data: containers, isLoading: containersLoading } = useContainers(id);
  const createContainer = useCreateContainer();
  const deleteArea = useDeleteArea();
  const stageMany = usePrintQueueStore((s) => s.addMany);

  // The 50-bin garage case: one tap stages a 3x3 label for every container in
  // the room, instead of opening fifty dialogs. Dedupe lives in the store, so
  // tapping it twice only tells you everything is already queued.
  function handleLabelAllBins() {
    if (!containers || containers.length === 0 || !area) return;
    const added = stageMany(
      containers.map((c) => ({
        id: c.id,
        entityType: 'container' as const,
        name: c.name,
        qrCode: c.qrCode,
        propertyId: area.propertyId,
      })),
    );
    toast(
      added > 0
        ? `${added} label${added === 1 ? '' : 's'} added to the print queue`
        : 'All of these are already in the print queue',
    );
  }

  function confirmDeleteArea() {
    deleteArea.mutate(id, {
      onSuccess: () => {
        toast('Area deleted');
        navigate(area?.propertyId ? `/property/${area.propertyId}` : '/');
      },
      onError: (err) => toast(err.message),
    });
    setDeleteOpen(false);
  }

  function handleCreateContainer(data: Record<string, unknown>) {
    return createContainer.mutateAsync(
      { ...data, areaId: id } as { name: string; type: string; description?: string; areaId: number },
    )
      .then(() => toast('Container created'))
      .catch((err: Error) => { toast(err.message); throw err; });
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

  if (areaError) {
    return <ErrorState message="Couldn't load this area." onRetry={() => refetchArea()} />;
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
              onClick={() => setDeleteOpen(true)}
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
        <div className="flex items-center gap-1.5">
          {containers && containers.length > 0 && (
            <Button variant="outline" size="sm" onClick={handleLabelAllBins}>
              <Tags className="w-4 h-4" />
              <span className="hidden sm:inline">Label all bins</span>
            </Button>
          )}
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="w-4 h-4" />
            Add Container
          </Button>
        </div>
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
        propertyId={area.propertyId}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete "${area.name}"?`}
        description={`This moves the area and its ${area.containerCount ?? 0} ${(area.containerCount ?? 0) === 1 ? 'container' : 'containers'} and ${area.itemCount ?? 0} items to the recycle bin.`}
        destructive
        confirmLabel="Delete"
        isPending={deleteArea.isPending}
        onConfirm={confirmDeleteArea}
      />
    </div>
  );
}

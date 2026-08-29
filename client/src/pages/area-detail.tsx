import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Plus, Printer, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TitleBar } from '@/components/ui/title-bar';
import { ColHead } from '@/components/ui/col-head';
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
import { cn } from '@/lib/utils';
import { useLayoutMode } from '@/hooks/use-layout-mode';

export function AreaDetail() {
  // Above every early return — hooks must run on each render.
  const wide = useLayoutMode() === 'sidebar';
  const { areaId } = useParams<{ areaId: string }>();
  const id = Number(areaId);

  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const { data: area, isLoading: areaLoading, isError: areaError, refetch: refetchArea } = useArea(id);
  const { data: containers, isLoading: containersLoading, isError: containersError, refetch: refetchContainers } = useContainers(id);
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

      {/* Header — inverted title bar, mono code, thermal actions */}
      <div className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-2">
          <TitleBar className="min-w-0">{area.name}</TitleBar>
          <div className="flex items-center gap-1.5 shrink-0">
            <Button variant="outline" size="sm" onClick={() => setPrintOpen(true)}>
              <Printer className="w-4 h-4" />
              <span className="hidden sm:inline">Label</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDeleteOpen(true)}
              disabled={deleteArea.isPending}
              className="text-[var(--color-red)] border-[var(--color-red)] hover:bg-[var(--color-red)] hover:text-white"
            >
              <Trash2 className="w-4 h-4" />
              <span className="hidden sm:inline">Delete</span>
            </Button>
          </div>
        </div>
        <p className="text-[11px] font-mono text-[var(--color-text-muted)]">{area.qrCode}</p>
        {area.description && (
          <p className="text-sm text-[var(--color-text-secondary)]">{area.description}</p>
        )}
      </div>

      {/* Tags */}
      {area.propertyId > 0 && (
        <div className="flex flex-col gap-2">
          <ColHead>Tags</ColHead>
          <TagPicker entityType="area" entityId={area.id} propertyId={area.propertyId} />
        </div>
      )}

      {/* Containers */}
      <div className="flex flex-col">
        <ColHead
          action={
            <span className="flex items-center gap-2">
              {containers && containers.length > 0 && (
                <button
                  type="button"
                  onClick={handleLabelAllBins}
                  aria-label="Label all bins"
                  title="Stage a label for every top-level bin in this area — nested bins stage from their parent bin's page"
                  className="-my-1 px-1 min-h-[28px] inline-flex items-center text-[var(--color-primary)] hover:opacity-80"
                >
                  Label all ›
                </button>
              )}
              <button
                type="button"
                onClick={() => setCreateOpen(true)}
                className="-my-1 px-1 min-h-[28px] inline-flex items-center text-[var(--color-primary)] hover:opacity-80"
              >
                + Add
              </button>
            </span>
          }
        >
          Containers · {containers?.length ?? 0}
        </ColHead>

        {containersLoading && <Skeleton className="h-14 w-full mt-2" />}

        {containersError && (
          <ErrorState message="Couldn't load containers." onRetry={() => refetchContainers()} />
        )}

        {!containersLoading && !containersError && containers && containers.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-8">
            <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-[var(--color-text-muted)] text-center">
              No containers yet
            </p>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="w-4 h-4" />
              Add Container
            </Button>
          </div>
        )}

        {/* Two columns at a desk: a ruled row stretched to 1400px puts its chevron a screen away from its name, and a short list wastes the height. */}
        <div className={cn(wide && 'grid grid-cols-2 gap-x-6')}>
        {containers?.map((container) => (
          <ContainerCard key={container.id} container={container} />
        ))}
        </div>
      </div>

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

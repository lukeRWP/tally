import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { MapPin, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TitleBar } from '@/components/ui/title-bar';
import { ColHead } from '@/components/ui/col-head';
import { Skeleton } from '@/components/ui/skeleton';
import { Breadcrumbs } from '@/components/layout/breadcrumbs';
import { AreaCard } from '@/components/inventory/area-card';
import { EntityForm } from '@/components/inventory/entity-form';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ErrorState } from '@/components/ui/error-state';
import { useProperty, useAreas, useCreateArea, useDeleteProperty } from '@/hooks/use-inventory';
import { toast } from '@/components/ui/toast';

export function PropertyDetail() {
  const { propertyId } = useParams<{ propertyId: string }>();
  const id = Number(propertyId);

  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const { data: property, isLoading: propertyLoading, isError: propertyError, refetch: refetchProperty } = useProperty(id);
  const { data: areas, isLoading: areasLoading } = useAreas(id);
  const createArea = useCreateArea();
  const deleteProperty = useDeleteProperty();

  function confirmDeleteProperty() {
    deleteProperty.mutate(id, {
      onSuccess: () => {
        toast('Property deleted');
        navigate('/');
      },
      onError: (err) => toast(err.message),
    });
    setDeleteOpen(false);
  }

  function handleCreateArea(data: Record<string, unknown>) {
    return createArea.mutateAsync({ ...data, propertyId: id } as { name: string; description?: string; propertyId: number })
      .then(() => toast('Area created'))
      .catch((err: Error) => { toast(err.message); throw err; });
  }

  if (propertyLoading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  if (propertyError) {
    return <ErrorState message="Couldn't load this property." onRetry={() => refetchProperty()} />;
  }

  if (!property) {
    return <p className="text-sm text-[var(--color-text-muted)] text-center py-8">Property not found.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Breadcrumbs */}
      <Breadcrumbs items={[]} />

      {/* Header — inverted title bar */}
      <div className="flex flex-col gap-2 animate-fade-up">
        <div className="flex items-start justify-between gap-2">
          <TitleBar className="min-w-0">{property.name}</TitleBar>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDeleteOpen(true)}
            disabled={deleteProperty.isPending}
            className="text-[var(--color-red)] border-[var(--color-red)] hover:bg-[var(--color-red)] hover:text-white shrink-0"
          >
            <Trash2 className="w-4 h-4" />
            Delete
          </Button>
        </div>
        <p className="text-[11px] font-mono text-[var(--color-text-muted)]">{property.qrCode}</p>
        {property.address && (
          <div className="flex items-center gap-1">
            <MapPin className="w-3.5 h-3.5 text-[var(--color-primary)]" />
            <span className="text-xs text-[var(--color-text-secondary)]">{property.address}</span>
          </div>
        )}
        {property.description && (
          <p className="text-sm text-[var(--color-text-secondary)]">{property.description}</p>
        )}

        {/* Stats row — mono ledger figures */}
        <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
          <span><b className="text-[var(--color-text)] font-semibold tabular-nums">{property.areaCount}</b> {property.areaCount === 1 ? 'area' : 'areas'}</span>
          <span><b className="text-[var(--color-text)] font-semibold tabular-nums">{property.containerCount}</b> containers</span>
          <span><b className="text-[var(--color-text)] font-semibold tabular-nums">{property.itemCount}</b> items</span>
        </div>
      </div>

      {/* Areas */}
      <div className="flex flex-col">
        <ColHead action="+ Add" onAction={() => setCreateOpen(true)}>
          Areas · {areas?.length ?? 0}
        </ColHead>

        {areasLoading && <Skeleton className="h-14 w-full mt-2" />}

        {areas && areas.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-8">
            <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-[var(--color-text-muted)] text-center">
              No areas yet
            </p>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="w-4 h-4" />
              Add Area
            </Button>
          </div>
        )}

        {areas?.map((area) => (
          <AreaCard key={area.id} area={area} />
        ))}
      </div>

      <EntityForm
        open={createOpen}
        onOpenChange={setCreateOpen}
        type="area"
        onSubmit={handleCreateArea}
        isPending={createArea.isPending}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete "${property.name}"?`}
        description={`This moves the property and its ${property.areaCount ?? 0} ${(property.areaCount ?? 0) === 1 ? 'area' : 'areas'}, ${property.containerCount ?? 0} containers, and ${property.itemCount ?? 0} items to the recycle bin.`}
        destructive
        confirmLabel="Delete"
        isPending={deleteProperty.isPending}
        onConfirm={confirmDeleteProperty}
      />
    </div>
  );
}

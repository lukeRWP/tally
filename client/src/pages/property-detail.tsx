import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { MapPin, Plus, LayoutGrid, Package, Box, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Breadcrumbs } from '@/components/layout/breadcrumbs';
import { AreaCard } from '@/components/inventory/area-card';
import { EntityForm } from '@/components/inventory/entity-form';
import { useProperty, useAreas, useCreateArea, useDeleteProperty } from '@/hooks/use-inventory';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

export function PropertyDetail() {
  const { propertyId } = useParams<{ propertyId: string }>();
  const id = Number(propertyId);

  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const { data: property, isLoading: propertyLoading } = useProperty(id);
  const { data: areas, isLoading: areasLoading } = useAreas(id);
  const createArea = useCreateArea();
  const deleteProperty = useDeleteProperty();

  function handleDeleteProperty() {
    const areaCount = property?.areaCount ?? 0;
    const containerCount = property?.containerCount ?? 0;
    const itemCount = property?.itemCount ?? 0;
    const confirmed = window.confirm(
      `This will delete the property and all ${areaCount} ${areaCount === 1 ? 'area' : 'areas'}, ${containerCount} ${containerCount === 1 ? 'container' : 'containers'}, and ${itemCount} ${itemCount === 1 ? 'item' : 'items'} inside it. This action moves everything to the recycle bin.`
    );
    if (!confirmed) return;
    deleteProperty.mutate(id, {
      onSuccess: () => {
        toast('Property deleted');
        navigate('/');
      },
      onError: (err) => toast(err.message),
    });
  }

  function handleCreateArea(data: Record<string, unknown>) {
    createArea.mutate({ ...data, propertyId: id } as { name: string; description?: string; propertyId: number }, {
      onSuccess: () => toast('Area created'),
      onError: (err) => toast(err.message),
    });
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

  if (!property) {
    return <p className="text-sm text-[var(--color-text-muted)] text-center py-8">Property not found.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Breadcrumbs */}
      <Breadcrumbs items={[]} />

      {/* Hero Header Band */}
      <div className="bg-[var(--color-primary-bg)] -mx-4 -mt-4 px-4 pt-5 pb-4 rounded-b-2xl animate-fade-up">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-2xl font-extrabold text-[var(--color-text)] tracking-tight">{property.name}</h1>
          <Button
            variant="outline"
            size="sm"
            onClick={handleDeleteProperty}
            disabled={deleteProperty.isPending}
            className="text-[var(--color-red)] border-[var(--color-red)] hover:bg-[var(--color-red-bg)] shrink-0"
          >
            <Trash2 className="w-4 h-4" />
            Delete
          </Button>
        </div>
        <p className="text-[10px] font-mono text-[var(--color-text-muted)] mt-0.5">{property.qrCode}</p>
        {property.address && (
          <div className="flex items-center gap-1 mt-1.5">
            <MapPin className="w-3.5 h-3.5 text-[var(--color-primary)]" />
            <span className="text-xs text-[var(--color-text-secondary)]">{property.address}</span>
          </div>
        )}
        {property.description && (
          <p className="text-sm text-[var(--color-text-secondary)] mt-2">{property.description}</p>
        )}

        {/* Stats row */}
        <div className="flex gap-2 mt-3">
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[var(--color-card)] text-xs font-semibold text-[var(--color-text-secondary)]">
            <LayoutGrid className="w-3 h-3 text-[var(--color-primary)]" />
            {property.areaCount} {property.areaCount === 1 ? 'area' : 'areas'}
          </div>
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[var(--color-card)] text-xs font-semibold text-[var(--color-text-secondary)]">
            <Package className="w-3 h-3 text-[var(--color-amber)]" />
            {property.containerCount} containers
          </div>
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[var(--color-card)] text-xs font-semibold text-[var(--color-text-secondary)]">
            <Box className="w-3 h-3 text-[var(--color-purple)]" />
            {property.itemCount} items
          </div>
        </div>
      </div>

      {/* Areas */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--color-text)]">Areas</h2>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="w-4 h-4" />
          Add Area
        </Button>
      </div>

      {areasLoading && (
        <div className="flex flex-col gap-2">
          {[1, 2].map((i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      )}

      {areas && areas.length === 0 && (
        <p className="text-sm text-[var(--color-text-muted)] text-center py-8">
          No areas yet. Add one to organize this property.
        </p>
      )}

      {areas && areas.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {areas.map((area, idx) => (
            <div
              key={area.id}
              className={cn(
                'border-l-[3px] rounded-l-sm',
                idx % 2 === 0
                  ? 'border-l-[var(--color-primary)]'
                  : 'border-l-[var(--color-amber)]',
              )}
            >
              <AreaCard area={area} />
            </div>
          ))}
        </div>
      )}

      <EntityForm
        open={createOpen}
        onOpenChange={setCreateOpen}
        type="area"
        onSubmit={handleCreateArea}
        isPending={createArea.isPending}
      />
    </div>
  );
}

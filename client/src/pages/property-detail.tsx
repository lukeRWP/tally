import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { MapPin, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { AreaCard } from '@/components/inventory/area-card';
import { EntityForm } from '@/components/inventory/entity-form';
import { useProperty, useAreas, useCreateArea } from '@/hooks/use-inventory';
import { toast } from '@/components/ui/toast';

export function PropertyDetail() {
  const { propertyId } = useParams<{ propertyId: string }>();
  const id = Number(propertyId);

  const [createOpen, setCreateOpen] = useState(false);
  const { data: property, isLoading: propertyLoading } = useProperty(id);
  const { data: areas, isLoading: areasLoading } = useAreas(id);
  const createArea = useCreateArea();

  function handleCreateArea(data: Record<string, unknown>) {
    createArea.mutate({ ...data, propertyId: id } as { name: string; description?: string; propertyId: number }, {
      onSuccess: () => toast('Area created'),
      onError: (err) => toast(err.message),
    });
  }

  if (propertyLoading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-48" />
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
      {/* Header */}
      <div>
        <h1 className="text-lg font-bold text-[var(--color-text)]">{property.name}</h1>
        <p className="text-[10px] font-mono text-[var(--color-text-muted)]">{property.qrCode}</p>
        {property.address && (
          <div className="flex items-center gap-1 mt-1">
            <MapPin className="w-3 h-3 text-[var(--color-text-muted)]" />
            <span className="text-xs text-[var(--color-text-muted)]">{property.address}</span>
          </div>
        )}
        {property.description && (
          <p className="text-sm text-[var(--color-text-secondary)] mt-1">{property.description}</p>
        )}
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
          {areas.map((area) => (
            <AreaCard key={area.id} area={area} />
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

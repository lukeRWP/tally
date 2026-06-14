import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { PropertyCard } from '@/components/inventory/property-card';
import { EntityForm } from '@/components/inventory/entity-form';
import { ErrorState } from '@/components/ui/error-state';
import { useProperties, useCreateProperty } from '@/hooks/use-inventory';
import { toast } from '@/components/ui/toast';

export function Inventory() {
  const [createOpen, setCreateOpen] = useState(false);
  const { data: properties, isLoading, isError, refetch } = useProperties();
  const createProperty = useCreateProperty();

  function handleCreate(data: Record<string, unknown>) {
    createProperty.mutate(data as { name: string; address?: string; description?: string }, {
      onSuccess: () => toast('Property created'),
      onError: (err) => toast(err.message),
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-[var(--color-text)]">All Properties</h1>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="w-4 h-4" />
          Create
        </Button>
      </div>

      {isLoading && (
        <div className="flex flex-col gap-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      )}

      {isError && (
        <ErrorState message="Couldn't load your properties." onRetry={() => refetch()} />
      )}

      {!isError && properties && properties.length === 0 && (
        <p className="text-sm text-[var(--color-text-muted)] text-center py-8">
          No properties yet. Create one to get started.
        </p>
      )}

      {!isError && properties && properties.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {properties.map((property) => (
            <PropertyCard key={property.id} property={property} />
          ))}
        </div>
      )}

      <EntityForm
        open={createOpen}
        onOpenChange={setCreateOpen}
        type="property"
        onSubmit={handleCreate}
        isPending={createProperty.isPending}
      />
    </div>
  );
}

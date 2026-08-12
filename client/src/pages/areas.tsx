import * as React from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ColHead } from '@/components/ui/col-head';
import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { TitleBar } from '@/components/ui/title-bar';
import { toast } from '@/components/ui/toast';
import { PropertyCard } from '@/components/inventory/property-card';
import { EntityForm } from '@/components/inventory/entity-form';
import { useProperties, useAreas, usePropertyTree, useCreateProperty, useCreateArea } from '@/hooks/use-inventory';
import { StructureTree } from '@/components/inventory/structure-tree';

/**
 * The top of the place hierarchy, and the screen you build the house on.
 * Property → area → container is a chain where each rung can only be hung off
 * the one above it, so every level offers the next: this page makes properties,
 * a property page makes its areas, an area page makes its bins. Start here and
 * you can walk the whole structure into existence without ever hunting for the
 * button that creates the next thing down.
 */
export function AreasPage() {
  const [createPropertyOpen, setCreatePropertyOpen] = React.useState(false);
  const [createAreaOpen, setCreateAreaOpen] = React.useState(false);

  const { data: properties, isLoading, isError, refetch } = useProperties();
  const createProperty = useCreateProperty();
  const createArea = useCreateArea();

  // A one-property household is the ordinary household, and a list of exactly
  // one row that must be tapped through conveys nothing — so its areas open
  // inline, one rung further down the chain. The property's own row stays above
  // them because its page is the only route to the address, the description and
  // the delete action. `useAreas` is disabled on a falsy id, so the
  // multi-property path costs nothing.
  const only = properties && properties.length === 1 ? properties[0] : null;
  const { data: areas, isLoading: areasLoading } = useAreas(only?.id ?? 0);
  // The whole property's containers, every depth, in one request — expanding a
  // node is then pure state rather than a fetch per level.
  const { data: treeContainers, isLoading: treeLoading } = usePropertyTree(only?.id ?? 0);

  const totalAreas = properties?.reduce((sum, p) => sum + p.areaCount, 0) ?? 0;
  const totalContainers = properties?.reduce((sum, p) => sum + p.containerCount, 0) ?? 0;
  const totalItems = properties?.reduce((sum, p) => sum + p.itemCount, 0) ?? 0;

  function handleCreateProperty(data: Record<string, unknown>) {
    return createProperty.mutateAsync(data as { name: string; address?: string; description?: string })
      .then(() => toast('Property created'))
      .catch((err: Error) => { toast(err.message); throw err; });
  }

  function handleCreateArea(data: Record<string, unknown>) {
    if (!only) return;
    return createArea.mutateAsync({ ...data, propertyId: only.id } as { name: string; description?: string; propertyId: number })
      .then(() => toast('Area created'))
      .catch((err: Error) => { toast(err.message); throw err; });
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-28" />
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  }

  if (isError) {
    return <ErrorState message="Couldn't load your properties." onRetry={() => refetch()} />;
  }

  const hasProperties = (properties?.length ?? 0) > 0;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2 animate-fade-up">
        <h1><TitleBar>Areas</TitleBar></h1>

        {/* The only house-wide count in the app — mono ledger figures, same as
            the per-property line on the property page. */}
        {hasProperties && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
            <span><b className="text-[var(--color-text)] font-semibold tabular-nums">{totalAreas}</b> {totalAreas === 1 ? 'area' : 'areas'}</span>
            <span><b className="text-[var(--color-text)] font-semibold tabular-nums">{totalContainers}</b> containers</span>
            <span><b className="text-[var(--color-text)] font-semibold tabular-nums">{totalItems}</b> items</span>
          </div>
        )}
      </div>

      <section className="flex flex-col">
        <ColHead action="+ Add" onAction={() => setCreatePropertyOpen(true)}>
          Properties · {properties?.length ?? 0}
        </ColHead>

        {!hasProperties && (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <p className="font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
              No properties yet
            </p>
            <p className="max-w-xs text-sm text-[var(--color-text-secondary)]">
              A property is the building everything else sits inside — a house, a flat, a lock-up.
              Add one, then areas inside it, then bins inside those.
            </p>
            <Button size="sm" onClick={() => setCreatePropertyOpen(true)}>
              <Plus className="w-4 h-4" />
              Add Property
            </Button>
          </div>
        )}

        {properties?.map((property, idx) => (
          <PropertyCard key={property.id} property={property} index={idx} />
        ))}
      </section>

      {only && (
        <section className="flex flex-col">
          <ColHead action="+ Add" onAction={() => setCreateAreaOpen(true)}>
            Areas · {areas?.length ?? 0}
          </ColHead>

          {areasLoading && <Skeleton className="h-14 w-full mt-2" />}

          {areas && areas.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
                No areas yet
              </p>
              <p className="max-w-xs text-sm text-[var(--color-text-secondary)]">
                An area is a room or zone — the kitchen, the loft, bay 3. Bins live inside one.
              </p>
              <Button size="sm" onClick={() => setCreateAreaOpen(true)}>
                <Plus className="w-4 h-4" />
                Add Area
              </Button>
            </div>
          )}

          {/* The nested view replaces the flat area list: the point of this tab
              is the shape of the place, and a list of area names never showed
              it. AreaCard is still used on the property detail page. */}
          {areas && areas.length > 0 && (
            treeLoading
              ? <Skeleton className="h-24 w-full mt-2" />
              : <StructureTree areas={areas} containers={treeContainers ?? []} />
          )}
        </section>
      )}

      <EntityForm
        open={createPropertyOpen}
        onOpenChange={setCreatePropertyOpen}
        type="property"
        onSubmit={handleCreateProperty}
        isPending={createProperty.isPending}
      />
      <EntityForm
        open={createAreaOpen}
        onOpenChange={setCreateAreaOpen}
        type="area"
        onSubmit={handleCreateArea}
        isPending={createArea.isPending}
      />
    </div>
  );
}

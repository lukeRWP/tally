import * as React from 'react';
import { useNavigate, useSearchParams } from 'react-router';
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
import { PropertyChips } from '@/components/inventory/property-chips';
import { ContainerPreview } from '@/components/inventory/container-preview';
import { useLayoutMode } from '@/hooks/use-layout-mode';
import { useKeyboardNav, useNavScrollIntoView } from '@/hooks/use-keyboard-nav';

/**
 * The top of the place hierarchy, and the screen you build the house on.
 * Property → area → container is a chain where each rung can only be hung off
 * the one above it, so every level offers the next: this page makes properties,
 * a property page makes its areas, an area page makes its bins. Start here and
 * you can walk the whole structure into existence without ever hunting for the
 * button that creates the next thing down.
 */
export function AreasPage() {
  // Master-detail only where there is room for it. In touch chrome a bin still
  // opens its own page, because there is no second column to put it in.
  const split = useLayoutMode() === 'sidebar';
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const selectedBin = params.get('bin') ? Number(params.get('bin')) : null;

  /**
   * Selection lives in the URL, not in state.
   *
   * It makes a chosen bin linkable, survives a reload, and — the part that
   * actually matters day to day — lets Back step out of a bin instead of
   * leaving the page entirely. `replace` is deliberate: clicking through six
   * bins should not bury the page you arrived from under six history entries.
   */
  const selectBin = React.useCallback((id: number) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (next.get('bin') === String(id)) next.delete('bin'); else next.set('bin', String(id));
      return next;
    }, { replace: true });
  }, [setParams]);

  const [createPropertyOpen, setCreatePropertyOpen] = React.useState(false);
  const [createAreaOpen, setCreateAreaOpen] = React.useState(false);
  /**
   * The bins j/k walks, in the order they appear on screen.
   *
   * Registered by the tree rather than recomputed here, because "visible"
   * depends on which rows are expanded — deriving it a second time would drift
   * from what is actually rendered and the selection would jump.
   */
  const [visibleBins, setVisibleBins] = React.useState<number[]>([]);

  // j/k walks the bins as drawn. Nothing selected yet starts at the top going
  // down and the bottom going up, so the first keypress always lands somewhere
  // rather than doing nothing.
  const moveSelection = React.useCallback((delta: 1 | -1) => {
    if (visibleBins.length === 0) return;
    const at = selectedBin == null ? -1 : visibleBins.indexOf(selectedBin);
    const next = at === -1
      ? (delta === 1 ? 0 : visibleBins.length - 1)
      : Math.min(visibleBins.length - 1, Math.max(0, at + delta));
    setParams((prev) => {
      const p2 = new URLSearchParams(prev);
      p2.set('bin', String(visibleBins[next]));
      return p2;
    }, { replace: true });
  }, [visibleBins, selectedBin, setParams]);

  const clearSelection = React.useCallback(() => {
    setParams((prev) => {
      const p2 = new URLSearchParams(prev);
      p2.delete('bin');
      return p2;
    }, { replace: true });
  }, [setParams]);

  useKeyboardNav({
    // Only where there is a keyboard to serve and a selection to move.
    enabled: split,
    onMove: moveSelection,
    onEscape: clearSelection,
    onSearch: () => navigate('/search'),
    onOpen: () => {
      if (selectedBin == null) return false;
      navigate(`/container/${selectedBin}`);
      return true;
    },
  });
  // Keeps the cursor on screen in a tree taller than the viewport (#235) —
  // StructureTree's bin rows carry the matching data-nav-id.
  useNavScrollIntoView(selectedBin);

  const { data: properties, isLoading, isError, refetch } = useProperties();
  const createProperty = useCreateProperty();
  const createArea = useCreateArea();

  // A one-property household is the ordinary household, and a list of exactly
  // one row that must be tapped through conveys nothing — so its areas open
  // inline, one rung further down the chain. The property's own row stays above
  // them because its page is the only route to the address, the description and
  // the delete action. `useAreas` is disabled on a falsy id, so the
  // multi-property path costs nothing.
  /**
   * Which property's structure is on screen.
   *
   * This used to be `properties.length === 1 ? properties[0] : null` — so with
   * two properties the areas section, and now the whole nested view, simply did
   * not render. The structure was reachable only by drilling into a property,
   * which is the thing this tab exists to save you.
   *
   * PropertyChips renders nothing below two properties, so the single-property
   * case looks exactly as it did.
   */
  const [selectedPropertyId, setSelectedPropertyId] = React.useState<number>(0);
  React.useEffect(() => {
    if (!selectedPropertyId && properties && properties.length > 0) {
      setSelectedPropertyId(properties[0].id);
    }
  }, [properties, selectedPropertyId]);
  const only = properties?.find((p) => p.id === selectedPropertyId) ?? null;
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
        <section className="flex flex-col gap-2">
          {properties && properties.length > 1 && (
            <PropertyChips
              properties={properties}
              value={selectedPropertyId}
              onChange={setSelectedPropertyId}
            />
          )}

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
              : split ? (
                // The tree keeps a readable measure and the contents take the
                // rest, so a wide screen shows more inventory rather than more
                // whitespace. items-start stops the short column stretching.
                <div className="grid grid-cols-[minmax(320px,380px)_1fr] items-start gap-6">
                  <StructureTree
                    areas={areas}
                    containers={treeContainers ?? []}
                    onSelect={selectBin}
                    selectedId={selectedBin}
                    onVisibleOrder={setVisibleBins}
                  />
                  {/* Sticky so the contents stay in view while the tree
                      scrolls past them — the whole point of not navigating. */}
                  <div className="sticky top-4 max-h-[calc(100dvh-7rem)] overflow-y-auto">
                    <ContainerPreview containerId={selectedBin} />
                  </div>
                </div>
              ) : (
                <StructureTree areas={areas} containers={treeContainers ?? []} />
              )
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

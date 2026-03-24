import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, ScanLine, Plus } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { PropertyCard } from '@/components/inventory/property-card';
import { ItemCard } from '@/components/inventory/item-card';
import { EntityForm } from '@/components/inventory/entity-form';
import { useProperties, useCreateProperty, useSearchItems } from '@/hooks/use-inventory';
import { toast } from '@/components/ui/toast';

export function Home() {
  const navigate = useNavigate();
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

  const { data: properties, isLoading: propertiesLoading } = useProperties();
  const { data: searchResults } = useSearchItems(searchQuery);
  const createProperty = useCreateProperty();

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => setSearchQuery(searchInput), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  function handleCreateProperty(data: Record<string, unknown>) {
    createProperty.mutate(data as { name: string; address?: string; description?: string }, {
      onSuccess: () => toast('Property created'),
      onError: (err) => toast(err.message),
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
        <Input
          placeholder="Search items..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Search Results */}
      {searchQuery.length >= 1 && searchResults && searchResults.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-[var(--color-text)] mb-2">
            Search Results ({searchResults.length})
          </h2>
          <div className="flex flex-col gap-2">
            {searchResults.map((item) => (
              <ItemCard key={item.id} item={item} />
            ))}
          </div>
        </section>
      )}

      {searchQuery.length >= 1 && searchResults && searchResults.length === 0 && (
        <p className="text-sm text-[var(--color-text-muted)] text-center py-4">
          No items found for &ldquo;{searchQuery}&rdquo;
        </p>
      )}

      {/* Quick Actions */}
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => navigate('/scan')} className="flex-1">
          <ScanLine className="w-4 h-4" />
          Scan
        </Button>
        <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)} className="flex-1">
          <Plus className="w-4 h-4" />
          Add Property
        </Button>
      </div>

      {/* Properties */}
      <section>
        <h2 className="text-sm font-semibold text-[var(--color-text)] mb-2">Your Properties</h2>

        {propertiesLoading && (
          <div className="flex flex-col gap-2">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        )}

        {properties && properties.length === 0 && (
          <p className="text-sm text-[var(--color-text-muted)] text-center py-8">
            No properties yet. Create one to get started.
          </p>
        )}

        {properties && properties.length > 0 && (
          <div className="flex flex-col gap-2">
            {properties.map((property) => (
              <PropertyCard key={property.id} property={property} />
            ))}
          </div>
        )}
      </section>

      <EntityForm
        open={createOpen}
        onOpenChange={setCreateOpen}
        type="property"
        onSubmit={handleCreateProperty}
        isPending={createProperty.isPending}
      />
    </div>
  );
}

import { useState, useEffect, useRef } from 'react';
import { Search, Plus, Package, X, Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';

interface ProductSearchProps {
  onProductSelected: (product: Record<string, unknown>) => void;
  onCreateManually: () => void;
  onClose: () => void;
}

interface SearchProduct {
  id: number;
  name: string;
  brand: string;
  category: string;
  barcode: string;
  imageUrl: string | null;
  retailPrice: number | null;
}

export function ProductSearch({
  onProductSelected,
  onCreateManually,
  onClose,
}: ProductSearchProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchProduct[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    if (query.length < 2) {
      setResults([]);
      setHasSearched(false);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      setIsLoading(true);
      try {
        const data = await api.get<{ products: SearchProduct[] }>(
          `/api/products/_x_/search?q=${encodeURIComponent(query)}`
        );
        setResults(data.products || []);
      } catch {
        setResults([]);
      } finally {
        setIsLoading(false);
        setHasSearched(true);
      }
    }, 300);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [query]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-[var(--color-text)]">
          Search Products
        </h2>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="w-4 h-4" />
        </Button>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or brand..."
          className="pl-9"
        />
      </div>

      <div className="flex flex-col gap-2 max-h-[50vh] overflow-y-auto">
        {isLoading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 text-[var(--color-primary)] animate-spin" />
          </div>
        )}

        {!isLoading && results.map((product) => (
          <Card
            key={product.id}
            className="flex items-center gap-3 cursor-pointer active:opacity-80 transition-opacity"
            onClick={() => onProductSelected(product as unknown as Record<string, unknown>)}
          >
            <div className="flex items-center justify-center w-10 h-10 rounded-[var(--radius-md)] bg-[var(--color-elevated)] shrink-0 overflow-hidden">
              {product.imageUrl ? (
                <img
                  src={product.imageUrl}
                  alt={product.name}
                  className="w-10 h-10 object-cover rounded-[var(--radius-md)]"
                />
              ) : (
                <Package className="w-5 h-5 text-[var(--color-text-muted)]" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-[var(--color-text)] truncate">
                {product.name}
              </p>
              <div className="flex items-center gap-2 mt-0.5">
                {product.brand && (
                  <span className="text-xs text-[var(--color-text-secondary)]">
                    {product.brand}
                  </span>
                )}
                {product.category && (
                  <Badge variant="default">{product.category}</Badge>
                )}
              </div>
            </div>
          </Card>
        ))}

        {!isLoading && hasSearched && results.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-6">
            <p className="text-sm text-[var(--color-text-muted)]">
              No products found
            </p>
          </div>
        )}
      </div>

      <button
        type="button"
        className="flex items-center justify-center gap-2 w-full py-3 border border-dashed border-[var(--color-border)] rounded-[var(--radius-md)] text-sm text-[var(--color-primary)] hover:bg-[var(--color-primary-bg)] transition-colors cursor-pointer"
        onClick={onCreateManually}
      >
        <Plus className="w-4 h-4" />
        Create item manually
      </button>
    </div>
  );
}

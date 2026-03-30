import { useState, useEffect, useRef } from 'react';
import { Search, Plus, Package, X, Loader2, Globe } from 'lucide-react';
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
  id?: number;
  name: string;
  brand: string;
  category: string;
  barcode: string;
  imageUrl: string | null;
  retailPrice: number | null;
  dataSource?: string;
}

interface SearchResponse {
  products: SearchProduct[];
  onlineProducts?: SearchProduct[];
}

export function ProductSearch({
  onProductSelected,
  onCreateManually,
  onClose,
}: ProductSearchProps) {
  const [query, setQuery] = useState('');
  const [localResults, setLocalResults] = useState<SearchProduct[]>([]);
  const [onlineResults, setOnlineResults] = useState<SearchProduct[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSearchingOnline, setIsSearchingOnline] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Local search with debounce
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (query.length < 2) {
      setLocalResults([]);
      setOnlineResults([]);
      setHasSearched(false);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      setIsLoading(true);
      try {
        const data = await api.get<SearchResponse>(
          `/api/products/_x_/search?q=${encodeURIComponent(query)}&online=true`
        );
        setLocalResults(data.products || []);
        setOnlineResults(data.onlineProducts || []);
      } catch {
        setLocalResults([]);
        setOnlineResults([]);
      } finally {
        setIsLoading(false);
        setHasSearched(true);
      }
    }, 500);

    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query]);

  const hasResults = localResults.length > 0 || onlineResults.length > 0;

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
          placeholder="Search by name, brand, or barcode..."
          className="pl-9"
        />
      </div>

      <div className="flex flex-col gap-2 max-h-[50vh] overflow-y-auto">
        {isLoading && (
          <div className="flex items-center justify-center py-8 gap-2">
            <Loader2 className="w-5 h-5 text-[var(--color-primary)] animate-spin" />
            <span className="text-xs text-[var(--color-text-muted)]">Searching local & online...</span>
          </div>
        )}

        {/* Local results */}
        {!isLoading && localResults.length > 0 && (
          <>
            <p className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)] font-medium">
              Your catalog
            </p>
            {localResults.map((product) => (
              <ProductCard key={`local-${product.id || product.barcode}`} product={product} onSelect={onProductSelected} />
            ))}
          </>
        )}

        {/* Online results */}
        {!isLoading && onlineResults.length > 0 && (
          <>
            <div className="flex items-center gap-1.5 mt-2">
              <Globe className="w-3 h-3 text-[var(--color-primary)]" />
              <p className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)] font-medium">
                Found online
              </p>
            </div>
            {onlineResults.map((product, i) => (
              <ProductCard key={`online-${product.barcode || i}`} product={product} onSelect={onProductSelected} online />
            ))}
          </>
        )}

        {isSearchingOnline && (
          <div className="flex items-center justify-center py-4 gap-2">
            <Loader2 className="w-4 h-4 text-[var(--color-primary)] animate-spin" />
            <span className="text-xs text-[var(--color-text-muted)]">Searching online databases...</span>
          </div>
        )}

        {!isLoading && !isSearchingOnline && hasSearched && !hasResults && (
          <div className="flex flex-col items-center gap-2 py-6">
            <p className="text-sm text-[var(--color-text-muted)]">
              No products found locally or online
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

function ProductCard({ product, onSelect, online }: {
  product: SearchProduct;
  onSelect: (p: Record<string, unknown>) => void;
  online?: boolean;
}) {
  return (
    <Card
      className="flex items-center gap-3 cursor-pointer active:opacity-80 transition-opacity"
      onClick={() => onSelect(product as unknown as Record<string, unknown>)}
    >
      <div className="flex items-center justify-center w-10 h-10 rounded-[var(--radius-md)] bg-[var(--color-elevated)] shrink-0 overflow-hidden">
        {product.imageUrl ? (
          <img src={product.imageUrl} alt={product.name} className="w-10 h-10 object-cover rounded-[var(--radius-md)]" />
        ) : (
          <Package className="w-5 h-5 text-[var(--color-text-muted)]" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-[var(--color-text)] truncate">{product.name}</p>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          {product.brand && (
            <span className="text-xs text-[var(--color-text-secondary)]">{product.brand}</span>
          )}
          {product.category && <Badge variant="default">{product.category}</Badge>}
          {online && product.dataSource && (
            <Badge variant="info">{product.dataSource.replace(/_/g, ' ')}</Badge>
          )}
        </div>
      </div>
    </Card>
  );
}

import { Package, Search, Plus, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface ScanResultProps {
  product: Record<string, unknown>;
  source: string;
  onAddToInventory: (product: Record<string, unknown>) => void;
  onSearchManually: () => void;
  onDismiss: () => void;
}

export function ScanResult({
  product,
  source,
  onAddToInventory,
  onSearchManually,
  onDismiss,
}: ScanResultProps) {
  if (source === 'not_found') {
    const barcode = (product.barcode as string) || 'unknown';
    return (
      <Card className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-10 h-10 rounded-[var(--radius-md)] bg-[var(--color-amber-bg)]">
            <XCircle className="w-5 h-5 text-[var(--color-amber)]" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-[var(--color-text)]">
              No product found
            </p>
            <p className="text-xs text-[var(--color-text-muted)] font-mono">
              Barcode: {barcode}
            </p>
          </div>
        </div>

        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="flex-1" onClick={onSearchManually}>
            <Search className="w-4 h-4" />
            Search manually
          </Button>
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      </Card>
    );
  }

  const name = product.name as string;
  const brand = product.brand as string | undefined;
  const category = product.category as string | undefined;
  const imageUrl = product.imageUrl as string | undefined;
  const retailPrice = product.retailPrice as number | undefined;

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <div className="flex items-center justify-center w-14 h-14 rounded-[var(--radius-md)] bg-[var(--color-elevated)] shrink-0 overflow-hidden">
          {imageUrl ? (
            <img
              src={imageUrl}
              alt={name}
              className="w-14 h-14 object-cover rounded-[var(--radius-md)]"
            />
          ) : (
            <Package className="w-6 h-6 text-[var(--color-text-muted)]" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-[var(--color-text)] leading-snug">
            {name}
          </p>
          {brand && (
            <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
              {brand}
            </p>
          )}
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            {category && (
              <Badge variant="default">{category}</Badge>
            )}
            <Badge variant="info">{source}</Badge>
          </div>
          {retailPrice != null && (
            <p className="text-xs text-[var(--color-text-muted)] mt-1">
              ${retailPrice.toFixed(2)}
            </p>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Button size="sm" onClick={() => onAddToInventory(product)}>
          <Plus className="w-4 h-4" />
          Add to Inventory
        </Button>
        <button
          type="button"
          className="text-xs text-[var(--color-primary)] hover:opacity-80 transition-opacity text-center cursor-pointer"
          onClick={onSearchManually}
        >
          Not right? Search manually
        </button>
      </div>
    </Card>
  );
}

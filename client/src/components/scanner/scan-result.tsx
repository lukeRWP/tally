import { Package, Search, Plus, XCircle, ExternalLink, ShoppingCart } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { safeExternalUrl } from '@/lib/utils';

interface RetailLink {
  retailer: string;
  url: string;
  price?: number;
}

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
            <p className="text-sm font-semibold text-[var(--color-text)]">No product found</p>
            <p className="text-xs text-[var(--color-text-muted)] font-mono">Barcode: {barcode}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="flex-1" onClick={onSearchManually}>
            <Search className="w-4 h-4" /> Search manually
          </Button>
          <Button variant="ghost" size="sm" onClick={onDismiss}>Dismiss</Button>
        </div>
      </Card>
    );
  }

  const name = product.name as string;
  const brand = product.brand as string | undefined;
  const category = product.category as string | undefined;
  const rawImageUrl = product.imageUrl as string | undefined;
  // Upgrade HTTP image URLs to HTTPS to avoid mixed content blocking
  const imageUrl = rawImageUrl?.replace(/^http:\/\//, 'https://');
  const retailPrice = product.retailPrice as number | undefined;
  const retailLinks = (product.retailLinks as RetailLink[] | undefined) || [];
  const description = product.description as string | undefined;

  return (
    <Card className="flex flex-col gap-3">
      {/* Product image — larger on mobile */}
      {imageUrl && (
        <div className="w-full h-40 rounded-[var(--radius-md)] bg-[var(--color-elevated)] overflow-hidden flex items-center justify-center">
          <img
            src={imageUrl}
            alt={name}
            className="w-full h-full object-contain"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
        </div>
      )}

      {/* Product info */}
      <div className="flex items-start gap-3">
        {!imageUrl && (
          <div className="flex items-center justify-center w-12 h-12 rounded-[var(--radius-md)] bg-[var(--color-elevated)] shrink-0">
            <Package className="w-5 h-5 text-[var(--color-text-muted)]" />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-[var(--color-text)] leading-snug">{name}</p>
          {brand && <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">{brand}</p>}
          {description && description !== name && (
            <p className="text-xs text-[var(--color-text-muted)] mt-1 line-clamp-2">{description}</p>
          )}
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            {category && <Badge variant="default">{category}</Badge>}
          </div>
          {retailPrice != null && (
            <p className="text-sm font-semibold text-[var(--color-green)] mt-1.5">${retailPrice.toFixed(2)}</p>
          )}
        </div>
      </div>

      {/* Retail links */}
      {retailLinks.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-[10px] font-medium text-[var(--color-text-muted)] uppercase">Where to buy</p>
          <div className="flex flex-wrap gap-1.5">
            {retailLinks.slice(0, 4).map((link, i) => (
              <a
                key={i}
                href={safeExternalUrl(link.url)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 px-2 py-1 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-elevated)] text-[10px] text-[var(--color-text-secondary)] hover:text-[var(--color-primary)] hover:border-[var(--color-primary)] transition-colors"
              >
                <ShoppingCart className="w-3 h-3" />
                <span className="truncate max-w-[80px]">{link.retailer}</span>
                {link.price != null && <span className="text-[var(--color-green)]">${link.price.toFixed(2)}</span>}
                <ExternalLink className="w-2.5 h-2.5 shrink-0" />
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-col gap-2 pt-1">
        <Button size="sm" onClick={() => onAddToInventory(product)}>
          <Plus className="w-4 h-4" /> Add to Inventory
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

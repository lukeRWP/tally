import { useNavigate } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { getItemIcon } from '@/lib/item-icons';
import type { Item } from '@/types/inventory';

interface ItemCardProps {
  item: Item;
}

const conditionVariant = {
  new: 'success',
  good: 'default',
  fair: 'warning',
  poor: 'danger',
} as const;

const statusVariant = {
  active: 'success',
  removed: 'danger',
  lent: 'info',
} as const;

export function ItemCard({ item }: ItemCardProps) {
  const navigate = useNavigate();
  const FallbackIcon = getItemIcon(item.name);

  return (
    <Card
      className="flex items-center gap-3 cursor-pointer active:opacity-80 transition-opacity"
      onClick={() => navigate(`/item/${item.id}`)}
    >
      <div className="flex items-center justify-center w-10 h-10 rounded-[var(--radius-md)] shrink-0 bg-[var(--color-elevated)] text-[var(--color-text-muted)]">
        {item.productImageUrl ? (
          <img
            src={item.productImageUrl}
            alt={item.name}
            className="w-10 h-10 rounded-[var(--radius-md)] object-cover"
            loading="lazy"
          />
        ) : (
          <FallbackIcon className="w-5 h-5" />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <span className="text-sm font-semibold text-[var(--color-text)] truncate block">
          {item.name}
        </span>
        <div className="flex items-center gap-2 mt-0.5">
          {/* On search results the question is WHERE it is, so the location
              path earns this line; elsewhere (inside a container) the path is
              redundant and the code stays the more useful fact. */}
          {item.location ? (
            <span className="text-[10px] text-[var(--color-text-muted)] truncate">
              {[item.location.area, item.location.container].filter(Boolean).join(' › ')}
            </span>
          ) : (
            <span className="text-[10px] font-mono text-[var(--color-text-muted)]">
              {item.qrCode}
            </span>
          )}
          <Badge variant={conditionVariant[item.condition]}>{item.condition}</Badge>
          <Badge variant={statusVariant[item.status]}>{item.status}</Badge>
        </div>
        {item.purchasePrice != null && (
          <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
            ${item.purchasePrice.toFixed(2)}
          </p>
        )}
      </div>

      <ChevronRight className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
    </Card>
  );
}

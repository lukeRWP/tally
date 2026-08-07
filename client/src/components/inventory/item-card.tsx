import { useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { RuledRow } from '@/components/ui/ruled-row';
import { getItemIcon } from '@/lib/item-icons';
import type { Item } from '@/types/inventory';

interface ItemCardProps {
  item: Item;
  /** When set, the row becomes a selection toggle instead of a link. */
  selectable?: boolean;
  selected?: boolean;
  onToggle?: () => void;
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

export function ItemCard({ item, selectable, selected, onToggle }: ItemCardProps) {
  const navigate = useNavigate();
  const FallbackIcon = getItemIcon(item.name);

  // A small square thumbnail is kept where a product image exists — real
  // inventory is easier to scan with it — but the row itself is a ruled
  // receipt line, not a card.
  const leading = (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--color-rule)] bg-[var(--color-elevated)] text-[var(--color-text-muted)] overflow-hidden">
      {item.photoUrl || item.productImageUrl ? (
        <img
          // The photo YOU took wins over the catalogue stock image — it is the
          // one that makes a barcode-less object recognisable in a list.
          src={item.photoUrl || item.productImageUrl || ''}
          alt=""
          className="h-8 w-8 object-cover"
          loading="lazy"
        />
      ) : (
        <FallbackIcon className="h-4 w-4" />
      )}
    </span>
  );

  return (
    <RuledRow
      onNavigate={() => navigate(`/item/${item.id}`)}
      selectable={selectable}
      selected={selected}
      onToggle={onToggle}
      selectLabel={`Select ${item.name}`}
      leading={leading}
      title={item.name}
      titleTrailing={
        <>
          <Badge variant={conditionVariant[item.condition]}>{item.condition}</Badge>
          <Badge variant={statusVariant[item.status]}>{item.status}</Badge>
        </>
      }
      // On search results the question is WHERE it is, so the location path
      // earns the meta line; elsewhere the code is the more useful fact.
      meta={
        item.location
          ? [item.location.area, item.location.container].filter(Boolean).join(' › ')
          : item.qrCode
      }
      trailing={
        item.purchasePrice != null ? (
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--color-text-muted)]">
            ${item.purchasePrice.toFixed(2)}
          </span>
        ) : undefined
      }
    />
  );
}

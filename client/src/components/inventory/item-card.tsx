import { useNavigate } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { RuledRow } from '@/components/ui/ruled-row';
import { getItemIcon } from '@/lib/item-icons';
import type { Item } from '@/types/inventory';
import { COMPLETENESS_LABEL, isPartial } from '@/lib/completeness';

interface ItemCardProps {
  item: Item;
  /**
   * Supplied by a split view: the row SELECTS instead of navigating, so the
   * results stay on screen. Without it the row navigates exactly as before.
   * A wrapper cannot do this from outside — RuledRow owns the click, so an
   * outer onClick fires alongside the navigation rather than instead of it.
   */
  onSelect?: () => void;
  /** When set, the row becomes a selection toggle instead of a link. */
  selectable?: boolean;
  selected?: boolean;
  /** `shift` is true for a shift-click — the page turns that into a range. */
  onToggle?: (shift: boolean) => void;
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

export function ItemCard({ item, selectable, selected, onToggle, onSelect }: ItemCardProps) {
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
          //
          // Thumbnail first: this box is 32px, and the original is downscaled
          // to 1600px on upload, so the full-size photo is roughly a thousand
          // times the pixels this needs. Falls back to it when no derivative
          // exists yet — the server generates one on first sight.
          src={item.photoThumbUrl || item.photoUrl || item.productImageUrl || ''}
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
      onNavigate={() => (onSelect ? onSelect() : navigate(`/item/${item.id}`))}
      selectable={selectable}
      selected={selected}
      onToggle={onToggle}
      selectLabel={`Select ${item.name}`}
      leading={leading}
      title={item.name}
      titleTrailing={
        <>
          {/* First, and the loudest variant available: it changes what the row
              IS. Everything else describes the thing; this says the thing is
              not here. Reading "Dell XPS 15" in a tote and finding a box is the
              failure this exists to prevent. */}
          {isPartial(item) && (
            <Badge variant="warning">{COMPLETENESS_LABEL[item.completeness]}</Badge>
          )}
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

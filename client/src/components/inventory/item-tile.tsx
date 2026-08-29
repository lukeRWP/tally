import { useNavigate } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { getItemIcon } from '@/lib/item-icons';
import { COMPLETENESS_LABEL, isPartial } from '@/lib/completeness';
import type { Item } from '@/types/inventory';

/**
 * An item as a card, for grids.
 *
 * A ruled row is a receipt line — it reads at a glance because everything sits
 * on one baseline, which is exactly right in a long list you are scanning down.
 * A grid asks a different question: "which of these?" — and that is answered by
 * the picture, so the tile leads with it and puts the name underneath.
 *
 * Rows are still right for search results and a bin's contents, where you are
 * working down a list. This is for the short, browsable sets: what you added
 * recently.
 */
export function ItemTile({ item }: { item: Item }) {
  const navigate = useNavigate();
  const FallbackIcon = getItemIcon(item.name);
  const photo = item.photoThumbUrl || item.photoUrl || item.productImageUrl;
  const where = item.location
    ? [item.location.area, item.location.container].filter(Boolean).join(' › ')
    : item.qrCode;

  return (
    <button
      type="button"
      onClick={() => navigate(`/item/${item.id}`)}
      className="group flex flex-col overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-rule)] text-left transition-colors hover:border-[var(--color-text)] focus-visible:outline-none focus-visible:border-[var(--color-text)]"
    >
      <span className="flex aspect-[4/3] w-full items-center justify-center overflow-hidden bg-[var(--color-elevated)] text-[var(--color-text-muted)]">
        {photo ? (
          <img src={photo} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <FallbackIcon className="h-8 w-8" />
        )}
      </span>

      <span className="flex min-w-0 flex-col gap-1 p-2.5">
        <span className="flex items-start gap-1.5">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{item.name}</span>
          {item.purchasePrice != null && (
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--color-text-muted)]">
              ${item.purchasePrice.toFixed(2)}
            </span>
          )}
        </span>

        <span className="block truncate font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
          {where}
        </span>

        {/* Only the exceptions get a badge — a grid of tiles each wearing
            "GOOD · ACTIVE" is noise, and the two states that change what the
            thing IS are the ones worth the space. */}
        {(isPartial(item) || item.status !== 'active') && (
          <span className="flex flex-wrap gap-1 pt-0.5">
            {isPartial(item) && (
              <Badge variant="warning">{COMPLETENESS_LABEL[item.completeness]}</Badge>
            )}
            {item.status !== 'active' && <Badge variant="info">{item.status}</Badge>}
          </span>
        )}
      </span>
    </button>
  );
}

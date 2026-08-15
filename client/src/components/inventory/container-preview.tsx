import { useNavigate } from 'react-router-dom';
import { ArrowUpRight, Package } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ColHead } from '@/components/ui/col-head';
import { Skeleton } from '@/components/ui/skeleton';
import { useContainer, useItems } from '@/hooks/use-inventory';
import type { Item } from '@/types/inventory';
import { COMPLETENESS_LABEL, isPartial } from '@/lib/completeness';

/**
 * What is in the selected bin, shown beside the tree rather than instead of it.
 *
 * On a phone, opening a bin replaces the screen and going back costs a tap and
 * your scroll position. At a desk there is room to keep the tree in view, so
 * comparing two bins is a click each instead of a round trip. This is a
 * PREVIEW, not the container page: it answers "what's in there" and hands off
 * to the full page for anything that edits.
 */
export function ContainerPreview({ containerId }: { containerId: number | null }) {
  const navigate = useNavigate();
  const { data: container, isLoading: loadingContainer } = useContainer(containerId ?? 0);
  const { data: items, isLoading: loadingItems } = useItems(containerId ?? 0);

  if (containerId == null) {
    return (
      <div className="flex h-full min-h-[240px] items-center justify-center rounded-[var(--radius-sm)] border border-dashed border-[var(--color-rule)] px-6">
        <p className="text-center text-sm text-[var(--color-text-muted)]">
          Pick a bin to see what is inside.
          <span className="mt-1 block font-mono text-[10px] uppercase tracking-[0.08em]">
            the tree stays put while you look
          </span>
        </p>
      </div>
    );
  }

  if (loadingContainer || loadingItems) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (!container) return null;

  const rows = items ?? [];

  return (
    <div>
      <div className="flex items-start gap-2 border-b-2 border-[var(--color-text)] pb-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-bold uppercase tracking-[0.06em]">{container.name}</h2>
          <p className="truncate font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
            {[container.breadcrumb?.find((b) => b.type === 'area')?.name, container.type].filter(Boolean).join(' · ')}
            {' · '}{container.qrCode}
          </p>
        </div>
        {/* Anything that edits lives on the real page — this pane is for
            looking, so it never grows a second set of write controls to keep
            in step with the first. */}
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          onClick={() => navigate(`/container/${container.id}`)}
        >
          Open <ArrowUpRight className="ml-1 h-3 w-3" />
        </Button>
      </div>

      <ColHead className="mt-3">
        {rows.length} item{rows.length === 1 ? '' : 's'}
      </ColHead>

      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-[var(--color-text-muted)]">This bin is empty.</p>
      ) : (
        <ul>
          {rows.map((item: Item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => navigate(`/item/${item.id}`)}
                className="flex w-full items-center gap-2 border-b border-[var(--color-rule)] py-2 text-left hover:bg-[var(--color-elevated)]"
              >
                <Package className="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{item.name}</span>
                  {item.quantity > 1 && (
                    <span className="block font-mono text-[10px] text-[var(--color-text-muted)]">
                      qty {item.quantity}
                    </span>
                  )}
                </span>
                {isPartial(item) && (
                  <Badge variant="warning">{COMPLETENESS_LABEL[item.completeness]}</Badge>
                )}
                {item.purchasePrice != null && (
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--color-text-muted)]">
                    ${item.purchasePrice.toFixed(2)}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

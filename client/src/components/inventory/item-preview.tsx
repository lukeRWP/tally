import { useNavigate } from 'react-router-dom';
import { ArrowUpRight, Camera, MapPin } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SplitEmpty } from '@/components/layout/split-view';
import { useItem } from '@/hooks/use-inventory';
import { COMPLETENESS_LABEL, isPartial } from '@/lib/completeness';

/** One fact, kept beside its label rather than stretched across the pane. */
function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-[var(--color-rule)] py-1.5">
      <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
        {label}
      </span>
      <span className="min-w-0 truncate text-sm">{value}</span>
    </div>
  );
}

/**
 * The selected search result, beside the results rather than instead of them.
 *
 * Search is the app's first job — "where is X?" — and the answer is usually
 * one line: which bin, in which area. Opening a full page to read that line
 * and then going back to try the next result is the round trip this removes.
 */
export function ItemPreview({ itemId }: { itemId: number | null }) {
  const navigate = useNavigate();
  const { data: item, isLoading } = useItem(itemId ?? 0);

  if (itemId == null) {
    return <SplitEmpty hint="the results stay put while you look">Pick a result to see where it lives.</SplitEmpty>;
  }
  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (!item) return null;

  const photo = item.photoUrl || item.productImageUrl;
  const where = item.location
    ? [item.location.area, item.location.container].filter(Boolean).join(' › ')
    : item.breadcrumb?.map((b) => b.name).join(' › ');

  return (
    // Capped: the pane is ~950px at 1920 and a full-width square photo would be
    // 950px tall, pushing every fact about the item below the fold.
    <div className="max-w-[560px]">
      <div className="flex items-start gap-2 border-b-2 border-[var(--color-text)] pb-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-bold uppercase tracking-[0.06em]">{item.name}</h2>
          <p className="truncate font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
            {item.qrCode}
          </p>
        </div>
        <Button size="sm" variant="outline" className="shrink-0" onClick={() => navigate(`/item/${item.id}`)}>
          Open <ArrowUpRight className="ml-1 h-3 w-3" />
        </Button>
      </div>

      {/* WHERE first and loudest. It is the question that brought you here. */}
      <div className="mt-3 flex items-start gap-2 rounded-[var(--radius-sm)] bg-[var(--color-elevated)] px-3 py-2">
        <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />
        <span className="min-w-0 text-sm font-semibold">{where || 'Not placed yet'}</span>
      </div>

      {photo ? (
        <img src={photo} alt={item.name}
          className="mt-3 h-[260px] w-full rounded-[var(--radius-sm)] border border-[var(--color-rule)] object-cover" />
      ) : (
        <div className="mt-3 flex h-[160px] w-full items-center justify-center rounded-[var(--radius-sm)] border border-dashed border-[var(--color-rule)] text-[var(--color-text-muted)]">
          <Camera className="h-7 w-7" />
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-1">
        <Badge variant="default">{item.condition}</Badge>
        <Badge variant={item.status === 'lent' ? 'info' : 'success'}>{item.status}</Badge>
        {isPartial(item) && <Badge variant="warning">{COMPLETENESS_LABEL[item.completeness]}</Badge>}
      </div>

      <div className="mt-3">
        {item.quantity > 1 && <Fact label="Quantity" value={item.quantity} />}
        {item.purchasePrice != null && <Fact label="Paid" value={`$${item.purchasePrice.toFixed(2)}`} />}
        {item.currentValue != null && (
          <Fact
            label="Value"
            value={
              <>
                ${item.currentValue.toFixed(2)}
                {item.currentValueIsEstimate && (
                  <span className="ml-1 font-mono text-[9px] uppercase text-[var(--color-text-muted)]">est</span>
                )}
              </>
            }
          />
        )}
        {item.description && <Fact label="Description" value={item.description} />}
      </div>
    </div>
  );
}

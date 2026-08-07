import { useNavigate } from 'react-router-dom';
import { X, ScanLine, Undo2 } from 'lucide-react';
import { useCarryStore } from '@/store/carry-store';
import { useMoveItem } from '@/hooks/use-inventory';
import { toast } from '@/components/ui/toast';

/**
 * The carry banner: while anything is "in hand" this sits above the bottom nav
 * on every screen, so the app has exactly one open question — where does this
 * go? — and any container label answers it.
 *
 * It also owns the undo for the last completed move, because the place you end
 * up after moving something is wherever you happened to be standing.
 */
export function CarryBanner() {
  const navigate = useNavigate();
  const carried = useCarryStore((s) => s.carried);
  const lastMove = useCarryStore((s) => s.lastMove);
  const clear = useCarryStore((s) => s.clear);
  const clearLastMove = useCarryStore((s) => s.clearLastMove);
  const moveItem = useMoveItem();

  async function undo() {
    if (!lastMove) return;
    // Each item goes back to the container it came from. Items picked up
    // without a known origin can't be reversed, so they're reported, not
    // silently skipped.
    const reversible = lastMove.items.filter((i) => i.fromContainerId);
    try {
      await Promise.all(
        reversible.map((i) =>
          moveItem.mutateAsync({ id: i.id, containerId: i.fromContainerId as number }),
        ),
      );
      const skipped = lastMove.items.length - reversible.length;
      toast(
        skipped > 0
          ? `Put ${reversible.length} back — ${skipped} had no previous bin`
          : reversible.length === 1
            ? `${reversible[0].name} put back`
            : `${reversible.length} items put back`,
      );
      clearLastMove();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not undo the move');
    }
  }

  if (lastMove) {
    return (
      <div className="fixed bottom-[calc(4.6rem+env(safe-area-inset-bottom))] xl:bottom-6 left-3 right-3 xl:left-auto xl:right-6 xl:w-[26rem] z-40
        border-2 border-[var(--color-text)] bg-[var(--color-bg)] rounded-[var(--radius-sm)] px-3 py-2 flex items-center gap-2">
        <span className="min-w-0 flex-1">
          <span className="block font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
            moved to {lastMove.toContainerName}
          </span>
          <span className="block text-sm font-semibold truncate">
            {lastMove.items.length === 1
              ? lastMove.items[0].name
              : `${lastMove.items.length} items`}
          </span>
        </span>
        <button
          type="button"
          onClick={undo}
          disabled={moveItem.isPending}
          className="shrink-0 inline-flex items-center gap-1 border border-[var(--color-primary)] text-[var(--color-primary)] rounded-[var(--radius-sm)] px-2 min-h-[32px] font-mono text-[10px] font-bold uppercase tracking-[0.06em] disabled:opacity-50"
        >
          <Undo2 className="w-3.5 h-3.5" />
          Undo
        </button>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={clearLastMove}
          className="shrink-0 min-w-[32px] min-h-[32px] inline-flex items-center justify-center text-[var(--color-text-muted)]"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    );
  }

  if (carried.length === 0) return null;

  return (
    <div className="fixed bottom-[calc(4.6rem+env(safe-area-inset-bottom))] xl:bottom-6 left-3 right-3 xl:left-auto xl:right-6 xl:w-[26rem] z-40
      border-2 border-[var(--color-primary)] bg-[var(--color-primary-bg)] rounded-[var(--radius-sm)] px-3 py-2 flex items-center gap-2">
      <span className="min-w-0 flex-1">
        <span className="block font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-primary)] font-bold">
          carrying {carried.length > 1 ? `· ${carried.length}` : ''}
        </span>
        <span className="block text-sm font-semibold truncate">
          {carried.length === 1 ? carried[0].name : `${carried.length} items`}
        </span>
        {carried.length === 1 && carried[0].fromContainerName && (
          <span className="block font-mono text-[10px] text-[var(--color-text-muted)] truncate">
            from {carried[0].fromContainerName}
          </span>
        )}
      </span>
      <button
        type="button"
        onClick={() => navigate('/scan?mode=move')}
        className="shrink-0 inline-flex items-center gap-1 bg-[var(--color-primary)] text-white rounded-[var(--radius-sm)] px-2.5 min-h-[34px] font-mono text-[10px] font-bold uppercase tracking-[0.06em]"
      >
        <ScanLine className="w-3.5 h-3.5" />
        Scan bin
      </button>
      <button
        type="button"
        aria-label="Put down"
        onClick={clear}
        className="shrink-0 min-w-[32px] min-h-[32px] inline-flex items-center justify-center text-[var(--color-primary)]"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

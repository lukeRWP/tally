import { useNavigate } from 'react-router';
import { X, ScanLine, Undo2 } from 'lucide-react';
import { useCarryStore, type CarriedItem } from '@/store/carry-store';
import { useMoveItem, useMoveContainer } from '@/hooks/use-inventory';
import { useLayoutMode } from '@/hooks/use-layout-mode';
import { carryBannerOffsetCss, useCarryBannerShowing } from '@/hooks/use-bottom-stack';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

/**
 * The carry banner: while anything is "in hand" this sits above the bottom nav
 * on every screen, so the app has exactly one open question — where does this
 * go? — and any container label answers it.
 *
 * It also owns the undo for the last completed move, because the place you end
 * up after moving something is wherever you happened to be standing.
 */
/**
 * "3 items", "2 bins", or "3 things" for a mixed load — the banner should never
 * call a container an item.
 */
function describeLoad(load: CarriedItem[]): string {
  const bins = load.filter((c) => c.kind === 'container').length;
  if (bins === 0) return `${load.length} items`;
  if (bins === load.length) return `${bins} ${bins === 1 ? 'bin' : 'bins'}`;
  return `${load.length} things`;
}

export function CarryBanner() {
  const navigate = useNavigate();
  // Docks bottom-right as a panel when there is no bottom nav to sit above,
  // and spans the width above the bar when there is. The `bottom` offset
  // itself comes from the shared stack model (use-bottom-stack.ts) — an
  // inline style, not a class, since that model computes a runtime value
  // Tailwind's build-time class scanner cannot see.
  const touch = useLayoutMode() !== 'sidebar';
  const dockClassName = touch ? 'left-3 right-3' : 'right-6 w-[26rem]';
  const dockOffset = carryBannerOffsetCss(touch);
  // Whether THIS banner should render at all — shared with root-layout.tsx's
  // own `<main>` reserve and the toast layer (use-bottom-stack.ts) so the
  // /move exception (below) can't drift into a second, independent copy of
  // the same condition the way the offset arithmetic once did.
  const showing = useCarryBannerShowing();
  const carried = useCarryStore((s) => s.carried);
  const lastMove = useCarryStore((s) => s.lastMove);
  const clear = useCarryStore((s) => s.clear);
  const clearLastMove = useCarryStore((s) => s.clearLastMove);
  const moveItem = useMoveItem();
  const moveContainer = useMoveContainer();

  async function undo() {
    if (!lastMove) return;
    // Everything goes back where it came from. A container's origin may be an
    // area (it sat at the top level) rather than a parent container. Anything
    // picked up without a known origin can't be reversed, so it is reported
    // rather than silently skipped.
    const reversible = lastMove.items.filter((i) => i.fromContainerId || i.fromAreaId);
    try {
      await Promise.all(
        reversible.map((i) =>
          i.kind === 'container'
            ? moveContainer.mutateAsync(
                i.fromContainerId
                  ? { id: i.id, parentContainerId: i.fromContainerId }
                  : { id: i.id, parentContainerId: null, areaId: i.fromAreaId as number },
              )
            : moveItem.mutateAsync({ id: i.id, containerId: i.fromContainerId as number }),
        ),
      );
      const skipped = lastMove.items.length - reversible.length;
      toast(
        lastMove.unlinkedCount && lastMove.unlinkedCount > 0
          ? 'Moved back · unlinked accessories were not restored'
          : skipped > 0
            ? `Put ${reversible.length} back — ${skipped} had no previous home`
            : reversible.length === 1
              ? `${reversible[0].name} put back`
              : `${describeLoad(reversible)} put back`,
      );
      clearLastMove();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not undo the move');
    }
  }

  // /move asks "where does this go?" and owns both the carrying state and the
  // undo for what it just did — `showing` is already false there (see
  // useCarryBannerShowing's own doc comment). The guard has to come BEFORE
  // the lastMove branch or that banner still renders there, giving one move
  // two Undos.
  if (!showing) return null;

  if (lastMove) {
    return (
      <div
        className={cn('fixed z-40', dockClassName,
          'border-2 border-[var(--color-text)] bg-[var(--color-bg)] rounded-[var(--radius-sm)] px-3 py-2 flex items-center gap-2')}
        style={{ bottom: dockOffset }}
      >
        <span className="min-w-0 flex-1">
          <span className="block font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
            moved to {lastMove.to.name}
          </span>
          <span className="block text-sm font-semibold truncate">
            {lastMove.items.length === 1
              ? lastMove.items[0].name
              : describeLoad(lastMove.items)}
          </span>
        </span>
        <button
          type="button"
          onClick={undo}
          disabled={moveItem.isPending || moveContainer.isPending}
          className="shrink-0 inline-flex items-center gap-1 border border-[var(--color-primary)] text-[var(--color-primary)] rounded-[var(--radius-sm)] px-2 min-h-[max(32px,var(--tap-min))] font-mono text-[10px] font-bold uppercase tracking-[0.06em] disabled:opacity-50"
        >
          <Undo2 className="w-3.5 h-3.5" />
          Undo
        </button>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={clearLastMove}
          className="shrink-0 min-w-[max(32px,var(--tap-min))] min-h-[max(32px,var(--tap-min))] inline-flex items-center justify-center text-[var(--color-text-muted)]"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    );
  }

  // Reaching here means `showing` was true and `lastMove` was falsy, so
  // `useCarryBannerShowing`'s own `||` guarantees carried.length > 0 —
  // no separate empty-check needed.
  return (
    <div
      className={cn('fixed z-40', dockClassName,
        // --color-primary-bg is an 8%-alpha tint meant for chips on solid
        // surfaces; this banner floats over page content, so the tint is
        // layered on an opaque base or the page bleeds through it.
        '[background:linear-gradient(var(--color-primary-bg),var(--color-primary-bg)),var(--color-bg)]',
        'border-2 border-[var(--color-primary)] rounded-[var(--radius-sm)] px-3 py-2 flex items-center gap-2')}
      style={{ bottom: dockOffset }}
    >
      <span className="min-w-0 flex-1">
        <span className="block font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-primary)] font-bold">
          carrying {carried.length > 1 ? `· ${carried.length}` : ''}
        </span>
        <span className="block text-sm font-semibold truncate">
          {carried.length === 1 ? carried[0].name : describeLoad(carried)}
        </span>
        {carried.length === 1 && carried[0].fromContainerName && (
          <span className="block font-mono text-[10px] text-[var(--color-text-muted)] truncate">
            from {carried[0].fromContainerName}
          </span>
        )}
      </span>
      <button
        type="button"
        onClick={() => navigate('/move')}
        className="shrink-0 inline-flex items-center gap-1 bg-[var(--color-primary)] text-white rounded-[var(--radius-sm)] px-2.5 min-h-[max(34px,var(--tap-min))] font-mono text-[10px] font-bold uppercase tracking-[0.06em]"
      >
        <ScanLine className="w-3.5 h-3.5" />
        {carried.some((c) => c.kind === 'container') ? 'Scan dest' : 'Scan bin'}
      </button>
      <button
        type="button"
        aria-label="Put down"
        onClick={clear}
        className="shrink-0 min-w-[max(32px,var(--tap-min))] min-h-[max(32px,var(--tap-min))] inline-flex items-center justify-center text-[var(--color-primary)]"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

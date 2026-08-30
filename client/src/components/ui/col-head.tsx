import * as React from 'react';
import { cn } from '@/lib/utils';
import { useCoarsePointer } from '@/hooks/use-coarse-pointer';

/**
 * The column head from the printed pick-ticket: a mono, uppercase label with a
 * heavy ink underline, and an optional right-aligned action in the accent
 * colour ("View all ›", "Select ✓"). This is the section divider for every
 * ruled list — it replaces the old sentence-case `<h2>` section headings.
 */
export function ColHead({
  children,
  action,
  onAction,
  hint,
  className,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
  onAction?: () => void;
  /**
   * Quietly note that the rows below answer to the keyboard ring (#295).
   *
   * Six surfaces now support j/k, Enter, `/` and Esc, and nothing in the app
   * ever said so — the fastest way to use tally at a desk was a secret. This
   * is the cheapest fix that isn't a lie: ColHead is the one component every
   * ringed list already renders, so the hint rides along for free instead of
   * needing its own first-run banner or `?` overlay.
   *
   * Opt-in, not automatic, for two reasons. First, most ColHeads (Settings,
   * the item ledger, the recent-activity feed…) head a list nothing rings
   * over, and a hint that means nothing would just be noise on every one of
   * them. Second, a page with two ringed ColHeads (container-detail's
   * "Nested" + "Items", one ring walking both) only needs the hint on
   * whichever section the ring actually STARTS at — pass it there, not on
   * every heading the page happens to render, or the quiet hint becomes the
   * loud legend the issue explicitly warned against.
   *
   * Gated on the pointer, not on `hint` alone: the keys genuinely don't exist
   * on a coarse pointer (phone, tablet without a keyboard), so advertising
   * them there would be actively misleading rather than merely useless. This
   * mirrors every ringed surface's own `useCoarsePointer`/`useLayoutMode`
   * gate on the ring itself — see destination-picker.tsx for the sibling
   * case of a component with no layout mode of its own.
   */
  hint?: boolean;
  className?: string;
}) {
  const coarse = useCoarsePointer();
  return (
    <div
      className={cn(
        'flex items-baseline gap-2 border-b-2 border-[var(--color-rule)] pb-1.5',
        'font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]',
        className,
      )}
    >
      <span className="min-w-0 flex-1 truncate [&_b]:font-bold [&_b]:text-[var(--color-text)]">
        {children}
      </span>
      {hint && !coarse && (
        <span
          className="shrink-0 whitespace-nowrap font-normal normal-case tracking-normal text-[var(--color-text-muted)] opacity-70"
          title="Keyboard: j/k move · Enter opens · / search · Esc back"
        >
          j k ↵
        </span>
      )}
      {action != null &&
        (onAction ? (
          // Real hit area: the colhead action is often the only add control on
          // the page, so it must clear the 24px WCAG target-size floor even
          // though the label itself is tiny mono text.
          <button
            type="button"
            onClick={onAction}
            className="shrink-0 -my-1 px-1 min-h-[max(28px,var(--tap-min))] inline-flex items-center font-bold text-[var(--color-primary)] hover:opacity-80"
          >
            {action}
          </button>
        ) : (
          <span className="shrink-0 font-bold text-[var(--color-primary)]">{action}</span>
        ))}
    </div>
  );
}

/**
 * A single quiet key cap — "1", "d", the digit or letter a row-level binding
 * answers to. The shared visual vocabulary behind ColHead's own `j k ↵` and
 * behind /matches' candidate numerals (#295): a bordered mono chip small
 * enough to sit beside the button it doubles, never mistaken for content.
 *
 * Callers gate visibility on `!useCoarsePointer()` themselves — this
 * component renders unconditionally so it can be dropped into a list of
 * items already being mapped (an index-keyed badge) without re-deriving the
 * pointer check per row; see matches.tsx's CandidateCard.
 */
export function KeyCap({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex min-w-[1.4em] items-center justify-center rounded-[3px] border',
        'border-[var(--color-border)] px-1 py-px font-mono text-[10px] font-normal normal-case',
        'leading-[1.4] tracking-normal text-[var(--color-text-muted)]',
        className,
      )}
    >
      {children}
    </span>
  );
}

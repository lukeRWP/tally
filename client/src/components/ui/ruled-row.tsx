import * as React from 'react';
import { Check, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * One row of a ruled list — the receipt line that replaced the rounded card for
 * every entity (item, container, area, property). An ink hairline underneath,
 * a mono meta line, and one of two behaviours:
 *
 *  - navigate: the whole row is a button that opens the entity; a chevron hints it.
 *  - select:   the row toggles a leading checkbox instead (batch label staging),
 *              no chevron, no navigation.
 *
 * When it can do either it is a real <button>, so Enter/Space work for free and
 * screen readers announce the accessible name built from `title`. With neither
 * `onNavigate` nor `selectable` — the read-only public share view — it renders
 * a plain <div> with no chevron and no hover: a row with nothing to do must not
 * claim to be pressable, and the chevron must not promise a destination that
 * does not exist.
 */
export interface RuledRowProps {
  /** Fires on click when not in select mode. */
  onNavigate?: () => void;
  selectable?: boolean;
  selected?: boolean;
  /** `shift` is true for a shift-click — the page turns that into a range. */
  onToggle?: (shift: boolean) => void;
  /** Accessible label when selectable (e.g. "Select Cordless Drill"). */
  selectLabel?: string;
  /** Optional square thumbnail / icon block at the left. */
  leading?: React.ReactNode;
  title: React.ReactNode;
  /** Inline badges rendered next to the title. */
  titleTrailing?: React.ReactNode;
  /** Mono code / location line under the title. */
  meta?: React.ReactNode;
  /** Right-aligned content before the chevron (qty, status). */
  trailing?: React.ReactNode;
  animationDelay?: string;
}

export function RuledRow({
  onNavigate,
  selectable = false,
  selected = false,
  onToggle,
  selectLabel,
  leading,
  title,
  titleTrailing,
  meta,
  trailing,
  animationDelay,
}: RuledRowProps) {
  // The shift state only exists on the event, so it is read here and passed
  // up rather than reconstructed from a keydown listener somewhere else.
  const handleClick = selectable
    ? (e: React.MouseEvent) => onToggle?.(e.shiftKey)
    : onNavigate;
  const interactive = selectable || !!onNavigate;
  const Comp = interactive ? 'button' : 'div';
  return (
    <Comp
      type={interactive ? 'button' : undefined}
      onClick={interactive ? handleClick : undefined}
      aria-label={selectable ? selectLabel : undefined}
      aria-pressed={selectable ? selected : undefined}
      className={cn(
        // last:border-b-0 keeps a list from ending on a dangling hairline that
        // floats over the whitespace below or doubles against the next ColHead.
        'group flex w-full items-center gap-3 border-b border-[var(--color-rule)] last:border-b-0 py-3 text-left',
        'animate-fade-up transition-colors',
        interactive &&
          // Keyboard focus gets its own indicator, not the pressed/cursor
          // tint (#315): `bg-[var(--color-elevated)]` here used to double as
          // BOTH the active(press) feedback AND the focus-visible state, and
          // it sits only 0.027 lightness above the page — a Tab-focused row
          // read as indistinguishable from one being pressed. This borrows
          // button.tsx's own focus ring (ring-2 ring-primary) rather than
          // inventing a new one, but INSET rather than offset: rows are
          // stacked edge to edge with no gap between them, and an outside
          // ring (button's ring-offset-2) would bleed 2-4px into the row
          // above/below instead of framing the one that is actually focused.
          'active:bg-[var(--color-elevated)] hover:bg-[var(--color-elevated)]/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-primary)]',
        selected && 'bg-[var(--color-primary-bg)]',
      )}
      style={animationDelay ? { animationDelay } : undefined}
    >
      {selectable && (
        <span
          className={cn(
            'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[2px] border-[1.6px]',
            selected
              ? 'border-[var(--color-text)] bg-[var(--color-text)] text-[var(--color-bg)]'
              : 'border-[var(--color-text)] text-transparent',
          )}
        >
          <Check className="h-3 w-3" strokeWidth={3} />
        </span>
      )}

      {leading}

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-[var(--color-text)]">{title}</span>
          {titleTrailing}
        </span>
        {meta != null && (
          <span className="mt-0.5 block truncate font-mono text-[11px] tracking-[0.02em] text-[var(--color-text-muted)]">
            {meta}
          </span>
        )}
      </span>

      {trailing}

      {!selectable && interactive && (
        <ChevronRight className="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />
      )}
    </Comp>
  );
}

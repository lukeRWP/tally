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
 * It is always a real <button>, so Enter/Space work for free and screen readers
 * announce the accessible name built from `title`.
 */
export interface RuledRowProps {
  /** Fires on click when not in select mode. */
  onNavigate?: () => void;
  selectable?: boolean;
  selected?: boolean;
  onToggle?: () => void;
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
  const handleClick = selectable ? onToggle : onNavigate;
  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={selectable ? selectLabel : undefined}
      aria-pressed={selectable ? selected : undefined}
      className={cn(
        'group flex w-full items-center gap-3 border-b border-[var(--color-rule)] py-3 text-left',
        'animate-fade-up transition-colors',
        'hover:bg-[var(--color-elevated)]/60 focus-visible:outline-none focus-visible:bg-[var(--color-elevated)]',
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

      {!selectable && (
        <ChevronRight className="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />
      )}
    </button>
  );
}

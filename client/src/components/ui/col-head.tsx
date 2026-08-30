import * as React from 'react';
import { cn } from '@/lib/utils';

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
  className,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
  onAction?: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-baseline justify-between gap-2 border-b-2 border-[var(--color-rule)] pb-1.5',
        'font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]',
        className,
      )}
    >
      <span className="truncate [&_b]:font-bold [&_b]:text-[var(--color-text)]">{children}</span>
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

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * The inverted title bar from the printed labels, as a screen primitive:
 * ink bar, knockout text, tight tracking. Built from the theme's text/bg
 * tokens so it inverts automatically — an ink bar on paper in light mode,
 * a paper bar on ink in dark mode, exactly like the label itself.
 */
export function TitleBar({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 bg-[var(--color-text)] text-[var(--color-bg)]',
        'px-3 py-1.5 rounded-[var(--radius-sm)] select-none',
        className,
      )}
    >
      <span className="text-sm font-extrabold uppercase tracking-[0.08em]">{children}</span>
    </div>
  );
}

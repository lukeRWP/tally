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
        'px-3 py-1.5 rounded-[var(--radius-sm)] select-none min-w-0',
        className,
      )}
    >
      {/* break long spaceless tokens (SKUs, model codes) so knockout glyphs
          never spill past the ink box and paint paper-on-paper (invisible). */}
      <span className="text-sm font-extrabold uppercase tracking-[0.08em] min-w-0 [overflow-wrap:anywhere]">
        {children}
      </span>
    </div>
  );
}

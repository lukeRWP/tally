import * as React from 'react';

/**
 * List on the left, the selected thing on the right.
 *
 * Used by every browse surface that has a "which one?" followed by a "what is
 * it?". Extracted after the second one so the two cannot drift: a sticky panel
 * on one page and a scrolling one on another is the kind of difference nobody
 * decides, they just end up with.
 *
 * Only ever rendered in sidebar chrome — the caller decides, because on a
 * phone the answer is to navigate, not to split a 390px screen in two.
 */
export function SplitView({ list, detail }: { list: React.ReactNode; detail: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(300px,400px)_minmax(0,1fr)] items-start gap-6">
      <div className="min-w-0">{list}</div>
      {/* Sticky so the detail stays put while the list scrolls past it, which
          is the entire reason for not navigating. Capped to the viewport so a
          long detail scrolls inside its own pane rather than dragging the page. */}
      <div className="sticky top-4 max-h-[calc(100dvh-7rem)] overflow-y-auto min-w-0">
        {detail}
      </div>
    </div>
  );
}

/** What a split view shows before anything is chosen. */
export function SplitEmpty({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex h-full min-h-[240px] items-center justify-center rounded-[var(--radius-sm)] border border-dashed border-[var(--color-rule)] px-6">
      <p className="text-center text-sm text-[var(--color-text-muted)]">
        {children}
        {hint && (
          <span className="mt-1 block font-mono text-[10px] uppercase tracking-[0.08em]">{hint}</span>
        )}
      </p>
    </div>
  );
}

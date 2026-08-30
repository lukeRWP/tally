import { cn } from '@/lib/utils';

/**
 * The scope selector for anything property-scoped — tags, printers, reports.
 * A pill, because it filters rather than commits, and ink-filled when it is the
 * one in force, so it reads the same on paper and on ink.
 *
 * One property is not a choice, so it renders nothing: the page has already
 * defaulted to it.
 */
export function PropertyChips({
  properties,
  value,
  onChange,
}: {
  properties: { id: number; name: string }[];
  value: number;
  onChange: (id: number) => void;
}) {
  if (properties.length < 2) return null;

  return (
    <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1" role="group" aria-label="Property">
      {properties.map((p) => (
        <button
          key={p.id}
          type="button"
          aria-pressed={value === p.id}
          onClick={() => onChange(p.id)}
          className={cn(
            'shrink-0 whitespace-nowrap rounded-full border px-3 min-h-[max(32px,var(--tap-min))] font-mono text-[10px] uppercase tracking-[0.08em] transition-colors',
            value === p.id
              ? 'bg-[var(--color-text)] text-[var(--color-bg)] border-[var(--color-text)]'
              : 'border-[var(--color-rule)] text-[var(--color-text-secondary)] hover:bg-[var(--color-elevated)]',
          )}
        >
          {p.name}
        </button>
      ))}
    </div>
  );
}

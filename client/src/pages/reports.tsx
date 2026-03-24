import { BarChart2 } from 'lucide-react';

export function Reports() {
  return (
    <div className="flex flex-col items-center justify-center py-20 gap-4">
      <div className="flex items-center justify-center w-16 h-16 rounded-full bg-[var(--color-purple-bg)]">
        <BarChart2 className="w-8 h-8 text-[var(--color-purple)]" />
      </div>
      <h1 className="text-lg font-bold text-[var(--color-text)]">Reports</h1>
      <p className="text-sm text-[var(--color-text-muted)] text-center max-w-xs">
        Reports coming in Phase 5. You will be able to view inventory summaries, value tracking, and export data.
      </p>
    </div>
  );
}

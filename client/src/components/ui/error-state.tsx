import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Inline error state for a data screen whose fetch failed — distinguishes a
 * real error (with a retry) from genuinely-empty data.
 */
export function ErrorState({
  message = "Couldn't load this. Check your connection and try again.",
  onRetry,
}: {
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 text-center py-10">
      <AlertTriangle className="w-8 h-8 text-[var(--color-amber)]" />
      <p className="text-sm text-[var(--color-text-secondary)] max-w-xs">{message}</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="w-4 h-4" />
          Try again
        </Button>
      )}
    </div>
  );
}

/**
 * Same idea as `ErrorState`, scaled down for a single ruled row inside an
 * otherwise-fine page — a nested-containers or items sub-list whose own
 * fetch failed. A big centered block reads as if the whole page fell over;
 * one muted line matches the "No X yet" copy already sitting in that slot,
 * with a Retry styled like the other inline row actions (ColHead's "+ Add").
 */
export function SectionError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex items-center gap-2 py-3">
      <p className="font-mono text-[11px] uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
        {message}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="-my-1 px-1 min-h-[28px] inline-flex items-center font-mono text-[11px] uppercase tracking-[0.06em] font-bold text-[var(--color-primary)] hover:opacity-80"
      >
        Retry
      </button>
    </div>
  );
}

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

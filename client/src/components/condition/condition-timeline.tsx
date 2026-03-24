import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useConditionHistory } from '@/hooks/use-files';
import type { ConditionSnapshot } from '@/types/files';

const conditionVariant: Record<ConditionSnapshot['condition'], 'success' | 'default' | 'warning' | 'danger'> = {
  new: 'success',
  good: 'default',
  fair: 'warning',
  poor: 'danger',
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

interface ConditionTimelineProps {
  itemId: number;
}

export function ConditionTimeline({ itemId }: ConditionTimelineProps) {
  const { data: snapshots, isLoading } = useConditionHistory(itemId);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3">
        {[1, 2].map((i) => (
          <div key={i} className="flex gap-3">
            <Skeleton className="w-16 h-16 rounded-[var(--radius-md)] shrink-0" />
            <div className="flex flex-col gap-1.5 flex-1">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-3 w-32" />
              <Skeleton className="h-3 w-24" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (!snapshots || snapshots.length === 0) {
    return (
      <p className="text-xs text-[var(--color-text-muted)] py-1">No condition records yet.</p>
    );
  }

  // Newest first
  const sorted = [...snapshots].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  return (
    <div className="flex flex-col gap-4">
      {sorted.map((snapshot) => (
        <div key={snapshot.id} className="flex gap-3">
          {/* Photo thumbnail */}
          {snapshot.photoUrl ? (
            <button
              type="button"
              onClick={() => window.open(snapshot.photoUrl, '_blank')}
              className="w-16 h-16 rounded-[var(--radius-md)] overflow-hidden shrink-0 border border-[var(--color-border)] cursor-pointer hover:opacity-80 transition-opacity"
            >
              <img
                src={snapshot.photoUrl}
                alt="Condition photo"
                className="w-full h-full object-cover"
              />
            </button>
          ) : (
            <div className="w-16 h-16 rounded-[var(--radius-md)] shrink-0 border border-dashed border-[var(--color-border)] bg-[var(--color-elevated)] flex items-center justify-center">
              <span className="text-[10px] text-[var(--color-text-muted)]">No photo</span>
            </div>
          )}

          {/* Details */}
          <div className="flex flex-col gap-1 flex-1 min-w-0">
            <Badge variant={conditionVariant[snapshot.condition]} className="self-start">
              {snapshot.condition}
            </Badge>
            {snapshot.notes && (
              <p className="text-xs text-[var(--color-text-secondary)] line-clamp-2">{snapshot.notes}</p>
            )}
            <p className="text-[10px] text-[var(--color-text-muted)]">
              {formatDate(snapshot.createdAt)}
              {snapshot.recordedByName && ` · by ${snapshot.recordedByName}`}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

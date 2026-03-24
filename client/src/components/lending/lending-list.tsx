import * as React from 'react';
import { RotateCcw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ReturnDialog } from './return-dialog';
import { useLendingHistory, useActiveLending, type LendingRecord } from '@/hooks/use-lending';

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function isOverdue(dueAt: string | null): boolean {
  if (!dueAt) return false;
  return new Date(dueAt).getTime() < Date.now();
}

interface LendingListProps {
  itemId: number;
  itemName: string;
}

export function LendingList({ itemId, itemName }: LendingListProps) {
  const { data: active, isLoading: loadingActive } = useActiveLending(itemId);
  const { data: history, isLoading: loadingHistory } = useLendingHistory(itemId);

  const [returnOpen, setReturnOpen] = React.useState(false);
  const [selectedLending, setSelectedLending] = React.useState<LendingRecord | null>(null);

  const isLoading = loadingActive || loadingHistory;

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  const pastLendings = (history ?? []).filter((l) => l.returnedAt != null);

  function openReturn(lending: LendingRecord) {
    setSelectedLending(lending);
    setReturnOpen(true);
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Active lending */}
      {active && (
        <div className="border border-[var(--color-border)] rounded-[var(--radius-md)] p-3 bg-[var(--color-elevated)]">
          <div className="flex items-start justify-between gap-2">
            <div className="flex flex-col gap-1 min-w-0">
              <p className="text-sm font-medium text-[var(--color-text)]">
                Lent to <span className="font-semibold">{active.lentTo}</span>
              </p>
              <p className="text-xs text-[var(--color-text-muted)]">
                Since {formatDate(active.lentAt)}
              </p>
              {active.dueAt && (
                <div className="flex items-center gap-1.5">
                  <p className="text-xs text-[var(--color-text-muted)]">
                    Due {formatDate(active.dueAt)}
                  </p>
                  {isOverdue(active.dueAt) && (
                    <Badge variant="danger">Overdue</Badge>
                  )}
                </div>
              )}
              {active.notes && (
                <p className="text-xs text-[var(--color-text-secondary)] mt-1">{active.notes}</p>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => openReturn(active)}
              className="shrink-0"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Return
            </Button>
          </div>
        </div>
      )}

      {/* History */}
      {pastLendings.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
            History
          </p>
          {pastLendings.map((lending) => (
            <div
              key={lending.id}
              className="flex items-center justify-between text-xs border-b border-[var(--color-border)] pb-2 last:border-0"
            >
              <div className="flex flex-col gap-0.5 min-w-0">
                <p className="text-[var(--color-text)]">
                  {lending.lentTo}
                </p>
                <p className="text-[var(--color-text-muted)]">
                  {formatDate(lending.lentAt)} - {lending.returnedAt ? formatDate(lending.returnedAt) : ''}
                </p>
              </div>
              <Badge variant="success">Returned</Badge>
            </div>
          ))}
        </div>
      )}

      {!active && pastLendings.length === 0 && (
        <p className="text-xs text-[var(--color-text-muted)] py-1">No lending history.</p>
      )}

      {/* Return dialog */}
      {selectedLending && (
        <ReturnDialog
          lendingId={selectedLending.id}
          itemId={itemId}
          itemName={itemName}
          lentTo={selectedLending.lentTo}
          isOpen={returnOpen}
          onOpenChange={setReturnOpen}
        />
      )}
    </div>
  );
}

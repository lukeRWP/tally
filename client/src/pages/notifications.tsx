import { CornerDownLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { toast } from '@/components/ui/toast';
import { NotificationList } from '@/components/notifications/notification-list';
import { useActiveLoans, useReturnItem } from '@/hooks/use-lending';
import { daysOverdue, formatDueDate } from '@/lib/dates';

/**
 * The alerts hub. "On loan" leads: getting things back is the actionable job
 * this page exists for, and until now the only cross-house view of loans was
 * a generated PDF — the overdue endpoint existed and no screen consumed it.
 */
function OnLoanSection() {
  const navigate = useNavigate();
  const { data: loans } = useActiveLoans();
  const returnItem = useReturnItem();

  if (!loans || loans.length === 0) return null;

  return (
    <Card className="p-4 max-w-2xl mx-auto w-full">
      <h2 className="text-sm font-semibold text-[var(--color-text)] mb-3">
        On loan ({loans.length})
      </h2>
      <div className="flex flex-col">
        {loans.map((loan) => {
          const overdueDays = loan.dueAt ? daysOverdue(loan.dueAt) : null;
          const isOverdue = overdueDays !== null && overdueDays > 0;
          return (
            <div
              key={loan.id}
              className="flex items-center gap-3 py-2.5 border-b border-[var(--color-border)] last:border-b-0"
            >
              <button
                type="button"
                onClick={() => navigate(`/item/${loan.itemId}`)}
                className="flex-1 min-w-0 text-left"
              >
                <p className="text-sm font-medium text-[var(--color-text)] truncate">
                  {loan.itemName ?? `Item #${loan.itemId}`}
                </p>
                <p className="text-xs text-[var(--color-text-muted)]">
                  {loan.lentTo}
                  {loan.dueAt && (
                    <>
                      {' · '}
                      {isOverdue ? (
                        <span className="text-[var(--color-red)] font-medium">
                          {overdueDays} day{overdueDays === 1 ? '' : 's'} overdue
                        </span>
                      ) : (
                        <>due {formatDueDate(loan.dueAt)}</>
                      )}
                    </>
                  )}
                </p>
              </button>
              <Button
                variant="outline"
                size="sm"
                disabled={returnItem.isPending}
                onClick={() =>
                  returnItem.mutate(
                    { lendingId: loan.id, itemId: loan.itemId },
                    {
                      onSuccess: () => toast(`${loan.itemName ?? 'Item'} returned`),
                      onError: (e) =>
                        toast(e instanceof Error ? e.message : 'Could not mark it returned'),
                    },
                  )
                }
              >
                <CornerDownLeft className="w-3.5 h-3.5" />
                Return
              </Button>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

export function NotificationListPage() {
  return (
    <div className="flex flex-col gap-4 p-4">
      <OnLoanSection />
      <NotificationList />
    </div>
  );
}

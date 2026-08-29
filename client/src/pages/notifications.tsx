import { CornerDownLeft } from 'lucide-react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { ColHead } from '@/components/ui/col-head';
import { RuledRow } from '@/components/ui/ruled-row';
import { toast } from '@/components/ui/toast';
import { NotificationList } from '@/components/notifications/notification-list';
import { RecentActivity } from '@/components/activity/recent-activity';
import { TitleBar } from '@/components/ui/title-bar';
import { useActiveLoans, useReturnItem } from '@/hooks/use-lending';
import { useMatches } from '@/hooks/use-matches';
import { useProperties } from '@/hooks/use-inventory';
import { daysOverdue, formatDueDate } from '@/lib/dates';

// Renders nothing at all when nothing is out, so a house that lends nothing
// never pays a header for it.
function OnLoanSection() {
  const navigate = useNavigate();
  const { data: loans } = useActiveLoans();
  const returnItem = useReturnItem();

  if (!loans || loans.length === 0) return null;

  return (
    <div className="max-w-2xl mx-auto w-full flex flex-col">
      <ColHead>On loan · {loans.length}</ColHead>
      {loans.map((loan) => {
        const overdueDays = loan.dueAt ? daysOverdue(loan.dueAt) : null;
        const isOverdue = overdueDays !== null && overdueDays > 0;
        return (
          <div
            key={loan.id}
            className="flex items-center gap-3 py-3 border-b border-[var(--color-rule)]"
          >
            <button
              type="button"
              onClick={() => navigate(`/item/${loan.itemId}`)}
              className="flex-1 min-w-0 text-left"
            >
              <p className="text-sm font-semibold text-[var(--color-text)] truncate">
                {loan.itemName ?? `Item #${loan.itemId}`}
              </p>
              <p className="font-mono text-[11px] text-[var(--color-text-muted)] mt-0.5">
                {loan.lentTo}
                {loan.dueAt && (
                  <>
                    {' · '}
                    {isOverdue ? (
                      <span className="text-[var(--color-red)] font-semibold uppercase">
                        {overdueDays}d overdue
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
  );
}

/**
 * The photo-match worklist, surfaced here because a capture that skipped the
 * barcode step (see the header comment on capture.tsx) needs a way back to
 * being finished. Counts only rows a person can actually act on — `ready`,
 * `none` and `failed` — never `queued`/`searching`, which are still working
 * in the background and would advertise work that is not there yet.
 *
 * Renders nothing when there is nothing to act on, same as OnLoanSection.
 */
function PendingMatchesSection() {
  const navigate = useNavigate();
  const { data: properties } = useProperties();
  const propertyId = properties?.[0]?.id;
  const { data: matches } = useMatches(propertyId);
  const pendingMatches = (matches ?? []).filter(
    (m) => m.status === 'ready' || m.status === 'none' || m.status === 'failed',
  ).length;

  if (pendingMatches === 0) return null;

  return (
    <div className="max-w-2xl mx-auto w-full flex flex-col">
      <RuledRow
        title={`${pendingMatches} item${pendingMatches === 1 ? '' : 's'} need a product`}
        meta="Pick from photo matches"
        onNavigate={() => navigate('/matches')}
      />
    </div>
  );
}

/**
 * Everything that happened without you: what is still out on loan, what the app
 * wants to tell you, and the raw change log underneath both. Ordered by how
 * actionable it is, so on loan leads — getting things back is the one job here
 * that needs a person to do something. The photo-match worklist follows, for
 * the same reason. Notifications need reading, activity only needs scanning.
 *
 * This is also the only cross-house view of loans outside a generated report,
 * which is why the overdue endpoint feeds a screen and not just a PDF.
 */
export function NotificationListPage() {
  return (
    // No padding of its own: `main` owns the gutter and the scroll.
    <div className="flex flex-col gap-4">
      <h1 className="max-w-2xl mx-auto w-full"><TitleBar>Alerts</TitleBar></h1>
      <OnLoanSection />
      <PendingMatchesSection />
      <NotificationList />
      <RecentActivity />
    </div>
  );
}

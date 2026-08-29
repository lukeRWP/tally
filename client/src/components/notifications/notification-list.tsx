import { useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Clock,
  HandCoins,
  ArrowRight,
  Trash2,
  Link,
  X,
  BellOff,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  useNotifications,
  useMarkRead,
  useMarkAllRead,
  useDismissNotification,
  type Notification,
} from '@/hooks/use-notifications';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = Math.floor((now - then) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function notificationIcon(type: string) {
  switch (type) {
    case 'warranty_expiry':
    case 'custom_date':
      return <Clock className="w-4 h-4" />;
    case 'lending_due':
      return <HandCoins className="w-4 h-4" />;
    case 'item_moved':
      return <ArrowRight className="w-4 h-4" />;
    case 'item_removed':
      return <Trash2 className="w-4 h-4" />;
    case 'share_expiring':
      return <Link className="w-4 h-4" />;
    default:
      return <Clock className="w-4 h-4" />;
  }
}

function entityPath(notification: Notification): string {
  const { entityType, entityId, itemId } = notification;
  switch (entityType) {
    case 'item':
      return `/item/${entityId}`;
    case 'container':
      return `/container/${entityId}`;
    case 'area':
      return `/area/${entityId}`;
    case 'property':
      return `/property/${entityId}`;
    case 'item_date':
    case 'item_lending':
      // entityId is the source date/lending row (kept for server dedup); the
      // server projects the owning item as itemId at read time. Absent
      // (deleted source row, old API) → fall back to Home like unknown types.
      return itemId ? `/item/${itemId}` : '/';
    default:
      return '/';
  }
}

function NotificationRow({
  notification,
  dismissRunning,
}: {
  notification: Notification;
  /** True while runDismissAll's loop is in flight (#239) — the per-row X
   * uses the same single-dismiss endpoint the loop drives sequentially, so
   * racing it against an in-flight bulk dismiss would double-count the
   * outcome: a click here can "succeed" on a row the loop is about to reach
   * anyway, or land a 404 on one it already dismissed, either way inflating
   * the loop's own failed count for no real reason. */
  dismissRunning?: boolean;
}) {
  const navigate = useNavigate();
  const markRead = useMarkRead();
  const dismiss = useDismissNotification();
  const isUnread = notification.readAt === null;

  function handleClick() {
    if (isUnread) {
      markRead.mutate(notification.id);
    }
    if (notification.entityType && notification.entityId) {
      // {state:{from:'alerts'}} is read by the shared Breadcrumbs component
      // on whichever detail page this lands on, so acting there renders a
      // way back to this list instead of stranding the user.
      navigate(entityPath(notification), { state: { from: 'alerts' } });
    }
  }

  return (
    <div
      className={cn(
        'flex items-start gap-3 p-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] transition-colors',
        isUnread ? 'bg-[var(--color-primary-bg)]' : 'bg-[var(--color-card)]',
        (notification.entityType && notification.entityId) ? 'cursor-pointer hover:bg-[var(--color-elevated)]' : '',
      )}
      onClick={handleClick}
      role={notification.entityType && notification.entityId ? 'button' : undefined}
      tabIndex={notification.entityType && notification.entityId ? 0 : undefined}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') handleClick();
      }}
    >
      {/* Unread dot */}
      <div className="mt-0.5 flex-shrink-0">
        {isUnread ? (
          <span className="block w-2 h-2 rounded-full bg-[var(--color-primary)]" />
        ) : (
          <span className="block w-2 h-2" />
        )}
      </div>

      {/* Icon */}
      <div className="flex-shrink-0 mt-0.5 text-[var(--color-text-secondary)]">
        {notificationIcon(notification.type)}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className={cn('text-sm', isUnread ? 'font-semibold text-[var(--color-text)]' : 'font-medium text-[var(--color-text)]')}>
          {notification.title}
        </p>
        <p className="text-xs text-[var(--color-text-secondary)] mt-0.5 line-clamp-2">
          {notification.message}
        </p>
        <p className="text-[10px] text-[var(--color-text-muted)] mt-1">
          {relativeTime(notification.createdAt)}
        </p>
      </div>

      {/* Dismiss */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (dismissRunning) return;
          dismiss.mutate(notification.id);
        }}
        disabled={dismissRunning}
        className="flex-shrink-0 p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-elevated)] transition-colors disabled:opacity-40 disabled:pointer-events-none"
        aria-label="Dismiss notification"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

export function NotificationList() {
  const { data: notifications, isLoading } = useNotifications();
  const markAllRead = useMarkAllRead();
  const dismiss = useDismissNotification();
  const [dismissProgress, setDismissProgress] = useState<{ i: number; total: number } | null>(null);
  const items = notifications ?? [];
  const hasUnread = items.some((n) => n.readAt === null);

  /**
   * There is no bulk-dismiss endpoint — this loops the same single-dismiss
   * DELETE the row's own X button uses, sequentially and continue-on-failure,
   * per the wave's bulk-loop discipline (see container-detail.tsx runBulkDelete).
   */
  async function runDismissAll() {
    const targets = [...items];
    if (targets.length === 0) return;

    let ok = 0;
    let failed = 0;
    for (let idx = 0; idx < targets.length; idx++) {
      setDismissProgress({ i: idx + 1, total: targets.length });
      try {
        await dismiss.mutateAsync(targets[idx].id);
        ok += 1;
      } catch {
        failed += 1;
      }
    }

    setDismissProgress(null);
    toast(failed ? `Dismissed ${ok} · ${failed} failed` : `Dismissed ${ok}`);
  }

  const dismissRunning = !!dismissProgress;

  return (
    <div className="flex flex-col gap-3 max-w-2xl mx-auto">
      {/* Header row */}
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-bold text-[var(--color-text)]">Notifications</h2>
        <div className="flex items-center gap-2">
          {hasUnread && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => markAllRead.mutate()}
              disabled={markAllRead.isPending || dismissRunning}
            >
              Mark all read
            </Button>
          )}
          {(items.length > 0 || dismissRunning) && (
            <Button
              variant="outline"
              size="sm"
              onClick={runDismissAll}
              disabled={dismissRunning}
            >
              {dismissProgress ? `Dismissing… ${dismissProgress.i} of ${dismissProgress.total}` : `Dismiss ${items.length}`}
            </Button>
          )}
        </div>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="flex flex-col gap-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 rounded-[var(--radius-lg)] bg-[var(--color-elevated)] animate-pulse" />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!isLoading && items.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-12 text-[var(--color-text-muted)]">
          <BellOff className="w-8 h-8" />
          <p className="text-sm">No notifications</p>
        </div>
      )}

      {/* List */}
      {!isLoading && items.length > 0 && (
        <div className="flex flex-col gap-2">
          {items.map((n) => (
            <NotificationRow key={n.id} notification={n} dismissRunning={dismissRunning} />
          ))}
        </div>
      )}
    </div>
  );
}

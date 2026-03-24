import { useNavigate } from 'react-router-dom';
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

function entityPath(entityType: string, entityId: number): string {
  switch (entityType) {
    case 'item':
      return `/item/${entityId}`;
    case 'container':
      return `/container/${entityId}`;
    case 'area':
      return `/area/${entityId}`;
    case 'property':
      return `/property/${entityId}`;
    default:
      return '/';
  }
}

function NotificationRow({ notification }: { notification: Notification }) {
  const navigate = useNavigate();
  const markRead = useMarkRead();
  const dismiss = useDismissNotification();
  const isUnread = notification.readAt === null;

  function handleClick() {
    if (isUnread) {
      markRead.mutate(notification.id);
    }
    if (notification.entityType && notification.entityId) {
      navigate(entityPath(notification.entityType, notification.entityId));
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
          dismiss.mutate(notification.id);
        }}
        className="flex-shrink-0 p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-elevated)] transition-colors"
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
  const items = notifications ?? [];
  const hasUnread = items.some((n) => n.readAt === null);

  return (
    <div className="flex flex-col gap-3">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-[var(--color-text)]">Notifications</h2>
        {hasUnread && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => markAllRead.mutate()}
            disabled={markAllRead.isPending}
          >
            Mark all read
          </Button>
        )}
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
            <NotificationRow key={n.id} notification={n} />
          ))}
        </div>
      )}
    </div>
  );
}

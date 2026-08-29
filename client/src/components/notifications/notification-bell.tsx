import { Bell } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useUnreadCount } from '@/hooks/use-notifications';

export function NotificationBell() {
  const navigate = useNavigate();
  const { data: count } = useUnreadCount();
  const unread = typeof count === 'number' ? count : 0;

  return (
    <button
      type="button"
      className="relative p-2"
      onClick={() => navigate('/notifications')}
      aria-label={unread > 0 ? `${unread} unread notifications` : 'Notifications'}
    >
      <Bell className="w-5 h-5 text-[var(--color-text-secondary)]" />
      {unread > 0 && (
        <span className="absolute top-1 right-1 min-w-[16px] h-4 px-0.5 rounded-full bg-[var(--color-red)] text-white text-[10px] font-bold flex items-center justify-center leading-none">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </button>
  );
}

import { useEffect, useRef } from 'react';
import { Outlet, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Home, Layers, ScanLine, BarChart2, Bell, Settings, Printer } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useAuthStore } from '@/store/auth-store';
import { useUnreadCount } from '@/hooks/use-notifications';
import { Header } from './header';
import { BottomNav } from './bottom-nav';
import { cn } from '@/lib/utils';

const navItems = [
  { path: '/', icon: Home, label: 'Home' },
  { path: '/inventory', icon: Layers, label: 'Inventory' },
  { path: '/scan', icon: ScanLine, label: 'Scan' },
  { path: '/print', icon: Printer, label: 'Print' },
  { path: '/reports', icon: BarChart2, label: 'Reports' },
  { path: '/notifications', icon: Bell, label: 'Notifications' },
  { path: '/settings', icon: Settings, label: 'Settings' },
];

function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const { data: unreadCount } = useUnreadCount();
  const unread = typeof unreadCount === 'number' ? unreadCount : 0;

  return (
    <aside className="hidden lg:flex lg:flex-col lg:w-56 lg:fixed lg:inset-y-0 bg-[var(--color-card)] border-r border-[var(--color-border)] z-50">
      {/* Logo */}
      <div className="px-5 py-4 border-b border-[var(--color-border)]">
        <h1 className="text-xl font-extrabold tracking-tighter text-[var(--color-text)]">Tally</h1>
      </div>

      {/* Nav items */}
      <nav className="flex-1 px-3 py-4 space-y-1">
        {navItems.map((item) => {
          const isActive = location.pathname === item.path;
          const Icon = item.icon;
          const isScan = item.path === '/scan';

          if (isScan) {
            return (
              <button
                key={item.path}
                onClick={() => navigate(item.path)}
                className="flex items-center gap-3 w-full px-3 py-2.5 rounded-[var(--radius-lg)] text-sm font-semibold bg-[var(--color-primary)] text-white shadow-md hover:opacity-90 transition-all duration-200 mt-2 mb-2"
              >
                <Icon className="w-5 h-5" />
                {item.label}
              </button>
            );
          }

          return (
            <button
              key={item.path}
              onClick={() => navigate(item.path)}
              className={cn(
                'flex items-center gap-3 w-full px-3 py-2.5 rounded-[var(--radius-md)] text-sm font-medium transition-all duration-200',
                isActive
                  ? 'bg-[var(--color-primary-bg)] text-[var(--color-primary)] border-l-2 border-[var(--color-primary)]'
                  : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-elevated)] hover:text-[var(--color-text)]',
              )}
            >
              <Icon className={cn('w-5 h-5 shrink-0', isActive ? 'text-[var(--color-primary)]' : '')} />
              <span className="flex-1 text-left">{item.label}</span>
              {item.path === '/notifications' && unread > 0 && (
                <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-[var(--color-red)] text-white text-[10px] font-bold flex items-center justify-center leading-none">
                  {unread > 99 ? '99+' : unread}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* User info */}
      {user && (
        <div className="px-4 py-3 border-t border-[var(--color-border)] flex items-center gap-3">
          {user.avatarUrl ? (
            <img
              src={user.avatarUrl}
              alt={user.displayName}
              className="w-8 h-8 rounded-full object-cover ring-1 ring-[var(--color-border)]"
            />
          ) : (
            <div className="w-8 h-8 rounded-full bg-[var(--color-primary-bg)] flex items-center justify-center text-xs font-bold text-[var(--color-primary)]">
              {user.displayName.charAt(0).toUpperCase()}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-[var(--color-text)] truncate">{user.displayName}</p>
            <p className="text-xs text-[var(--color-text-muted)] truncate">{user.email}</p>
          </div>
        </div>
      )}
    </aside>
  );
}

export function RootLayout() {
  const { user, isLoading } = useAuth();
  const mainRef = useRef<HTMLElement>(null);
  const { pathname } = useLocation();

  // Scroll to top on route change
  useEffect(() => {
    mainRef.current?.scrollTo(0, 0);
  }, [pathname]);

  if (isLoading) {
    return <div className="flex items-center justify-center h-screen">
      <div className="text-[var(--color-text-muted)]">Loading...</div>
    </div>;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="flex h-screen bg-[var(--color-bg)] overflow-x-hidden">
      {/* Desktop sidebar */}
      <Sidebar />

      {/* Main content area */}
      <div className="flex-1 flex flex-col lg:ml-56 overflow-x-hidden">
        {/* Header - mobile/tablet only */}
        <div className="lg:hidden pt-[env(safe-area-inset-top)]">
          <Header />
        </div>
        <main ref={mainRef} className="flex-1 overflow-y-auto overflow-x-hidden pb-[calc(5rem+env(safe-area-inset-bottom))] lg:pb-6 px-4 pt-4">
          <div className="md:max-w-[640px] lg:max-w-[800px] mx-auto">
            <Outlet />
          </div>
        </main>
        {/* Bottom nav - mobile/tablet only */}
        <div className="lg:hidden">
          <BottomNav />
        </div>
      </div>
    </div>
  );
}

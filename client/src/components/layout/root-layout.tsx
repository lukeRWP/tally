import { useEffect, useRef } from 'react';
import { Outlet, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Home, Search, Bell, Settings, Printer, DoorOpen, BarChart2 } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useAuthStore } from '@/store/auth-store';
import { useUnreadCount } from '@/hooks/use-notifications';
import { Header } from './header';
import { BottomNav, isNavActive } from './bottom-nav';
import { CarryBanner } from '@/components/inventory/carry-banner';
import { cn } from '@/lib/utils';
import { useCarryStore } from '@/store/carry-store';

// Mirrors the bottom nav's destinations in the same order, plus Search at the
// top: one information architecture expressed on both surfaces, so desktop and
// mobile are the same app rather than two that resemble each other. A desk has
// room for the query page the phone reaches from its header, and ADD gets no
// row: the raised disc is a thumb affordance, and a pointer creates from the
// page it is already looking at.
const navItems = [
  { path: '/search', icon: Search, label: 'Search' },
  { path: '/', icon: Home, label: 'Home' },
  { path: '/print', icon: Printer, label: 'Print' },
  { path: '/areas', icon: DoorOpen, label: 'Areas' },
  { path: '/reports', icon: BarChart2, label: 'Reports' },
  { path: '/notifications', icon: Bell, label: 'Alerts' },
  { path: '/settings', icon: Settings, label: 'Settings' },
];

function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const { data: unreadCount } = useUnreadCount();
  const unread = typeof unreadCount === 'number' ? unreadCount : 0;

  return (
    <aside className="hidden xl:flex xl:flex-col xl:w-56 xl:fixed xl:inset-y-0 bg-[var(--color-bg)] border-r-2 border-[var(--color-text)] z-50">
      {/* Logo */}
      <div className="px-5 py-4 border-b-2 border-[var(--color-text)] flex items-center gap-2">
        {/* Same ink chip + mono wordmark as the mobile header — the desktop
            sidebar was missed in the chrome pass and still read as a normal app. */}
        <span className="w-4 h-4 rounded-[2px] bg-[var(--color-primary)] shrink-0" aria-hidden="true" />
        <h1 className="font-mono text-sm font-extrabold uppercase tracking-[0.22em] text-[var(--color-text)]">Tally</h1>
      </div>

      {/* Nav items */}
      <nav className="flex-1 px-3 py-4 space-y-1">
        {navItems.map((item) => {
          const isActive = isNavActive(item.path, location.pathname);
          const Icon = item.icon;

          return (
            <button
              key={item.path}
              onClick={() => navigate(item.path)}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'flex items-center gap-3 w-full px-3 py-2.5 rounded-[var(--radius-sm)] font-mono text-xs font-bold uppercase tracking-[0.08em] transition-colors duration-150',
                isActive
                  ? 'bg-[var(--color-text)] text-[var(--color-bg)]'
                  : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-elevated)] hover:text-[var(--color-text)]',
              )}
            >
              <Icon className="w-5 h-5 shrink-0" />
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
        <div className="px-4 py-3 border-t border-[var(--color-rule)] flex items-center gap-3">
          {user.avatarUrl ? (
            <img
              src={user.avatarUrl}
              alt={user.displayName}
              className="w-8 h-8 rounded-[var(--radius-sm)] object-cover border border-[var(--color-rule)]"
            />
          ) : (
            <div className="w-8 h-8 rounded-[var(--radius-sm)] border border-[var(--color-text)] flex items-center justify-center font-mono text-xs font-bold text-[var(--color-text)]">
              {user.displayName.charAt(0).toUpperCase()}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-[var(--color-text)] truncate">{user.displayName}</p>
            <p className="font-mono text-[10px] text-[var(--color-text-muted)] truncate">{user.email}</p>
          </div>
        </div>
      )}
    </aside>
  );
}

/**
 * Three experiences, not two:
 *   phone  (<md)       bottom nav, Scan in the thumb slot
 *   tablet (md..<xl)   same touch chrome — a tablet has a camera and gets
 *                      carried to the shelf, so it keeps Scan; only the
 *                      content column widens. iPad landscape (1024) lives
 *                      HERE, which is why the sidebar starts at xl, not lg.
 *   desktop(>=xl)      sidebar; Scan is dropped (no usable camera at a desk)
 */
export function RootLayout() {
  const { user, isLoading } = useAuth();
  const mainRef = useRef<HTMLElement>(null);
  const { pathname } = useLocation();

  // The banner is `fixed`, so it occludes the last row of every page it shows
  // on. Reserve for it here rather than deleting the banner on the one page
  // where that hurt most. /move renders the scanner but never the banner, so
  // it must not pay.
  const carrying = useCarryStore(
    (s) => (s.carried.length > 0 || s.lastMove !== null) && pathname !== '/move',
  );
  // The three camera flows are sized to the viewport instead of scrolling:
  // the frame is a flex item that absorbs the leftover height.
  const fitsViewport = pathname === '/capture' || pathname === '/scan' || pathname === '/move';

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
    <div className="flex h-[100dvh] bg-[var(--color-bg)] overflow-x-hidden">
      {/* Desktop sidebar */}
      <Sidebar />

      {/* Main content area */}
      <div className="flex-1 flex flex-col xl:ml-56 overflow-x-hidden">
        {/* Header - mobile/tablet only */}
        <div className="xl:hidden pt-[env(safe-area-inset-top)]">
          <Header />
        </div>
        <main
          ref={mainRef}
          className={cn(
            'flex-1 overflow-y-auto overflow-x-hidden px-4 pt-4 xl:pb-6',
            carrying
              ? 'pb-[calc(9.5rem+env(safe-area-inset-bottom))]'
              : 'pb-[calc(5rem+env(safe-area-inset-bottom))]',
          )}
        >
          <div className={cn(
            'md:max-w-[720px] lg:max-w-[860px] xl:max-w-[800px] mx-auto',
            fitsViewport && 'h-full',
          )}>
            <Outlet />
          </div>
        </main>
        {/* Carrying something? The banner follows you across every screen, so
            you can browse to a destination instead of scanning if you prefer. */}
        <CarryBanner />
        {/* Bottom nav - mobile/tablet only */}
        <div className="xl:hidden">
          <BottomNav />
        </div>
      </div>
    </div>
  );
}

import { useEffect, useRef } from 'react';
import { Outlet, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Home, Search, Bell, Settings, Printer, DoorOpen, BarChart2, Plus, ScanLine } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useAuthStore } from '@/store/auth-store';
import { useUnreadCount } from '@/hooks/use-notifications';
import { Header } from './header';
import { BottomNav, isNavActive } from './bottom-nav';
import { CarryBanner } from '@/components/inventory/carry-banner';
import { cn } from '@/lib/utils';
import { buildCaptureUrl } from '@/lib/capture-url';
import { useCarryStore } from '@/store/carry-store';
import { useLayoutMode } from '@/hooks/use-layout-mode';

// Mirrors the bottom nav's destinations in the same order, plus Search at the
// top: one information architecture expressed on both surfaces, so desktop and
// mobile are the same app rather than two that resemble each other. A desk has
// room for the query page the phone reaches from its header, and ADD gets no
// row: the raised disc is a thumb affordance, and a pointer creates from the
// page it is already looking at.
//
// AMENDED 2026-08-15. The reasoning above holds for a pointer at a desk, and
// that was the only thing this sidebar saw when it was written. It now also
// serves iPad LANDSCAPE — a touch device with a camera and no bottom nav to
// reach Scan from — so Scan returns as a row and Add takes the primary slot
// above the nav. See use-layout-mode.ts for why the switch is orientation-aware
// rather than a wider breakpoint, which would have caught iPad portrait too.
const navItems = [
  { path: '/search', icon: Search, label: 'Search' },
  { path: '/', icon: Home, label: 'Home' },
  { path: '/print', icon: Printer, label: 'Print' },
  { path: '/areas', icon: DoorOpen, label: 'Areas' },
  { path: '/scan', icon: ScanLine, label: 'Scan' },
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
    <aside className="flex flex-col w-56 fixed inset-y-0 bg-[var(--color-bg)] border-r-2 border-[var(--color-text)] z-50">
      {/* Logo */}
      <div className="px-5 py-4 border-b-2 border-[var(--color-text)] flex items-center gap-2">
        {/* Same ink chip + mono wordmark as the mobile header — the desktop
            sidebar was missed in the chrome pass and still read as a normal app. */}
        <span className="w-4 h-4 rounded-[2px] bg-[var(--color-primary)] shrink-0" aria-hidden="true" />
        <h1 className="font-mono text-sm font-extrabold uppercase tracking-[0.22em] text-[var(--color-text)]">Tally</h1>
      </div>

      {/* Create — the primary action, not a destination, so it sits above the
          nav rather than in it. Shares buildCaptureUrl with the phone's centre
          button so the bin you are standing in still pre-pins as the
          destination; two copies of that rule would drift. */}
      <div className="px-3 pt-4">
        <button
          onClick={() => navigate(buildCaptureUrl(location.pathname))}
          className="w-full flex items-center gap-2 px-3 py-2.5 rounded-[var(--radius-sm)] bg-[var(--color-primary)] text-white font-mono text-xs font-bold uppercase tracking-[0.12em] hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[var(--color-text)] focus:ring-offset-2"
        >
          <Plus className="w-4 h-4 shrink-0" />
          <span>Add</span>
        </button>
      </div>

      {/* Nav items */}
      <nav className="flex-1 px-3 pt-3 pb-4 space-y-1">
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
 * Two chromes, chosen by how the device is being HELD rather than by width
 * alone (see use-layout-mode.ts):
 *
 *   touch    phone at any orientation, and any tablet in PORTRAIT — the
 *            carried-to-the-shelf case. Bottom nav, Scan in the thumb slot.
 *   sidebar  >=1024 AND landscape — iPad propped on a bench, and every desk.
 *            Fixed rail with Add and Scan; no bottom nav.
 *
 * This replaces a pure width rule (sidebar at >=1280) whose own comment noted
 * that it kept iPad landscape on phone chrome deliberately. That was right
 * about WHY tablets need Scan and wrong about which axis decides: an iPad in
 * landscape spent 18% of its scarce vertical on a header and a bottom bar.
 * Widening the rule to 1024 would have caught iPad portrait, which really is
 * the carried case — hence orientation, not a bigger number.
 *
 * Exactly one nav renders. Rendering both and hiding one with a breakpoint
 * leaves a second set of nav controls in the accessibility tree.
 */
export function RootLayout() {
  const { user, isLoading } = useAuth();
  const layout = useLayoutMode();
  const sidebar = layout === 'sidebar';
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
      {sidebar && <Sidebar />}

      {/* Main content area */}
      <div className={cn('flex-1 flex flex-col overflow-x-hidden', sidebar && 'ml-56')}>
        {!sidebar && (
          <div className="pt-[env(safe-area-inset-top)]">
            <Header />
          </div>
        )}
        <main
          ref={mainRef}
          className={cn(
            'flex-1 overflow-y-auto overflow-x-hidden px-4 pt-4',
            // With no bottom nav there is nothing to clear, so the reserved
            // space becomes ordinary padding instead of a phone-sized gutter.
            sidebar
              ? (carrying ? 'pb-28' : 'pb-6')
              : (carrying
                  ? 'pb-[calc(9.5rem+env(safe-area-inset-bottom))]'
                  : 'pb-[calc(5rem+env(safe-area-inset-bottom))]'),
          )}
        >
          <div className={cn(
            // Each step stays just under the space actually available, so the
            // column grows with the screen. The old ladder NARROWED at the
            // widest breakpoint — 860px at lg, 800px at xl — so a 1920px
            // monitor showed an 800px column stranded in ~450px of dead space
            // on each side, visually detached from the rail beside it.
            'md:max-w-[720px] lg:max-w-[900px] xl:max-w-[1100px] 2xl:max-w-[1400px] mx-auto',
            fitsViewport && 'h-full',
          )}>
            <Outlet />
          </div>
        </main>
        {/* Carrying something? The banner follows you across every screen, so
            you can browse to a destination instead of scanning if you prefer. */}
        <CarryBanner />
        {!sidebar && <BottomNav />}
      </div>
    </div>
  );
}

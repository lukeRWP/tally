import { useLocation, useNavigate } from 'react-router-dom';
import { Home, Plus, Bell, Settings, Printer } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useUnreadCount } from '@/hooks/use-notifications';

// Five tabs, chosen by frequency-of-use, not feature inventory:
// - Inventory is gone — it was a strict subset of Home (the same property grid
//   plus a Create button) and never reached deeper than the property tier.
// - Reports is gone — a few-times-a-year export doesn't earn a thumb slot; it
//   now lives in Settings.
// - Notifications arrives: overdue loans and warranty dates are daily-attention
//   surfaces that were previously mobile-reachable only via the small header bell.
//
// The centre slot is ADD, not Scan. The thumb button should be the thing you do
// most, and in a house that is "put this object into the system" — scanning is a
// step inside that, not a destination of its own. Scanning to LOOK something up
// keeps its own affordance in the header, so the gesture did not go away.
const tabs = [
  { path: '/', icon: Home, label: 'Home' },
  { path: '/print', icon: Printer, label: 'Print' },
  { path: '/capture', icon: Plus, label: 'Add', center: true },
  { path: '/notifications', icon: Bell, label: 'Alerts', badge: true },
  { path: '/settings', icon: Settings, label: 'Settings' },
];

/**
 * Where you are standing is almost always where the new thing goes, so the
 * centre button carries the current page into the create flow: a container
 * pre-pins as the destination, an area pre-selects the picker's area so the
 * bin list is one tap away. Standing nowhere in particular just opens the flow.
 */
function buildCaptureUrl(pathname: string): string {
  const container = pathname.match(/^\/container\/(\d+)/);
  if (container) return `/capture?containerId=${container[1]}`;

  const area = pathname.match(/^\/area\/(\d+)/);
  if (area) return `/capture?areaId=${area[1]}`;

  const property = pathname.match(/^\/property\/(\d+)/);
  if (property) return `/capture?propertyId=${property[1]}`;

  return '/capture';
}

export function BottomNav() {
  const location = useLocation();
  const navigate = useNavigate();
  const { data: unreadCount } = useUnreadCount();
  const unread = typeof unreadCount === 'number' ? unreadCount : 0;

  return (
    <nav className="fixed bottom-0 left-0 right-0 bg-[var(--color-bg)] border-t-2 border-[var(--color-text)] z-50 pb-[env(safe-area-inset-bottom)]">
      <div className="flex items-center justify-around py-1 md:py-2 max-w-lg mx-auto">
        {tabs.map((tab) => {
          const isActive = location.pathname === tab.path ||
            (tab.path === '/capture' && location.pathname.startsWith('/capture')) ||
            // Detail pages highlight Home now that the Inventory tab is gone —
            // Home is where browsing starts.
            (tab.path === '/' && /^\/(property|area|container|item)\//.test(location.pathname));
          const Icon = tab.icon;

          if (tab.center) {
            const captureUrl = buildCaptureUrl(location.pathname);
            return (
              <button key={tab.path} onClick={() => navigate(captureUrl)}
                className="flex flex-col items-center -mt-5 transition-transform duration-200 active:scale-95 min-w-[44px]">
                <div className="w-13 h-13 rounded-full bg-[var(--color-primary)] flex items-center justify-center shadow-lg">
                  <Icon className="w-6 h-6 text-white" />
                </div>
                <span className="text-[9px] mt-1 font-mono font-bold uppercase tracking-[0.06em] text-[var(--color-text-muted)]">{tab.label}</span>
              </button>
            );
          }

          return (
            <button key={tab.path} onClick={() => navigate(tab.path)}
              className="flex flex-col items-center gap-0.5 py-2 px-3 min-w-[44px] min-h-[44px] relative transition-colors duration-200">
              {isActive && (
                <span className="absolute -top-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-[var(--color-primary)]" />
              )}
              <span className="relative">
                <Icon className={cn(
                  'w-5 h-5 transition-colors duration-200',
                  isActive ? 'text-[var(--color-primary)]' : 'text-[var(--color-text-muted)]',
                )} />
                {'badge' in tab && tab.badge && unread > 0 && (
                  <span className="absolute -top-1 -right-1.5 min-w-[14px] h-3.5 px-0.5 rounded-full bg-[var(--color-red)] text-white text-[9px] font-bold flex items-center justify-center leading-none">
                    {unread > 99 ? '99+' : unread}
                  </span>
                )}
              </span>
              <span className={cn(
                'text-[9px] font-mono uppercase tracking-[0.06em] font-bold transition-colors duration-200',
                isActive ? 'text-[var(--color-primary)]' : 'text-[var(--color-text-muted)]',
              )}>{tab.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

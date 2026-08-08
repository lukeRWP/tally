import { useLocation, useNavigate } from 'react-router-dom';
import { Home, Plus, Bell, Settings, Printer, DoorOpen, BarChart2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useUnreadCount } from '@/hooks/use-notifications';

// Seven slots, three either side of a raised centre, because that is the shape
// a thumb reads: a symmetric row with one unmissable middle. The two flanking
// ADD are the two halves of owning a pile of things — Areas is where the new
// object will go, Reports is what the pile turns out to be worth.
//
// Home is search plus the newest arrivals, so browsing by place needs a root of
// its own: Areas is the top of the property → area → container → item spine and
// the only screen that builds it.
//
// The centre slot is ADD, not Scan. The thumb button should be the thing you do
// most, and in a house that is "put this object into the system" — scanning is a
// step inside that, not a destination of its own. Scanning to LOOK something up
// keeps its own affordance in the header, so the gesture did not go away.
const tabs = [
  { path: '/', icon: Home, label: 'Home' },
  { path: '/print', icon: Printer, label: 'Print' },
  { path: '/areas', icon: DoorOpen, label: 'Areas' },
  { path: '/capture', icon: Plus, label: 'Add', center: true },
  { path: '/reports', icon: BarChart2, label: 'Reports' },
  { path: '/notifications', icon: Bell, label: 'Alerts', badge: true },
  { path: '/settings', icon: Settings, label: 'Settings' },
];

const PLACE_SPINE = /^\/(property|area|container|item)\//;

/**
 * Property → area → container → item is one browse spine and its root is Areas,
 * so every page on that spine lights the Areas tab. A pathname carries no record
 * of the route taken to it, so an item opened from Home's recent list lights
 * Areas too: the tab answers "where does this live in the app", not "where did I
 * come from". Home is search plus the newest arrivals — it owns one path and no
 * descendants.
 *
 * The recycle bin has no slot and is reached only from Settings, so Settings
 * keeps the light while you are in it.
 *
 * Shared with the desktop sidebar so the two surfaces cannot drift apart.
 */
export function isNavActive(tabPath: string, pathname: string): boolean {
  if (tabPath === '/areas') return pathname === '/areas' || PLACE_SPINE.test(pathname);
  if (tabPath === '/capture') return pathname.startsWith('/capture');
  if (tabPath === '/settings') return pathname === '/settings' || pathname === '/recycle-bin';
  return pathname === tabPath;
}

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
    <nav
      aria-label="Primary"
      className="fixed bottom-0 left-0 right-0 bg-[var(--color-bg)] border-t-2 border-[var(--color-text)] z-50 pb-[env(safe-area-inset-bottom)]"
    >
      {/* Six equal slots around a fixed centre rather than justify-around, which
          distributes by content width and so makes "Settings" a wider target
          than "Home" and pulls the row off its own midline. */}
      <div className="flex items-center py-1 md:py-2 max-w-lg mx-auto">
        {tabs.map((tab) => {
          const isActive = isNavActive(tab.path, location.pathname);
          const Icon = tab.icon;

          if (tab.center) {
            const captureUrl = buildCaptureUrl(location.pathname);
            return (
              <button key={tab.path} onClick={() => navigate(captureUrl)}
                aria-current={isActive ? 'page' : undefined}
                // Sized to the disc itself: a flexible slot squeezes under 52px
                // on every phone, and the disc then paints over — and steals
                // taps from — the tabs either side of it.
                className="flex flex-none w-13 flex-col items-center -mt-5 transition-transform duration-200 active:scale-95">
                <div className="w-13 h-13 rounded-full bg-[var(--color-primary)] flex items-center justify-center shadow-lg">
                  <Icon className="w-6 h-6 text-white" />
                </div>
                <span className="text-[8px] min-[360px]:text-[9px] mt-1 font-mono font-bold uppercase tracking-[0.06em] whitespace-nowrap text-[var(--color-text-muted)]">{tab.label}</span>
              </button>
            );
          }

          const isAlerts = 'badge' in tab && tab.badge;
          return (
            <button key={tab.path} onClick={() => navigate(tab.path)}
              aria-current={isActive ? 'page' : undefined}
              aria-label={isAlerts && unread > 0 ? `${tab.label}, ${unread} unread` : undefined}
              // min-w-0, not a 44px floor: at 320 the slot computes to 44.67px
              // so the floor never bites, and under 316 a floor would push the
              // last tab past the shell's overflow-x-hidden edge instead of
              // letting the row tighten. A cramped tab beats an amputated one.
              className="flex flex-1 basis-0 min-w-0 flex-col items-center gap-0.5 py-2 min-h-[44px] relative transition-colors duration-200">
              {isActive && (
                <span className="absolute -top-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-[var(--color-primary)]" />
              )}
              <span className="relative">
                <Icon className={cn(
                  'w-5 h-5 transition-colors duration-200',
                  isActive ? 'text-[var(--color-primary)]' : 'text-[var(--color-text-muted)]',
                )} />
                {isAlerts && unread > 0 && (
                  <span aria-hidden="true" className="absolute -top-1 -right-1.5 min-w-[14px] h-3.5 px-0.5 rounded-full bg-[var(--color-red)] text-white text-[9px] font-bold flex items-center justify-center leading-none">
                    {unread > 99 ? '99+' : unread}
                  </span>
                )}
              </span>
              <span className={cn(
                // 8px under 360: at 320 the slot is 44.67px and SETTINGS sets
                // 47.5px at 9px mono, which spills onto its neighbour.
                'text-[8px] min-[360px]:text-[9px] font-mono uppercase tracking-[0.06em] font-bold whitespace-nowrap transition-colors duration-200',
                isActive ? 'text-[var(--color-primary)]' : 'text-[var(--color-text-muted)]',
              )}>{tab.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { Home, Layers, ScanLine, BarChart2, Settings } from 'lucide-react';
import { cn } from '@/lib/utils';

const tabs = [
  { path: '/', icon: Home, label: 'Home' },
  { path: '/inventory', icon: Layers, label: 'Inventory' },
  { path: '/scan', icon: ScanLine, label: 'Scan', center: true },
  { path: '/reports', icon: BarChart2, label: 'Reports' },
  { path: '/settings', icon: Settings, label: 'Settings' },
];

/**
 * Build a context-aware scan URL based on the current page.
 * When viewing a property/area/container, the scan page pre-fills
 * the location dropdowns so scanned items go to the right place.
 */
function buildScanUrl(pathname: string): string {
  // /container/:id → pass containerId (area and property resolved server-side)
  const containerMatch = pathname.match(/^\/container\/(\d+)/);
  if (containerMatch) {
    return `/scan?containerId=${containerMatch[1]}`;
  }
  // /area/:id → pass areaId
  const areaMatch = pathname.match(/^\/area\/(\d+)/);
  if (areaMatch) {
    return `/scan?areaId=${areaMatch[1]}`;
  }
  // /property/:id → pass propertyId
  const propertyMatch = pathname.match(/^\/property\/(\d+)/);
  if (propertyMatch) {
    return `/scan?propertyId=${propertyMatch[1]}`;
  }
  return '/scan';
}

export function BottomNav() {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <nav className="fixed bottom-0 left-0 right-0 backdrop-blur-xl bg-[var(--color-card)]/90 border-t border-[var(--color-border)]/50 z-50 pb-[env(safe-area-inset-bottom)]">
      <div className="flex items-center justify-around py-1 md:py-2 max-w-lg mx-auto">
        {tabs.map((tab) => {
          const isActive = location.pathname === tab.path ||
            (tab.path === '/scan' && location.pathname.startsWith('/scan')) ||
            (tab.path === '/inventory' && /^\/(property|area|container|item)\//.test(location.pathname));
          const Icon = tab.icon;

          if (tab.center) {
            const scanUrl = buildScanUrl(location.pathname);
            return (
              <button key={tab.path} onClick={() => navigate(scanUrl)}
                className="flex flex-col items-center -mt-5 transition-transform duration-200 active:scale-95 min-w-[44px]">
                <div className="w-13 h-13 rounded-full bg-[var(--color-primary)] flex items-center justify-center shadow-lg">
                  <Icon className="w-6 h-6 text-white" />
                </div>
                <span className="text-[11px] mt-1 font-medium text-[var(--color-text-muted)]">{tab.label}</span>
              </button>
            );
          }

          return (
            <button key={tab.path} onClick={() => navigate(tab.path)}
              className="flex flex-col items-center gap-0.5 py-2 px-3 min-w-[44px] min-h-[44px] relative transition-colors duration-200">
              {isActive && (
                <span className="absolute -top-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-[var(--color-primary)]" />
              )}
              <Icon className={cn(
                'w-5 h-5 transition-colors duration-200',
                isActive ? 'text-[var(--color-primary)]' : 'text-[var(--color-text-muted)]',
              )} />
              <span className={cn(
                'text-[11px] transition-colors duration-200',
                isActive ? 'text-[var(--color-primary)] font-semibold' : 'text-[var(--color-text-muted)]',
              )}>{tab.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

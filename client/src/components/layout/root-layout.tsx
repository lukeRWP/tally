import { useRef, useState } from 'react';
import { Outlet, Navigate, useLocation, useNavigate } from 'react-router';
import { Home, Search, Bell, Settings, Printer, DoorOpen, BarChart2, Plus, ScanLine, Package, Box } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useAuthStore } from '@/store/auth-store';
import { useUnreadCount } from '@/hooks/use-notifications';
import { useArea, useContainer, useProperties } from '@/hooks/use-inventory';
import { usePrintAttention } from '@/hooks/use-print';
import { Header } from './header';
import { BottomNav, isNavActive } from './bottom-nav';
import { CarryBanner } from '@/components/inventory/carry-banner';
import { CreateContainerDialog } from '@/components/inventory/create-container-dialog';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { buildCaptureUrl } from '@/lib/capture-url';
import { useLayoutMode } from '@/hooks/use-layout-mode';
import { useHasCamera } from '@/hooks/use-has-camera';
import { useScrollRestoration } from '@/hooks/use-scroll-restoration';
import { stackReserveCss, useBottomBarActive, useCarryBannerShowing } from '@/hooks/use-bottom-stack';

/**
 * What "where" the current page already answers, so the container dialog
 * doesn't make the user repeat a choice the page they're standing on already
 * made. Both hooks are called unconditionally (the `?? 0`-with-`enabled`
 * idiom from container-preview.tsx) — only one of them is ever enabled, since
 * the path can't match both patterns at once.
 */
export function useRouteSeed(pathname: string) {
  const areaMatch = pathname.match(/^\/area\/(\d+)/);
  const containerMatch = pathname.match(/^\/container\/(\d+)/);
  const areaIdFromPath = areaMatch ? Number(areaMatch[1]) : undefined;
  const containerIdFromPath = containerMatch ? Number(containerMatch[1]) : undefined;

  const { data: seedArea } = useArea(areaIdFromPath ?? 0);
  const { data: seedContainer } = useContainer(containerIdFromPath ?? 0);

  if (areaIdFromPath != null) {
    if (!seedArea) return undefined;
    return { areaId: seedArea.id, areaName: seedArea.name, propertyId: seedArea.propertyId };
  }
  if (containerIdFromPath != null) {
    if (!seedContainer) return undefined;
    // The container's breadcrumb is closure-table CONTAINER ancestors only
    // (`{id, name}`, no `type`) — area/property arrive as flat fields on the
    // container payload instead. Same cast container-detail.tsx:182 uses.
    const ext = seedContainer as unknown as { propertyId?: number; areaName?: string };
    return {
      areaId: seedContainer.areaId,
      areaName: ext.areaName,
      propertyId: ext.propertyId,
    };
  }
  return undefined;
}

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

/**
 * The rail's one signal that a destination wants you. Kept as one component so
 * a second global state cannot be added with markup that drifts from the first
 * — which is how printing ended up with no badge at all (#283).
 *
 * The count is aria-hidden and restated in full for a screen reader: "Print 2"
 * says nothing about what the 2 is.
 */
function NavBadge({ count, label }: { count: number; label: string }) {
  return (
    <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-[var(--color-red)] text-white text-[10px] font-bold flex items-center justify-center leading-none">
      <span aria-hidden="true">{count > 99 ? '99+' : count}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

function Sidebar() {
  const location = useLocation();
  // Scan is dropped where there is no camera to scan with. Asked of the device
  // rather than inferred from the width — this rail also serves iPad landscape,
  // which very much has one.
  const hasCamera = useHasCamera();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const { data: unreadCount } = useUnreadCount();
  const unread = typeof unreadCount === 'number' ? unreadCount : 0;
  // Print jobs are property-scoped and the rail has no property context, so it
  // watches the first one — the same default /reports and /settings land on.
  const { data: properties } = useProperties();
  const printAttention = usePrintAttention(properties?.[0]?.id);
  const routeSeed = useRouteSeed(location.pathname);
  const [createContainerOpen, setCreateContainerOpen] = useState(false);

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
          nav rather than in it. Item still shares buildCaptureUrl with the
          phone's centre button so the bin you are standing in pre-pins as the
          destination; two copies of that rule would drift. Container is new:
          it can be created from anywhere, not just from inside an area or
          another container's page. */}
      <div className="px-3 pt-4">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              aria-label="Add"
              // This rail is the ONLY nav an iPad in landscape gets (there is
              // no bottom nav there), so its rows are finger targets on a
              // coarse pointer — 36/40px from padding alone at a desk, floored
              // to 44 on touch. See globals.css → Touch targets.
              className="w-full flex items-center gap-2 px-3 py-2.5 min-h-[var(--tap-min)] rounded-[var(--radius-sm)] bg-[var(--color-primary)] text-white font-mono text-xs font-bold uppercase tracking-[0.12em] hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[var(--color-text)] focus:ring-offset-2"
            >
              <Plus className="w-4 h-4 shrink-0" />
              <span>Add</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={() => navigate(buildCaptureUrl(location.pathname))}>
              <Package className="w-4 h-4" /> Item
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setCreateContainerOpen(true)}>
              <Box className="w-4 h-4" /> Container
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <CreateContainerDialog
          open={createContainerOpen}
          onOpenChange={setCreateContainerOpen}
          seedAreaId={routeSeed?.areaId}
          seedAreaName={routeSeed?.areaName}
          seedPropertyId={routeSeed?.propertyId}
        />
      </div>

      {/* Nav items */}
      <nav className="flex-1 px-3 pt-3 pb-4 space-y-1">
        {navItems.filter((item) => item.path !== '/scan' || hasCamera).map((item) => {
          const isActive = isNavActive(item.path, location.pathname);
          const Icon = item.icon;

          return (
            <button
              key={item.path}
              onClick={() => navigate(item.path)}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'flex items-center gap-3 w-full px-3 py-2.5 min-h-[var(--tap-min)] rounded-[var(--radius-sm)] font-mono text-xs font-bold uppercase tracking-[0.08em] transition-colors duration-150',
                isActive
                  ? 'bg-[var(--color-text)] text-[var(--color-bg)]'
                  : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-elevated)] hover:text-[var(--color-text)]',
              )}
            >
              <Icon className="w-5 h-5 shrink-0" />
              <span className="flex-1 text-left">{item.label}</span>
              {item.path === '/notifications' && unread > 0 && (
                <NavBadge count={unread} label={`${unread} unread`} />
              )}
              {item.path === '/print' && printAttention > 0 && (
                <NavBadge count={printAttention} label={`${printAttention} needing attention`} />
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
  // where that hurt most. `useCarryBannerShowing` already knows /move renders
  // the scanner but never the banner (the same guard carry-banner.tsx's own
  // early return uses) — this used to be a second, independent copy of that
  // exact condition.
  const carrying = useCarryBannerShowing();
  // A page's own select-mode bar (container-detail.tsx, recycle-bin-list.tsx)
  // is equally `fixed` and equally worth reserving for — see use-bottom-stack.ts.
  const barActive = useBottomBarActive();
  // The three camera flows are sized to the viewport instead of scrolling:
  // the frame is a flex item that absorbs the leftover height.
  const fitsViewport = pathname === '/capture' || pathname === '/scan' || pathname === '/move';

  // POP-aware scroll restoration (#232): resets to top on PUSH/REPLACE-to-a-
  // new-pathname, restores the cached offset on POP, and leaves scroll alone
  // when only the search params changed (e.g. Home's debounced search, #224).
  useScrollRestoration(mainRef);

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
      {/* Skip link (#279). <aside> is the first thing in the DOM and holds Add
          plus seven nav rows, so EVERY page costs eight tab stops before its
          first breadcrumb — twenty before the first fact on item detail. First
          child of the layout so it is tab stop 1, invisible until focused.
          <main> needs tabIndex={-1} to be a focus target at all. */}
      <a
        href="#main-content"
        // The ring preventDefaults Enter whenever a cursor exists, and #270
        // makes "Back → Tab → Enter" the ordinary path — so without this the
        // skip link is tab stop 1 on every ringed surface and its Enter opens
        // the highlighted ROW instead of skipping. It is not a nav row; it
        // opts out the same way the tree's chevron does.
        data-nav-ignore=""
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:px-3 focus:py-2 focus:rounded-[var(--radius-sm)] focus:bg-[var(--color-text)] focus:text-[var(--color-bg)] focus:font-mono focus:text-xs focus:font-bold focus:uppercase focus:tracking-[0.08em]"
      >
        Skip to content
      </a>
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
          id="main-content"
          tabIndex={-1}
          className="flex-1 overflow-y-auto overflow-x-hidden px-4 pt-4"
          // The reserve for whatever is currently pinned to the bottom of the
          // screen — the nav (touch only), the carry banner, and a page's own
          // select-mode bar — comes from the ONE shared model in
          // use-bottom-stack.ts, so this can never drift from what the carry
          // banner, a page's own bar, or the toast layer each think is
          // stacked below them (see that file's own doc comment for why this
          // used to be four independent, occasionally-wrong arithmetics).
          // Inline style, not a Tailwind class: the reserve is one of several
          // numeric rem values computed at runtime, and Tailwind's build-time
          // class scanner cannot see a dynamically-built class name.
          style={{ paddingBottom: stackReserveCss({ touch: !sidebar, carrying, barActive }) }}
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

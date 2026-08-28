import { Link, useLocation } from 'react-router-dom';
import { Home, ChevronRight, ArrowLeft } from 'lucide-react';
import type { BreadcrumbItem } from '@/types/inventory';

interface BreadcrumbsProps {
  items: BreadcrumbItem[];
}

function getPath(item: BreadcrumbItem): string {
  switch (item.type) {
    case 'property': return `/property/${item.id}`;
    case 'area': return `/area/${item.id}`;
    case 'container': return `/container/${item.id}`;
    default: return '/';
  }
}

/**
 * Every notification-list click target (item, container, area, property —
 * see notification-list.tsx's entityPath) lands on one of the four detail
 * pages, and every one of those pages renders Breadcrumbs. That makes this
 * the one shared spot to hang a "back to alerts" affordance on, rather than
 * threading it through each of the four pages individually: the list's
 * navigate() call carries `{state:{from:'alerts'}}`, and this component
 * renders the link back whenever it sees that flag — no page-specific code
 * needed at all.
 */
export function Breadcrumbs({ items }: BreadcrumbsProps) {
  const location = useLocation();
  const fromAlerts = (location.state as { from?: string } | null)?.from === 'alerts';

  return (
    <div className="mb-3">
      {fromAlerts && (
        <Link
          to="/notifications"
          className="mb-1 flex w-fit items-center gap-1 font-mono text-[10px] uppercase tracking-[0.04em] text-[var(--color-primary)] hover:opacity-80 transition-opacity"
        >
          <ArrowLeft className="w-3 h-3" />
          Back to Alerts
        </Link>
      )}
      <nav className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.04em] text-[var(--color-text-muted)] overflow-x-auto min-h-[44px] -my-2 py-2">
        <Link to="/" className="hover:text-[var(--color-text-secondary)] transition-colors flex items-center gap-1 shrink-0 py-2">
          <Home className="w-3 h-3" />
          Home
        </Link>
        {items.map((item) => (
          <span key={`${item.type}-${item.id}`} className="flex items-center gap-1 shrink-0">
            <ChevronRight className="w-3 h-3 shrink-0" />
            <Link to={getPath(item)} className="hover:text-[var(--color-text-secondary)] transition-colors py-2 max-w-[120px] truncate">
              {item.name}
            </Link>
          </span>
        ))}
      </nav>
    </div>
  );
}

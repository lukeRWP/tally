import { Link } from 'react-router-dom';
import { Home, ChevronRight } from 'lucide-react';
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

export function Breadcrumbs({ items }: BreadcrumbsProps) {
  return (
    <nav className="flex items-center gap-1 text-xs text-[var(--color-text-muted)] mb-3 overflow-x-auto min-h-[44px] -my-2 py-2">
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
  );
}

import { Link } from 'react-router-dom';
import { Home, ChevronRight } from 'lucide-react';
import type { BreadcrumbItem } from '@/types/inventory';

interface BreadcrumbsProps {
  items: BreadcrumbItem[];
}

// Map type to route prefix
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
    <nav className="flex items-center gap-1 text-xs text-[var(--color-text-muted)] mb-3 overflow-x-auto">
      <span className="flex items-center gap-1 whitespace-nowrap">
        <Link to="/" className="hover:text-[var(--color-text-secondary)] transition-colors flex items-center gap-1">
          <Home className="w-3 h-3" />
          Home
        </Link>
      </span>
      {items.map((item) => (
        <span key={`${item.type}-${item.id}`} className="flex items-center gap-1 whitespace-nowrap">
          <ChevronRight className="w-3 h-3" />
          <Link to={getPath(item)} className="hover:text-[var(--color-text-secondary)] transition-colors">
            {item.name}
          </Link>
        </span>
      ))}
    </nav>
  );
}

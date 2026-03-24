import { useNavigate } from 'react-router-dom';
import { Home, Warehouse, ChevronRight } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { Property } from '@/types/inventory';

interface PropertyCardProps {
  property: Property;
}

export function PropertyCard({ property }: PropertyCardProps) {
  const navigate = useNavigate();

  const isStorage = property.name.toLowerCase().includes('storage');
  const Icon = isStorage ? Warehouse : Home;

  return (
    <Card
      className="flex items-center gap-3 cursor-pointer active:opacity-80 transition-opacity"
      onClick={() => navigate(`/property/${property.id}`)}
    >
      <div
        className={`flex items-center justify-center w-10 h-10 rounded-[var(--radius-md)] shrink-0 ${
          isStorage
            ? 'bg-[var(--color-amber-bg)] text-[var(--color-amber)]'
            : 'bg-[var(--color-primary-bg)] text-[var(--color-primary)]'
        }`}
      >
        <Icon className="w-5 h-5" />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-[var(--color-text)] truncate">
            {property.name}
          </span>
          {property.role !== 'owner' && (
            <Badge variant="info">{property.role}</Badge>
          )}
        </div>
        <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
          {property.areaCount} areas · {property.containerCount} containers · {property.itemCount} items
        </p>
        <p className="text-[10px] font-mono text-[var(--color-text-muted)] mt-0.5">
          {property.qrCode}
        </p>
      </div>

      <ChevronRight className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
    </Card>
  );
}

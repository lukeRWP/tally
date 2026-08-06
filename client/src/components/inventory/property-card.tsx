import { useNavigate } from 'react-router-dom';
import { Home, Warehouse } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { RuledRow } from '@/components/ui/ruled-row';
import type { Property } from '@/types/inventory';

interface PropertyCardProps {
  property: Property;
  index?: number;
}

export function PropertyCard({ property, index = 0 }: PropertyCardProps) {
  const navigate = useNavigate();

  const isStorage = property.name.toLowerCase().includes('storage');
  const Icon = isStorage ? Warehouse : Home;

  const leading = (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--color-rule)] text-[var(--color-text-muted)]">
      <Icon className="h-4 w-4" />
    </span>
  );

  return (
    <RuledRow
      onNavigate={() => navigate(`/property/${property.id}`)}
      animationDelay={`${index * 50}ms`}
      leading={leading}
      title={property.name}
      titleTrailing={property.role !== 'owner' ? <Badge variant="info">{property.role}</Badge> : undefined}
      meta={`${property.qrCode} · ${property.areaCount} areas · ${property.containerCount} ctr · ${property.itemCount} items`}
    />
  );
}

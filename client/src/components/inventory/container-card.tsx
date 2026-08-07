import { useNavigate } from 'react-router-dom';
import { Package } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { RuledRow } from '@/components/ui/ruled-row';
import type { Container } from '@/types/inventory';

interface ContainerCardProps {
  container: Container;
  /** When set, the row becomes a selection toggle instead of a link. */
  selectable?: boolean;
  selected?: boolean;
  onToggle?: () => void;
}

export function ContainerCard({ container, selectable, selected, onToggle }: ContainerCardProps) {
  const navigate = useNavigate();

  const leading = (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--color-rule)] text-[var(--color-text-muted)]">
      <Package className="h-4 w-4" />
    </span>
  );

  return (
    <RuledRow
      onNavigate={() => navigate(`/container/${container.id}`)}
      selectable={selectable}
      selected={selected}
      onToggle={onToggle}
      selectLabel={`Select ${container.name}`}
      leading={leading}
      title={container.name}
      titleTrailing={<Badge variant="warning">{container.type}</Badge>}
      meta={`${container.qrCode} · ${container.containerCount} nested · ${container.itemCount} items`}
    />
  );
}

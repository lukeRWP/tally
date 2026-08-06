import { useNavigate } from 'react-router-dom';
import { DoorOpen } from 'lucide-react';
import { RuledRow } from '@/components/ui/ruled-row';
import type { Area } from '@/types/inventory';

interface AreaCardProps {
  area: Area;
}

export function AreaCard({ area }: AreaCardProps) {
  const navigate = useNavigate();

  const leading = (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--color-rule)] text-[var(--color-text-muted)]">
      <DoorOpen className="h-4 w-4" />
    </span>
  );

  return (
    <RuledRow
      onNavigate={() => navigate(`/area/${area.id}`)}
      leading={leading}
      title={area.name}
      meta={`${area.qrCode} · ${area.containerCount} containers · ${area.itemCount} items`}
    />
  );
}

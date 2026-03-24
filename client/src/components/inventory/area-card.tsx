import { useNavigate } from 'react-router-dom';
import { DoorOpen, ChevronRight } from 'lucide-react';
import { Card } from '@/components/ui/card';
import type { Area } from '@/types/inventory';

interface AreaCardProps {
  area: Area;
}

export function AreaCard({ area }: AreaCardProps) {
  const navigate = useNavigate();

  return (
    <Card
      className="flex items-center gap-3 cursor-pointer active:opacity-80 transition-opacity"
      onClick={() => navigate(`/area/${area.id}`)}
    >
      <div className="flex items-center justify-center w-10 h-10 rounded-[var(--radius-md)] shrink-0 bg-[var(--color-primary-bg)] text-[var(--color-primary)]">
        <DoorOpen className="w-5 h-5" />
      </div>

      <div className="flex-1 min-w-0">
        <span className="text-sm font-semibold text-[var(--color-text)] truncate block">
          {area.name}
        </span>
        <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
          {area.containerCount} containers · {area.itemCount} items
        </p>
        <p className="text-[10px] font-mono text-[var(--color-text-muted)] mt-0.5">
          {area.qrCode}
        </p>
      </div>

      <ChevronRight className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
    </Card>
  );
}

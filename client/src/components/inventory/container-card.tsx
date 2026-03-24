import { useNavigate } from 'react-router-dom';
import { Package, ChevronRight } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { Container } from '@/types/inventory';

interface ContainerCardProps {
  container: Container;
}

export function ContainerCard({ container }: ContainerCardProps) {
  const navigate = useNavigate();

  return (
    <Card
      className="flex items-center gap-3 cursor-pointer active:opacity-80 transition-opacity"
      onClick={() => navigate(`/container/${container.id}`)}
    >
      <div className="flex items-center justify-center w-10 h-10 rounded-[var(--radius-md)] shrink-0 bg-[var(--color-amber-bg)] text-[var(--color-amber)]">
        <Package className="w-5 h-5" />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-[var(--color-text)] truncate">
            {container.name}
          </span>
          <Badge variant="warning">{container.type}</Badge>
        </div>
        <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
          {container.nestedContainerCount} nested · {container.itemCount} items
        </p>
        <p className="text-[10px] font-mono text-[var(--color-text-muted)] mt-0.5">
          {container.qrCode}
        </p>
      </div>

      <ChevronRight className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
    </Card>
  );
}

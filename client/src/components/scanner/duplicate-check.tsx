import { AlertTriangle, ExternalLink, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

interface DuplicateItem {
  id: number;
  name: string;
  containerName: string;
  areaName: string;
  propertyName: string;
}

interface DuplicateCheckProps {
  duplicates: DuplicateItem[];
  productName: string;
  onAddNew: () => void;
  onGoToExisting: (itemId: number) => void;
  onClose: () => void;
}

export function DuplicateCheck({
  duplicates,
  productName,
  onAddNew,
  onGoToExisting,
  onClose,
}: DuplicateCheckProps) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-sm mx-4">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="flex items-center justify-center w-8 h-8 rounded-full bg-[var(--color-amber-bg)]">
              <AlertTriangle className="w-4 h-4 text-[var(--color-amber)]" />
            </div>
            <DialogTitle className="text-base font-semibold text-[var(--color-text)]">
              You already have {productName}
            </DialogTitle>
          </div>
          <DialogDescription className="text-sm text-[var(--color-text-muted)] mt-1">
            {duplicates.length === 1
              ? 'This item already exists in your inventory.'
              : `Found ${duplicates.length} matching items in your inventory.`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 max-h-[40vh] overflow-y-auto">
          {duplicates.map((item) => (
            <Card
              key={item.id}
              className="flex items-center justify-between gap-3 cursor-pointer active:opacity-80 transition-opacity"
              onClick={() => onGoToExisting(item.id)}
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-[var(--color-text)] truncate">
                  {item.name}
                </p>
                <p className="text-xs text-[var(--color-text-muted)] truncate mt-0.5">
                  {item.propertyName} &gt; {item.areaName} &gt; {item.containerName}
                </p>
              </div>
              <ExternalLink className="w-4 h-4 text-[var(--color-primary)] shrink-0" />
            </Card>
          ))}
        </div>

        <Button variant="outline" size="sm" className="w-full mt-2" onClick={onAddNew}>
          <Plus className="w-4 h-4" />
          This is a new one
        </Button>
      </DialogContent>
    </Dialog>
  );
}

import * as React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Pencil, ArrowRightLeft, Trash2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useItem, useDeleteProperty } from '@/hooks/use-inventory';
import { toast } from '@/components/ui/toast';
import { FileList } from '@/components/files/file-list';
import { FileUpload } from '@/components/files/file-upload';
import { ConditionForm } from '@/components/condition/condition-form';
import { ConditionTimeline } from '@/components/condition/condition-timeline';

const conditionVariant = {
  new: 'success',
  good: 'default',
  fair: 'warning',
  poor: 'danger',
} as const;

const statusVariant = {
  active: 'success',
  removed: 'danger',
  lent: 'info',
} as const;

export function ItemDetail() {
  const { itemId } = useParams<{ itemId: string }>();
  const id = Number(itemId);
  const navigate = useNavigate();

  const { data: item, isLoading } = useItem(id);
  // Reuse delete mutation pattern — actual item delete not yet available, placeholder
  const _deleteProperty = useDeleteProperty();

  const [conditionFormOpen, setConditionFormOpen] = React.useState(false);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!item) {
    return <p className="text-sm text-[var(--color-text-muted)] text-center py-8">Item not found.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div>
        <h1 className="text-lg font-bold text-[var(--color-text)]">{item.name}</h1>
        <p className="text-[10px] font-mono text-[var(--color-text-muted)]">{item.qrCode}</p>
        <div className="flex items-center gap-2 mt-1">
          <Badge variant={conditionVariant[item.condition]}>{item.condition}</Badge>
          <Badge variant={statusVariant[item.status]}>{item.status}</Badge>
          {item.quantity > 1 && (
            <Badge variant="info">Qty: {item.quantity}</Badge>
          )}
        </div>
        {item.description && (
          <p className="text-sm text-[var(--color-text-secondary)] mt-2">{item.description}</p>
        )}
      </div>

      {/* Product Info */}
      {item.product && (
        <Card>
          <h2 className="text-sm font-semibold text-[var(--color-text)] mb-2">Product Info</h2>
          {item.product.imageUrl && (
            <img
              src={item.product.imageUrl}
              alt={item.product.name}
              className="w-full h-32 object-contain rounded-[var(--radius-md)] mb-2 bg-[var(--color-elevated)]"
            />
          )}
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-[var(--color-text-muted)]">Brand</span>
              <p className="text-[var(--color-text)] font-medium">{item.product.brand}</p>
            </div>
            <div>
              <span className="text-[var(--color-text-muted)]">Category</span>
              <p className="text-[var(--color-text)] font-medium">{item.product.category}</p>
            </div>
            {item.product.retailPrice != null && (
              <div>
                <span className="text-[var(--color-text-muted)]">Retail Price</span>
                <p className="text-[var(--color-text)] font-medium">${item.product.retailPrice.toFixed(2)}</p>
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Value */}
      <Card>
        <h2 className="text-sm font-semibold text-[var(--color-text)] mb-2">Value</h2>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <span className="text-[var(--color-text-muted)]">Purchase Price</span>
            <p className="text-[var(--color-text)] font-medium">
              {item.purchasePrice != null ? `$${item.purchasePrice.toFixed(2)}` : '--'}
            </p>
          </div>
          <div>
            <span className="text-[var(--color-text-muted)]">Current Value</span>
            <p className="text-[var(--color-text)] font-medium">
              {item.currentValue != null ? `$${item.currentValue.toFixed(2)}` : '--'}
            </p>
          </div>
        </div>
      </Card>

      {/* Phase 4 placeholders */}
      {['Dates', 'Accessories', 'Lending'].map((section) => (
        <Card key={section}>
          <h2 className="text-sm font-semibold text-[var(--color-text)] mb-1">{section}</h2>
          <p className="text-xs text-[var(--color-text-muted)]">Coming in Phase 4</p>
        </Card>
      ))}

      {/* Files */}
      <Card>
        <h2 className="text-sm font-semibold text-[var(--color-text)] mb-3">Files</h2>
        <FileList itemId={id} />
        <FileUpload itemId={id} />
      </Card>

      {/* Condition History */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Condition History</h2>
          <Button size="sm" variant="outline" onClick={() => setConditionFormOpen(true)}>
            <Plus className="w-3.5 h-3.5" />
            Record
          </Button>
        </div>
        <ConditionTimeline itemId={id} />
        <ConditionForm
          itemId={id}
          isOpen={conditionFormOpen}
          onOpenChange={setConditionFormOpen}
          onComplete={() => {}}
        />
      </Card>

      {/* Actions */}
      <div className="flex gap-2">
        <Button variant="outline" size="sm" className="flex-1" onClick={() => toast('Edit coming soon')}>
          <Pencil className="w-4 h-4" />
          Edit
        </Button>
        <Button variant="outline" size="sm" className="flex-1" onClick={() => toast('Move coming soon')}>
          <ArrowRightLeft className="w-4 h-4" />
          Move
        </Button>
        <Button variant="destructive" size="sm" className="flex-1" onClick={() => {
          toast('Delete coming soon');
          navigate(-1);
        }}>
          <Trash2 className="w-4 h-4" />
          Delete
        </Button>
      </div>
    </div>
  );
}

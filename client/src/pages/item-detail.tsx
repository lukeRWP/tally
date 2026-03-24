import * as React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Pencil, ArrowRightLeft, Trash2, Plus, Printer, Link, CalendarPlus, HandCoins, Share2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LabelPrintDialog } from '@/components/labels/label-print-dialog';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useItem, useDeleteProperty } from '@/hooks/use-inventory';
import { toast } from '@/components/ui/toast';
import { FileList } from '@/components/files/file-list';
import { FileUpload } from '@/components/files/file-upload';
import { ConditionForm } from '@/components/condition/condition-form';
import { ConditionTimeline } from '@/components/condition/condition-timeline';
import { TagPicker } from '@/components/tags/tag-picker';
import { DateList } from '@/components/dates/date-list';
import { DateForm } from '@/components/dates/date-form';
import { AccessoryList } from '@/components/accessories/accessory-list';
import { AccessoryPicker } from '@/components/accessories/accessory-picker';
import { LendingList } from '@/components/lending/lending-list';
import { LendForm } from '@/components/lending/lend-form';
import { useItemDates } from '@/hooks/use-dates';
import { ShareDialog } from '@/components/sharing/share-dialog';

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

function computeDepreciation(
  purchasePrice: number,
  depreciationRate: number,
  purchaseDate: string | null,
  fallbackDate: string,
) {
  const since = purchaseDate || fallbackDate;
  const purchaseTime = new Date(since).getTime();
  const now = Date.now();
  const msPerYear = 365.25 * 24 * 60 * 60 * 1000;
  const yearsSince = (now - purchaseTime) / msPerYear;
  const currentValue = purchasePrice * Math.pow(1 - depreciationRate, yearsSince);
  const sinceYear = new Date(since).getFullYear().toString();
  const ratePercent = Math.round(depreciationRate * 100);
  return { currentValue: Math.max(0, currentValue), ratePercent, sinceYear };
}

export function ItemDetail() {
  const { itemId } = useParams<{ itemId: string }>();
  const id = Number(itemId);
  const navigate = useNavigate();

  const { data: item, isLoading } = useItem(id);
  // Reuse delete mutation pattern — actual item delete not yet available, placeholder
  const _deleteProperty = useDeleteProperty();

  // Derive propertyId from breadcrumb returned by the item detail API
  const propertyId = (item as unknown as { breadcrumb?: { id: number; type: string }[] })
    ?.breadcrumb?.find((b) => b.type === 'property')?.id ?? 0;

  const [conditionFormOpen, setConditionFormOpen] = React.useState(false);
  const [printOpen, setPrintOpen] = React.useState(false);
  const [dateFormOpen, setDateFormOpen] = React.useState(false);
  const [accessoryPickerOpen, setAccessoryPickerOpen] = React.useState(false);
  const [lendFormOpen, setLendFormOpen] = React.useState(false);
  const [shareOpen, setShareOpen] = React.useState(false);

  // Fetch item dates for depreciation calculation
  const { data: itemDates } = useItemDates(id);

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

  // Cast to access depreciation fields from the API
  const extItem = item as typeof item & {
    depreciationEnabled?: boolean;
    depreciationRate?: number | null;
  };

  // Find earliest "purchased" date for depreciation
  const purchasedDate = itemDates
    ?.filter((d) => d.dateType.toLowerCase() === 'purchased')
    .sort((a, b) => new Date(a.dateValue).getTime() - new Date(b.dateValue).getTime())[0]
    ?.dateValue ?? null;

  const depreciation =
    extItem.depreciationEnabled &&
    extItem.purchasePrice != null &&
    extItem.depreciationRate != null &&
    extItem.depreciationRate > 0
      ? computeDepreciation(
          extItem.purchasePrice,
          extItem.depreciationRate,
          purchasedDate,
          extItem.createdAt,
        )
      : null;

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
        {depreciation && (
          <div className="mt-2 pt-2 border-t border-[var(--color-border)]">
            <p className="text-xs text-[var(--color-text-secondary)]">
              Est. Value: <span className="font-medium text-[var(--color-text)]">${depreciation.currentValue.toFixed(2)}</span>
              {' '}
              <span className="text-[var(--color-text-muted)]">
                ({depreciation.ratePercent}% annual, since {depreciation.sinceYear})
              </span>
            </p>
          </div>
        )}
      </Card>

      {/* Tags */}
      {propertyId > 0 && (
        <Card>
          <h2 className="text-sm font-semibold text-[var(--color-text)] mb-3">Tags</h2>
          <TagPicker entityType="item" entityId={item.id} propertyId={propertyId} />
        </Card>
      )}

      {/* Dates */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Dates</h2>
          <Button size="sm" variant="outline" onClick={() => setDateFormOpen(true)}>
            <CalendarPlus className="w-3.5 h-3.5" />
            Add Date
          </Button>
        </div>
        <DateList itemId={id} />
        <DateForm
          itemId={id}
          isOpen={dateFormOpen}
          onOpenChange={setDateFormOpen}
        />
      </Card>

      {/* Accessories */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Accessories</h2>
          <Button size="sm" variant="outline" onClick={() => setAccessoryPickerOpen(true)}>
            <Link className="w-3.5 h-3.5" />
            Link
          </Button>
        </div>
        <AccessoryList itemId={id} />
        <AccessoryPicker
          itemId={id}
          isOpen={accessoryPickerOpen}
          onOpenChange={setAccessoryPickerOpen}
        />
      </Card>

      {/* Lending */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Lending</h2>
          {item.status === 'active' && (
            <Button size="sm" variant="outline" onClick={() => setLendFormOpen(true)}>
              <HandCoins className="w-3.5 h-3.5" />
              Lend
            </Button>
          )}
        </div>
        <LendingList itemId={id} itemName={item.name} />
        <LendForm
          itemId={id}
          isOpen={lendFormOpen}
          onOpenChange={setLendFormOpen}
        />
      </Card>

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
      <div className="flex gap-2 flex-wrap">
        <Button variant="outline" size="sm" className="flex-1" onClick={() => toast('Edit coming soon')}>
          <Pencil className="w-4 h-4" />
          Edit
        </Button>
        <Button variant="outline" size="sm" className="flex-1" onClick={() => toast('Move coming soon')}>
          <ArrowRightLeft className="w-4 h-4" />
          Move
        </Button>
        <Button variant="outline" size="sm" className="flex-1" onClick={() => setShareOpen(true)}>
          <Share2 className="w-4 h-4" />
          Share
        </Button>
        <Button variant="outline" size="sm" className="flex-1" onClick={() => setPrintOpen(true)}>
          <Printer className="w-4 h-4" />
          Print
        </Button>
        <Button variant="destructive" size="sm" className="flex-1" onClick={() => {
          toast('Delete coming soon');
          navigate(-1);
        }}>
          <Trash2 className="w-4 h-4" />
          Delete
        </Button>
      </div>
      <LabelPrintDialog
        entities={[{
          id: item.id,
          name: item.name,
          qrCode: item.qrCode,
          type: 'item',
          breadcrumb: (item as unknown as { breadcrumb?: { name: string }[] })
            ?.breadcrumb?.map((b) => b.name).join(' > '),
        }]}
        entityType="item"
        isOpen={printOpen}
        onOpenChange={setPrintOpen}
      />
      <ShareDialog
        entityType="item"
        entityId={item.id}
        entityName={item.name}
        isOpen={shareOpen}
        onOpenChange={setShareOpen}
      />
    </div>
  );
}

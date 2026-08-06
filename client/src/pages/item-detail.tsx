import * as React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Pencil, ArrowRightLeft, Trash2, Plus, Printer, Link, CalendarPlus, HandCoins, Share2,
  ChevronRight, ChevronDown, MoreHorizontal, Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LabelPrintDialog } from '@/components/labels/label-print-dialog';
import { Card } from '@/components/ui/card';
import { TitleBar } from '@/components/ui/title-bar';
// (Badge import removed — it was dead; item-detail renders no <Badge>.)
import { Skeleton } from '@/components/ui/skeleton';
import { useItem, useDeleteItem, useUpdateItem } from '@/hooks/use-inventory';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EntityForm } from '@/components/inventory/entity-form';
import { MoveItemDialog } from '@/components/inventory/move-item-dialog';
import { ErrorState } from '@/components/ui/error-state';
import { toast } from '@/components/ui/toast';
import { Breadcrumbs } from '@/components/layout/breadcrumbs';
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
import { useItemFiles } from '@/hooks/use-files';
import { useAccessories } from '@/hooks/use-accessories';
import { useLendingHistory } from '@/hooks/use-lending';
import { ShareDialog } from '@/components/sharing/share-dialog';
import { cn, safeExternalUrl } from '@/lib/utils';

const conditionColor: Record<string, string> = {
  new: 'bg-[var(--color-green)]',
  good: 'bg-[var(--color-primary)]',
  fair: 'bg-[var(--color-amber)]',
  poor: 'bg-[var(--color-red)]',
};

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

// -- Collapsible Section -------------------------------------------------------

function CollapsibleSection({
  title,
  icon,
  defaultOpen,
  action,
  children,
  animationDelay,
}: {
  title: string;
  icon?: React.ReactNode;
  defaultOpen: boolean;
  action?: React.ReactNode;
  children: React.ReactNode;
  animationDelay?: string;
}) {
  const [open, setOpen] = React.useState(defaultOpen);

  return (
    <Card animationDelay={animationDelay}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center w-full gap-2 text-left cursor-pointer"
      >
        {icon}
        <h2 className="font-mono text-[11px] uppercase tracking-[0.1em] font-semibold text-[var(--color-text)] flex-1">{title}</h2>
        {open ? (
          <ChevronDown className="w-4 h-4 text-[var(--color-text-muted)] transition-transform duration-200" />
        ) : (
          <ChevronRight className="w-4 h-4 text-[var(--color-text-muted)] transition-transform duration-200" />
        )}
      </button>
      {open && (
        <div className="mt-3 animate-fade-up">
          {action && <div className="flex justify-end mb-2">{action}</div>}
          {children}
        </div>
      )}
    </Card>
  );
}

// -- Overflow menu --------------------------------------------------------------

function OverflowMenu({
  onShare,
  onPrint,
  onDelete,
}: {
  onShare: () => void;
  onPrint: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <Button
        variant="ghost"
        size="sm"
        className="text-xs w-9 h-9 p-0"
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal className="w-4 h-4" />
      </Button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 min-w-[140px] bg-[var(--color-card)] border border-[var(--color-border)] rounded-[var(--radius-lg)] shadow-[0_4px_16px_rgba(0,0,0,0.08)] p-1 flex flex-col gap-0.5 animate-scale-in">
          <button
            type="button"
            onClick={() => { onShare(); setOpen(false); }}
            className="flex items-center gap-2 px-3 py-2 text-xs text-[var(--color-text)] hover:bg-[var(--color-elevated)] rounded-[var(--radius-md)] transition-colors w-full text-left"
          >
            <Share2 className="w-3.5 h-3.5" />
            Share
          </button>
          <button
            type="button"
            onClick={() => { onPrint(); setOpen(false); }}
            className="flex items-center gap-2 px-3 py-2 text-xs text-[var(--color-text)] hover:bg-[var(--color-elevated)] rounded-[var(--radius-md)] transition-colors w-full text-left"
          >
            <Printer className="w-3.5 h-3.5" />
            Print Label
          </button>
          <div className="border-t border-[var(--color-border)] my-0.5" />
          <button
            type="button"
            onClick={() => { onDelete(); setOpen(false); }}
            className="flex items-center gap-2 px-3 py-2 text-xs text-[var(--color-red)] hover:bg-[var(--color-red-bg)] rounded-[var(--radius-md)] transition-colors w-full text-left"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

export function ItemDetail() {
  const { itemId } = useParams<{ itemId: string }>();
  const id = Number(itemId);

  const navigate = useNavigate();
  const { data: item, isLoading, isError, refetch } = useItem(id);
  const deleteItem = useDeleteItem();
  const [deleteOpen, setDeleteOpen] = React.useState(false);

  // Derive property/container from breadcrumb returned by the item detail API
  const breadcrumb = (item as unknown as { breadcrumb?: { id: number; type: string }[] })?.breadcrumb;
  const propertyId = breadcrumb?.find((b) => b.type === 'property')?.id ?? 0;
  // Last container crumb, not the first: breadcrumbs run root→leaf, so for an
  // item inside a nested container .find() would return the OUTERMOST box —
  // wrong for both "move (current)" marking and delete-navigation.
  const containerId = breadcrumb?.filter((b) => b.type === 'container').at(-1)?.id;

  function confirmDeleteItem() {
    deleteItem.mutate(id, {
      onSuccess: () => {
        toast('Item moved to recycle bin');
        navigate(containerId ? `/container/${containerId}` : '/');
      },
      onError: (err: Error) => toast(err.message),
    });
    setDeleteOpen(false);
  }

  const updateItem = useUpdateItem();
  const [editOpen, setEditOpen] = React.useState(false);
  const [moveOpen, setMoveOpen] = React.useState(false);
  const [conditionFormOpen, setConditionFormOpen] = React.useState(false);
  const [printOpen, setPrintOpen] = React.useState(false);
  const [dateFormOpen, setDateFormOpen] = React.useState(false);
  const [accessoryPickerOpen, setAccessoryPickerOpen] = React.useState(false);
  const [lendFormOpen, setLendFormOpen] = React.useState(false);
  const [shareOpen, setShareOpen] = React.useState(false);

  // Fetch item dates for depreciation calculation
  const { data: itemDates } = useItemDates(id);
  // Fetch files & accessories & lending to determine if sections have data
  const { data: itemFiles } = useItemFiles(id);
  const { data: accessories } = useAccessories(id);
  const { data: lendingHistory } = useLendingHistory(id);

  const hasFiles = (itemFiles?.length ?? 0) > 0;
  const hasDates = (itemDates?.length ?? 0) > 0;
  const hasAccessories = (accessories?.length ?? 0) > 0;
  const hasLending = (lendingHistory?.length ?? 0) > 0;

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
    return isError
      ? <ErrorState message="Couldn't load this item." onRetry={() => refetch()} />
      : <p className="text-sm text-[var(--color-text-muted)] text-center py-8">Item not found.</p>;
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

  // Breadcrumb from API
  const breadcrumbItems = (item as unknown as { breadcrumb?: import('@/types/inventory').BreadcrumbItem[] })
    ?.breadcrumb ?? [];

  return (
    <div className="flex flex-col gap-4 pb-24 lg:pb-8">
      {/* Breadcrumbs */}
      <Breadcrumbs items={breadcrumbItems} />

      {/* Hero Section — inverted title bar */}
      <div className="animate-fade-up flex flex-col gap-2">
        <TitleBar className="w-fit max-w-full">{item.name}</TitleBar>

        {/* Condition indicator strip */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5">
            <span className={cn('w-3 h-3 rounded-full shrink-0', conditionColor[item.condition] ?? 'bg-[var(--color-text-muted)]')} />
            <span className="text-xs font-medium text-[var(--color-text-secondary)] capitalize">{item.condition}</span>
          </div>
          <span className="text-[var(--color-border)] hidden sm:inline">|</span>
          <span className="text-xs font-medium text-[var(--color-text-secondary)] capitalize">{item.status}</span>
          {item.quantity > 1 && (
            <span className="text-xs font-medium text-[var(--color-text-secondary)]">Qty: {item.quantity}</span>
          )}
          <span className="text-[11px] font-mono text-[var(--color-text-muted)]">{item.qrCode}</span>
        </div>

        {item.description && (
          <p className="text-sm text-[var(--color-text-secondary)] mt-2">{item.description}</p>
        )}

        {/* Inline Tags */}
        {propertyId > 0 && (
          <div className="mt-3">
            <TagPicker entityType="item" entityId={item.id} propertyId={propertyId} />
          </div>
        )}
      </div>

      {/* Primary Action Row */}
      <div className="flex gap-2 animate-fade-up" style={{ animationDelay: '50ms' }}>
        <Button variant="outline" size="sm" className="flex-1 text-xs" onClick={() => setEditOpen(true)}>
          <Pencil className="w-3.5 h-3.5" />
          Edit
        </Button>
        <Button variant="outline" size="sm" className="flex-1 text-xs" onClick={() => setMoveOpen(true)}>
          <ArrowRightLeft className="w-3.5 h-3.5" />
          Move
        </Button>
        <OverflowMenu
          onShare={() => setShareOpen(true)}
          onPrint={() => setPrintOpen(true)}
          onDelete={() => setDeleteOpen(true)}
        />
      </div>

      {/* Desktop: 2-column layout / Mobile: single column */}
      <div className="lg:grid lg:grid-cols-3 lg:gap-6">
        {/* Left column (main info) */}
        <div className="lg:col-span-2 flex flex-col gap-4">
          {/* Product Info */}
          {(item.productName || item.productImageUrl) && (
            <Card animationDelay="50ms">
              <h2 className="text-sm font-semibold text-[var(--color-text)] mb-2">Product Info</h2>
              {item.productImageUrl && (
                <img
                  src={item.productImageUrl}
                  alt={item.productName || item.name}
                  className="w-full h-40 object-contain rounded-[var(--radius-md)] mb-3 bg-[var(--color-elevated)]"
                />
              )}
              {item.productDescription && (
                <p className="text-xs text-[var(--color-text-secondary)] mb-3 leading-relaxed">{item.productDescription}</p>
              )}
              <div className="grid grid-cols-2 gap-2 text-xs">
                {item.productBrand && (
                  <div>
                    <span className="text-[var(--color-text-muted)]">Brand</span>
                    <p className="text-[var(--color-text)] font-medium">{item.productBrand}</p>
                  </div>
                )}
                {item.productCategory && (
                  <div>
                    <span className="text-[var(--color-text-muted)]">Category</span>
                    <p className="text-[var(--color-text)] font-medium">{item.productCategory}</p>
                  </div>
                )}
                {item.productRetailPrice != null && (
                  <div>
                    <span className="text-[var(--color-text-muted)]">Retail Price</span>
                    <p className="text-[var(--color-green)] font-semibold">${item.productRetailPrice.toFixed(2)}</p>
                  </div>
                )}
                {item.productBarcode && (
                  <div>
                    <span className="text-[var(--color-text-muted)]">Barcode</span>
                    <p className="text-[var(--color-text)] font-mono text-[11px]">{item.productBarcode}</p>
                  </div>
                )}
                {item.productDataSource && (
                  <div>
                    <span className="text-[var(--color-text-muted)]">Source</span>
                    <p className="text-[var(--color-text)]">{item.productDataSource.replace(/_/g, ' ')}</p>
                  </div>
                )}
              </div>

              {/* Product Specs */}
              {item.productSpecs && Object.keys(item.productSpecs).length > 0 && (
                <div className="mt-3 pt-3 border-t border-[var(--color-border)]">
                  <p className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)] font-medium mb-2">Specifications</p>
                  <div className="grid grid-cols-2 gap-1.5 text-xs">
                    {Object.entries(item.productSpecs)
                      .filter(([, v]) => v != null && v !== '')
                      .map(([key, value]) => (
                        <div key={key}>
                          <span className="text-[var(--color-text-muted)] capitalize">{key.replace(/_/g, ' ')}</span>
                          <p className="text-[var(--color-text)]">{String(value)}</p>
                        </div>
                      ))}
                  </div>
                </div>
              )}

              {/* Retail Links */}
              {item.productRetailLinks && item.productRetailLinks.length > 0 && (
                <div className="mt-3 pt-3 border-t border-[var(--color-border)]">
                  <p className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)] font-medium mb-2">Where to buy</p>
                  <div className="flex flex-wrap gap-1.5">
                    {item.productRetailLinks.slice(0, 5).map((link, i) => (
                      <a
                        key={i}
                        href={safeExternalUrl(link.url)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 px-2 py-1 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-elevated)] text-[11px] text-[var(--color-text-secondary)] hover:text-[var(--color-primary)] hover:border-[var(--color-primary)] transition-colors"
                      >
                        <span className="truncate max-w-[100px]">{link.retailer}</span>
                        {link.price != null && <span className="text-[var(--color-green)]">${link.price.toFixed(2)}</span>}
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </Card>
          )}

          {/* Dates -- collapsible, default open if has data */}
          <CollapsibleSection
            title="Dates"
            defaultOpen={hasDates}
            animationDelay="200ms"
            action={
              <Button size="sm" variant="outline" onClick={() => setDateFormOpen(true)}>
                <CalendarPlus className="w-3.5 h-3.5" />
                Add Date
              </Button>
            }
          >
            <DateList itemId={id} />
            <DateForm
              itemId={id}
              isOpen={dateFormOpen}
              onOpenChange={setDateFormOpen}
            />
          </CollapsibleSection>

          {/* Accessories -- collapsible, default open if has data */}
          <CollapsibleSection
            title="Accessories"
            defaultOpen={hasAccessories}
            animationDelay="250ms"
            action={
              <Button size="sm" variant="outline" onClick={() => setAccessoryPickerOpen(true)}>
                <Link className="w-3.5 h-3.5" />
                Link
              </Button>
            }
          >
            <AccessoryList itemId={id} />
            <AccessoryPicker
              itemId={id}
              isOpen={accessoryPickerOpen}
              onOpenChange={setAccessoryPickerOpen}
            />
          </CollapsibleSection>

          {/* Lending -- collapsible, default open if has data */}
          <CollapsibleSection
            title="Lending"
            defaultOpen={hasLending}
            animationDelay="300ms"
            action={
              item.status === 'active' ? (
                <Button size="sm" variant="outline" onClick={() => setLendFormOpen(true)}>
                  <HandCoins className="w-3.5 h-3.5" />
                  Lend
                </Button>
              ) : undefined
            }
          >
            <LendingList itemId={id} itemName={item.name} />
            <LendForm
              itemId={id}
              isOpen={lendFormOpen}
              onOpenChange={setLendFormOpen}
            />
          </CollapsibleSection>
        </div>

        {/* Right column (sidebar) */}
        <div className="lg:col-span-1 flex flex-col gap-4 mt-4 lg:mt-0">
          {/* Value */}
          <Card animationDelay="100ms">
            <h2 className="text-sm font-semibold text-[var(--color-text)] mb-3">Value</h2>
            {item.purchasePrice != null ? (
              <div>
                <div>
                  <span className="text-xs text-[var(--color-text-muted)]">Purchase Price</span>
                  <p className="text-3xl font-extrabold text-[var(--color-text)] mt-0.5 tracking-tight">
                    <span className="text-[var(--color-text-muted)] text-xl">$</span>
                    {item.purchasePrice.toFixed(2)}
                  </p>
                </div>
                {item.currentValue != null && item.currentValue !== item.purchasePrice && (
                  <div className="mt-3 pt-3 border-t border-[var(--color-border)]">
                    <span className="text-xs text-[var(--color-text-muted)]">Current Value</span>
                    <p className="text-xl font-bold text-[var(--color-primary)] mt-0.5">
                      ${item.currentValue.toFixed(2)}
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-sm text-[var(--color-text-muted)]">No price recorded</p>
            )}
            {depreciation && (
              <div className="mt-3 pt-3 border-t border-[var(--color-border)]">
                <p className="text-xs text-[var(--color-text-secondary)]">
                  Est. Value: <span className="font-semibold text-[var(--color-text)]">${depreciation.currentValue.toFixed(2)}</span>
                  {' '}
                  <span className="text-[var(--color-text-muted)]">
                    ({depreciation.ratePercent}% annual, since {depreciation.sinceYear})
                  </span>
                </p>
              </div>
            )}
          </Card>

          {/* Files -- dashed dropzone when empty */}
          <Card animationDelay="350ms">
            <h2 className="text-sm font-semibold text-[var(--color-text)] mb-3">Files</h2>
            {hasFiles ? (
              <>
                <FileList itemId={id} />
                <div className="mt-3">
                  <FileUpload itemId={id} />
                </div>
              </>
            ) : (
              <div className="border-2 border-dashed border-[var(--color-border)] rounded-lg p-6 text-center">
                <Upload className="w-6 h-6 text-[var(--color-text-muted)] mx-auto mb-2" />
                <p className="text-xs text-[var(--color-text-muted)] mb-3">
                  No files attached yet
                </p>
                <FileUpload itemId={id} />
              </div>
            )}
          </Card>

          {/* Condition History */}
          <Card animationDelay="400ms">
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
        </div>
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
        propertyId={propertyId > 0 ? propertyId : undefined}
      />
      {editOpen && (
        <EntityForm
          open
          onOpenChange={(o) => { if (!o) setEditOpen(false); }}
          type="item"
          defaultValues={{
            name: item.name,
            description: item.description ?? '',
            quantity: item.quantity,
            purchasePrice: item.purchasePrice ?? '',
            condition: item.condition,
          }}
          isPending={updateItem.isPending}
          onSubmit={async (data) => {
            try {
              // EntityForm strips empty values (it was built for create, where
              // absent means "don't set"). In EDIT, absent means the user
              // CLEARED the field — without this, clearing the price toasts
              // "Item updated" while the old price silently survives. The
              // update schema allows null for exactly these fields.
              const cleared: Record<string, unknown> = {};
              if (!('description' in data)) cleared.description = null;
              if (!('purchasePrice' in data)) cleared.purchasePrice = null;
              await updateItem.mutateAsync({ id, ...cleared, ...data });
              toast('Item updated');
            } catch (err) {
              toast(err instanceof Error ? err.message : 'Could not update the item');
              throw err; // keep the form open with the user's input
            }
          }}
        />
      )}

      <MoveItemDialog
        open={moveOpen}
        onOpenChange={setMoveOpen}
        itemId={id}
        itemName={item.name}
        defaultPropertyId={propertyId || undefined}
        currentContainerId={containerId}
        onMoved={() => refetch()}
      />

      <ShareDialog
        entityType="item"
        entityId={item.id}
        entityName={item.name}
        isOpen={shareOpen}
        onOpenChange={setShareOpen}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete "${item.name}"?`}
        description="This moves the item to the recycle bin, where it can be restored for 30 days."
        destructive
        confirmLabel="Delete"
        isPending={deleteItem.isPending}
        onConfirm={confirmDeleteItem}
      />
    </div>
  );
}

import * as React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Pencil, ArrowRightLeft, Trash2, Plus, Printer, Link, CalendarPlus, HandCoins, Share2,
  ChevronRight, ChevronDown, MoreHorizontal, Upload, Camera, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LabelPrintDialog } from '@/components/labels/label-print-dialog';
import { Card } from '@/components/ui/card';
import { TitleBar } from '@/components/ui/title-bar';
import { ColHead } from '@/components/ui/col-head';
import { Badge } from '@/components/ui/badge';
// (Badge import removed — it was dead; item-detail renders no <Badge>.)
import { Skeleton } from '@/components/ui/skeleton';
import { useItem, useDeleteItem, useUpdateItem } from '@/hooks/use-inventory';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EntityForm } from '@/components/inventory/entity-form';
import { MoveItemDialog } from '@/components/inventory/move-item-dialog';
import { useCarryStore } from '@/store/carry-store';
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
import { useEntityHistory } from '@/hooks/use-notifications';
import { useItemFiles, useUploadFile, useConditionHistory } from '@/hooks/use-files';
import { useAccessories } from '@/hooks/use-accessories';
import { useLendingHistory } from '@/hooks/use-lending';
import { ShareDialog } from '@/components/sharing/share-dialog';
import { safeExternalUrl } from '@/lib/utils';

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

/**
 * What has happened to this item. Every create / move / lend / delete already
 * writes to the change log, so this is a read of truth the app was recording
 * and never showing.
 */
function ItemHistory({ itemId }: { itemId: number }) {
  const { data: entries } = useEntityHistory('item', itemId);
  const [all, setAll] = React.useState(false);
  const list = entries ?? [];
  const shown = all ? list : list.slice(0, 4);

  return (
    <div className="flex flex-col animate-fade-up" style={{ animationDelay: '110ms' }}>
      <ColHead
        action={list.length > shown.length ? `All ${list.length}` : undefined}
        onAction={() => setAll(true)}
      >
        History
      </ColHead>
      {shown.length === 0 ? (
        <p className="font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--color-text-muted)] py-3">
          Nothing else recorded yet
        </p>
      ) : (
        shown.map((e) => (
          <div key={e.id} className="flex items-baseline gap-3 py-2 border-b border-[var(--color-rule)] last:border-b-0">
            <span className="font-mono text-[10px] text-[var(--color-text-muted)] shrink-0 w-16">
              {new Date(e.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            </span>
            <span className="text-sm flex-1 min-w-0">
              <span className="capitalize">{e.action}</span>
              {e.displayName ? (
                <span className="text-[var(--color-text-muted)]"> · {e.displayName}</span>
              ) : null}
            </span>
          </div>
        ))
      )}
    </div>
  );
}

/** A dashed invitation to add one missing fact. */
function AddChip({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="font-mono text-[10px] uppercase tracking-[0.06em] border border-dashed border-[var(--color-text-muted)] text-[var(--color-text-muted)] rounded-full px-3 min-h-[28px] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]"
    >
      + {label}
    </button>
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
  // the server sends { id, name, type } (items.service.js _mapItem); `name` was
  // simply missing from this local cast
  const breadcrumb = (item as unknown as { breadcrumb?: { id: number; name: string | null; type: string }[] })?.breadcrumb;
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
  const pickUp = useCarryStore((s) => s.pickUp);
  const [conditionFormOpen, setConditionFormOpen] = React.useState(false);
  const [printOpen, setPrintOpen] = React.useState(false);
  const [dateFormOpen, setDateFormOpen] = React.useState(false);
  const [accessoryPickerOpen, setAccessoryPickerOpen] = React.useState(false);
  const [lendFormOpen, setLendFormOpen] = React.useState(false);
  const [shareOpen, setShareOpen] = React.useState(false);
  const [photoOpen, setPhotoOpen] = React.useState(false);
  const photoInput = React.useRef<HTMLInputElement>(null);
  const uploadPhoto = useUploadFile();

  // Photographing an item you are already looking at should cost one tap and
  // no dialog — the file lands as a photo and the page shows it immediately.
  async function onPickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      await uploadPhoto.mutateAsync({ itemId: id, file, fileType: 'photo' });
      toast.success('Photo added');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not add the photo');
    }
  }

  // Fetch item dates for depreciation calculation
  const { data: itemDates } = useItemDates(id);
  // Fetch files & accessories & lending to determine if sections have data
  const { data: itemFiles } = useItemFiles(id);
  const { data: conditions } = useConditionHistory(id);
  const { data: accessories } = useAccessories(id);
  const { data: lendingHistory } = useLendingHistory(id);

  // Your photograph outranks the catalogue's stock image: one is this object,
  // the other is a picture of something like it.
  const photo = item?.photoUrl || item?.productImageUrl || null;

  const hasConditions = (conditions?.length ?? 0) > 0;
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

      {/* Identity — the photo you took, the facts on one line, the code.
          Capture leads with a photograph, so the item's own page has to show
          it; it used to appear only as a filename buried in Files, while the
          top of the page showed nothing at all. */}
      <div className="animate-fade-up flex flex-col gap-2">
        <TitleBar className="w-fit max-w-full">{item.name}</TitleBar>

        <div className="flex items-start gap-3">
          {photo ? (
            <button
              type="button"
              onClick={() => setPhotoOpen(true)}
              className="shrink-0 w-16 h-16 rounded-[var(--radius-sm)] overflow-hidden border border-[var(--color-rule)]"
            >
              <img src={photo} alt={item.name} className="w-full h-full object-cover" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => photoInput.current?.click()}
              aria-label="Add a photo"
              className="shrink-0 w-16 h-16 rounded-[var(--radius-sm)] border border-dashed border-[var(--color-text-muted)] flex items-center justify-center text-[var(--color-text-muted)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]"
            >
              <Camera className="w-5 h-5" />
            </button>
          )}

          <div className="min-w-0 flex-1 flex flex-col gap-1">
            {/* Facts on ONE line. Most items are "a thing in a bin" — quantity,
                condition and value said once, in order, beat four labelled cards. */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold text-[var(--color-text)]">
                {[
                  item.quantity > 1 ? `${item.quantity}` : null,
                  item.condition ? item.condition.charAt(0).toUpperCase() + item.condition.slice(1) : null,
                  item.purchasePrice != null ? `$${item.purchasePrice.toFixed(2)}` : null,
                ].filter(Boolean).join(' · ')}
              </span>
              {item.status !== 'active' && <Badge variant="info">{item.status}</Badge>}
              <span className="font-mono text-[11px] text-[var(--color-text-muted)]">{item.qrCode}</span>
            </div>

            {item.description && (
              <p className="text-sm text-[var(--color-text-secondary)]">{item.description}</p>
            )}

            {propertyId > 0 && (
              <TagPicker entityType="item" entityId={item.id} propertyId={propertyId} />
            )}
          </div>
        </div>
      </div>

      {/* Actions. Lend leads: it is the one thing you do TO an item that the
          app can't infer, and it used to be buried inside a collapsed card. */}
      <div className="flex gap-2 animate-fade-up" style={{ animationDelay: '50ms' }}>
        <Button size="sm" className="flex-1 text-xs" onClick={() => setLendFormOpen(true)}>
          <HandCoins className="w-3.5 h-3.5" />
          {item.status === 'lent' ? 'Return' : 'Lend'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="flex-1 text-xs"
          onClick={() => {
            // Flow A: Move picks the item UP. The carry banner then follows you
            // anywhere, and any container label you scan puts it down.
            pickUp([{
              id: item.id,
              name: item.name,
              kind: 'item',
              fromContainerId: containerId,
              fromContainerName: breadcrumb?.filter((b) => b.type === 'container').at(-1)?.name ?? undefined,
            }]);
            toast(`Carrying ${item.name} — scan where it goes`);
            navigate('/scan?mode=move');
          }}
        >
          <ArrowRightLeft className="w-3.5 h-3.5" />
          Move
        </Button>
        <Button variant="outline" size="sm" className="flex-1 text-xs" onClick={() => setEditOpen(true)}>
          <Pencil className="w-3.5 h-3.5" />
          Edit
        </Button>
        <OverflowMenu
          onShare={() => setShareOpen(true)}
          onPrint={() => setPrintOpen(true)}
          onDelete={() => setDeleteOpen(true)}
        />
      </div>

      {/* What this item could still tell us. Creation captures almost nothing
          on purpose, so the gaps must read as invitations rather than
          emptiness — each chip opens the thing that fills it, and a chip
          disappears once its fact exists. */}
      {(!photo || item.purchasePrice == null || !item.description || !hasDates || !hasFiles || !hasConditions) && (
        <div className="flex flex-col gap-1.5 animate-fade-up" style={{ animationDelay: '80ms' }}>
          <ColHead>Add what you know</ColHead>
          <div className="flex flex-wrap gap-1.5">
            {!photo && <AddChip label="photo" onClick={() => photoInput.current?.click()} />}
            {item.purchasePrice == null && <AddChip label="value" onClick={() => setEditOpen(true)} />}
            {!item.description && <AddChip label="description" onClick={() => setEditOpen(true)} />}
            {!hasDates && <AddChip label="warranty" onClick={() => setDateFormOpen(true)} />}
            {!hasFiles && <AddChip label="receipt" onClick={() => photoInput.current?.click()} />}
            {!hasConditions && <AddChip label="condition" onClick={() => setConditionFormOpen(true)} />}
          </div>
        </div>
      )}

      <ItemHistory itemId={id} />

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
          {hasDates && (
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
          )}

          {/* Accessories -- collapsible, default open if has data */}
          {hasAccessories && (
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
          )}

          {/* Lending -- collapsible, default open if has data */}
          {hasLending && (
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
          )}
        </div>

        {/* Right column (sidebar) */}
        <div className="lg:col-span-1 flex flex-col gap-4 mt-4 lg:mt-0">
          {/* Value — only once there IS one. Absent value is the "+ value"
              chip above, not a card announcing that nothing is recorded. */}
          {item.purchasePrice != null && (
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
          )}

          {/* Files — the empty dropzone duplicated the + receipt chip, so the
              card appears only when files exist. */}
          {hasFiles && (
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
          )}

          {/* Condition History — only once something has been recorded. The
              "+ condition" chip above is how you record the first one. */}
          {hasConditions && (
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
          )}
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

      {/* Photo capture from the page itself: the chip and the empty thumbnail
          both open this, so "add a photo" is one tap wherever you notice it. */}
      <input
        ref={photoInput}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={onPickPhoto}
      />

      {photoOpen && photo && (
        <div
          role="dialog"
          aria-label="Photo"
          onClick={() => setPhotoOpen(false)}
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4"
        >
          <img src={photo} alt={item.name} className="max-w-full max-h-full object-contain" />
          <button
            type="button"
            aria-label="Close"
            onClick={() => setPhotoOpen(false)}
            className="absolute top-4 right-4 min-w-[44px] min-h-[44px] flex items-center justify-center text-white"
          >
            <X className="w-6 h-6" />
          </button>
        </div>
      )}

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

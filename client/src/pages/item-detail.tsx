import * as React from 'react';
import { useParams, useNavigate } from 'react-router';
import {
  Pencil, ArrowRightLeft, Trash2, Printer, HandCoins, Share2,
  MoreHorizontal, X, ChevronRight, Camera, Scissors,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LabelPrintDialog } from '@/components/labels/label-print-dialog';
import { TitleBar } from '@/components/ui/title-bar';
import { ColHead } from '@/components/ui/col-head';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useItem, useDeleteItem, useUpdateItem } from '@/hooks/use-inventory';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EntityForm } from '@/components/inventory/entity-form';
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
import { FieldDialog, type FieldKind } from '@/components/inventory/field-dialog';
import { safeExternalUrl, cn } from '@/lib/utils';
import { useLayoutMode } from '@/hooks/use-layout-mode';
import { useKeyboardNav } from '@/hooks/use-keyboard-nav';

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

// -- Overflow menu --------------------------------------------------------------

function OverflowMenu({
  onLend,
  lendLabel,
  onShare,
  onPrint,
  onDelete,
}: {
  onLend: () => void;
  lendLabel: string;
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
          {/* Lending leads the menu: it is the most consequential thing here,
              and it came out of the action row to make room. */}
          <button
            type="button"
            onClick={() => { onLend(); setOpen(false); }}
            className="flex items-center gap-2 px-3 py-2 text-xs text-[var(--color-text)] hover:bg-[var(--color-elevated)] rounded-[var(--radius-md)] transition-colors w-full text-left"
          >
            <HandCoins className="w-3.5 h-3.5" />
            {lendLabel}
          </button>
          <div className="border-t border-[var(--color-border)] my-0.5" />
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
/** "created" is a database word. The mockup writes "Added to Tote". */
const HISTORY_VERB: Record<string, string> = {
  created: 'Added',
  updated: 'Edited',
  moved: 'Moved',
  deleted: 'Deleted',
  restored: 'Restored',
  lent: 'Lent',
  returned: 'Returned',
};

function describeEntry(
  e: { action: string; changes?: Record<string, unknown> },
  containerId?: number,
  containerName?: string | null,
): string {
  const verb = HISTORY_VERB[e.action] ?? e.action;
  // Only name the destination when the entry's container is still where the
  // item lives — otherwise the row would assert a location that later changed.
  const to = e.changes?.containerId;
  if ((e.action === 'created' || e.action === 'moved') && containerName && to === containerId) {
    return `${verb} to ${containerName}`;
  }
  if (e.action === 'updated' && e.changes) {
    const fields = Object.keys(e.changes);
    if (fields.length === 1) return `${verb} ${fields[0]}`;
  }
  return verb;
}

function ItemHistory({
  itemId,
  containerId,
  containerName,
}: {
  itemId: number;
  containerId?: number;
  containerName?: string | null;
}) {
  const { data: entries } = useEntityHistory('item', itemId);
  const [all, setAll] = React.useState(false);
  const list = entries ?? [];
  const shown = all ? list : list.slice(0, 4);

  return (
    <div className="animate-fade-up" style={{ animationDelay: '110ms' }}>
      <Section
        title="History"
        count={list.length}
        action={list.length > shown.length ? `All ${list.length}` : undefined}
        onAction={() => setAll(true)}
      >
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
              <span>{describeEntry(e, containerId, containerName)}</span>
              {e.displayName ? (
                <span className="text-[var(--color-text-muted)]"> · {e.displayName}</span>
              ) : null}
            </span>
          </div>
        ))
      )}
      </Section>
    </div>
  );
}

/**
 * A ruled section that starts closed.
 *
 * The ledger is the page; everything under it is reference material you go
 * looking for. Closed by default keeps the page the length of its facts — but
 * a closed section still states its COUNT, so collapsing never hides the
 * existence of what is inside.
 */
function Section({
  title,
  count,
  action,
  onAction,
  defaultOpen = false,
  card = false,
  children,
}: {
  title: string;
  count?: number;
  action?: React.ReactNode;
  onAction?: () => void;
  defaultOpen?: boolean;
  /** Draw as a bordered card — the desk treatment. */
  card?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    // A card at a desk, a bare ruled block on a phone.
    //
    // These sections are each a different KIND of record — what is attached,
    // what has happened, what the catalogue says — and on a wide page a run of
    // undifferentiated rules gives no sign of where one ends and the next
    // begins. A border does that without adding a word.
    <div className={cn(
      'flex flex-col',
      card && 'rounded-[var(--radius-sm)] border border-[var(--color-rule)] px-3 pb-2 pt-1.5',
    )}>
      <div className="flex items-baseline justify-between gap-2 border-b-2 border-[var(--color-rule)] pb-1.5 font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex items-center gap-1.5 min-h-[32px] -my-1 truncate font-mono uppercase tracking-[0.1em]"
        >
          <ChevronRight className={cn('w-3 h-3 shrink-0 transition-transform', open && 'rotate-90')} />
          <span className="truncate">{title}</span>
          {count != null && count > 0 && (
            <span className="text-[var(--color-text)] font-bold">· {count}</span>
          )}
        </button>
        {/* The action must not toggle the section — "Add date" opens a form. */}
        {action != null && onAction && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onAction(); }}
            className="shrink-0 -my-1 px-1 min-h-[28px] inline-flex items-center font-bold text-[var(--color-primary)] hover:opacity-80"
          >
            {action}
          </button>
        )}
      </div>
      {open && children}
    </div>
  );
}

/**
 * The drop area that lives inside the Files panel.
 *
 * Attach used to be its own collapsed section below Files, so adding a file
 * meant finding a second heading for a thing the first one was already about.
 * One panel: what is attached, and the box you attach with.
 */
function FilesBox({ id, types }: { id: number; types?: readonly ('receipt' | 'warranty' | 'manual' | 'photo' | 'other')[] }) {
  return (
    <div className="pt-2 pb-1">
      <FileUpload itemId={id} types={types} />
    </div>
  );
}

/**
 * One line of the ledger: a label, and either the fact or an invitation to
 * supply it. Keeping absent facts VISIBLE is the whole idea of this design —
 * the page is a list of what it knows and what it could know, on one rule.
 */
function LedgerRow({
  label,
  value,
  onAdd,
  onEdit,
  wrap,
  inherited,
}: {
  label: string;
  value?: React.ReactNode;
  onAdd?: () => void;
  onEdit?: () => void;
  /** Let the value wrap instead of ellipsing — for prose like a description. */
  wrap?: boolean;
  /**
   * The value came from the catalogue, not from this object. Shown, but
   * marked: the ledger must never claim the user told it something they didn't.
   */
  inherited?: string;
}) {
  const filled = value !== null && value !== undefined && value !== '';
  // min-h on the ROW, not on the button — otherwise an empty row stands taller
  // than a filled one and the rule stops being even.
  return (
    <div className="flex items-center gap-3 min-h-[44px] border-b border-[var(--color-rule)] last:border-b-0">
      {/* The label is user-controlled for dates, so it must be able to give way
          — otherwise a long type name pushes the fact itself off the row. */}
      <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-muted)] shrink-0 max-w-[45%] truncate">
        {label}
      </span>
      <span className="flex-1" />
      {filled ? (
        <button
          type="button"
          onClick={onEdit}
          disabled={!onEdit}
          aria-label={onEdit ? `Edit ${label}` : undefined}
          className={cn(
            'text-sm text-right min-w-0 disabled:cursor-default',
            inherited ? 'font-normal text-[var(--color-text-secondary)]' : 'font-semibold',
            wrap ? 'whitespace-normal py-2' : 'truncate',
          )}
        >
          {inherited && (
            <span className="font-mono text-[9px] uppercase tracking-[0.06em] mr-1.5 align-middle text-[var(--color-text-muted)]">
              {inherited}
            </span>
          )}
          {value}
        </button>
      ) : (
        // Full-height hit area without changing the row's height.
        <button
          type="button"
          onClick={onAdd}
          aria-label={`Add ${label}`}
          className="self-stretch flex items-center font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--color-primary)] px-1"
        >
          + add
        </button>
      )}
    </div>
  );
}

export function ItemDetail() {
  // Above every early return: this component bails out for loading and error
  // states, and a hook called after one of those runs on some renders and not
  // others — React counts hooks per render and throws when the count changes.
  const split = useLayoutMode() === 'sidebar';
  /**
   * The ledger row currently being edited, if any. One dialog serves all of
   * them — the alternative is a boolean per field, which drifts the moment a
   * row is added.
   */
  const [field, setField] = React.useState<
    null | { key: 'quantity' | 'purchasePrice' | 'description'; label: string; kind: FieldKind; hint?: string }
  >(null);
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
  const pickUp = useCarryStore((s) => s.pickUp);
  const [conditionFormOpen, setConditionFormOpen] = React.useState(false);
  const [printOpen, setPrintOpen] = React.useState(false);
  const [dateFormOpen, setDateFormOpen] = React.useState(false);
  const [accessoryPickerOpen, setAccessoryPickerOpen] = React.useState(false);
  const [lendFormOpen, setLendFormOpen] = React.useState(false);
  const [shareOpen, setShareOpen] = React.useState(false);
  const [photoOpen, setPhotoOpen] = React.useState(false);
  const [useRetailOpen, setUseRetailOpen] = React.useState(false);
  /**
   * The edit dialog is shared by every ledger row, so the catalogue
   * description may only be pre-filled when the DESCRIPTION row is what opened
   * it. Otherwise changing the quantity silently signs the user's name to text
   * a scraper wrote — and publishes it on every share link.
   */
  const [adoptDesc, setAdoptDesc] = React.useState(false);
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
  // The loan the "Lent to" row names — there is at most one open at a time.
  const openLoan = (lendingHistory ?? []).find((l) => !l.returnedAt);

  const hasConditions = (conditions?.length ?? 0) > 0;
  // Any file at all: FileList carries the ONLY open/delete controls for files,
  // photos included, so gating it on non-photo files stranded them.
  const hasFilesAny = (itemFiles ?? []).length > 0;
  const photoCount = (itemFiles ?? []).filter((f) => f.fileType === 'photo').length;
  const docCount = (itemFiles ?? []).filter((f) => f.fileType !== 'photo').length;
  const hasAccessories = (accessories?.length ?? 0) > 0;
  const hasLending = (lendingHistory?.length ?? 0) > 0;

  /**
   * The two keys that let a keyboard browse session CONTINUE past an item
   * (#279).
   *
   * This is the densest page in the app and it wired nothing: `/`, j, k and
   * Escape all did nothing, and the first fact on the page was twenty tab
   * stops deep. A full row ring over the ledger is a larger design question
   * and deliberately not attempted here — but arriving by keyboard and having
   * the keyboard stop working is what ends the session, so `/` leaves for
   * search and Escape steps back to the list you came from.
   *
   * Off while any dialog is up: Escape belongs to the dialog then, and
   * navigating the page out from under an open dialog is never what was
   * meant. `field` is the shared ledger-edit dialog (one for every row).
   */
  const dialogOpen = deleteOpen || editOpen || conditionFormOpen || printOpen
    || dateFormOpen || accessoryPickerOpen || lendFormOpen || shareOpen
    || photoOpen || useRetailOpen || field !== null;
  useKeyboardNav({
    enabled: split && !dialogOpen,
    onSearch: () => navigate('/search'),
    onEscape: () => {
      // Direct entry (QR deep link, fresh tab) has no prior in-app entry —
      // popping would do nothing or leave the SPA. Same guard search.tsx's
      // back arrow uses.
      const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
      if (idx > 0) navigate(-1);
      else navigate('/');
    },
  });

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

  /**
   * The name, code and stamps.
   *
   * On a phone this sits beside the thumbnail, because there is one column and
   * the picture and the name introduce the page together. At a desk the photo
   * gets a column of its own, and a title tucked into a 340px sidebar reads as
   * a caption for the photograph rather than as the heading of the page — so it
   * moves to the top of the ledger, which is where the page's content starts.
   */
  const identityText = (
    <div className="min-w-0 flex flex-col gap-2">
        <TitleBar className="w-fit max-w-full">{item.name}</TitleBar>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-[11px] text-[var(--color-text-muted)]">{item.qrCode}</span>
          {item.condition && (
            <Badge>{item.condition.charAt(0).toUpperCase() + item.condition.slice(1)}</Badge>
          )}
          {/* 'active' is the unremarkable case, so it gets the plain ink stamp;
              only the states worth noticing take a colour. */}
          <Badge variant={item.status === 'lent' ? 'warning' : item.status === 'active' ? 'default' : 'danger'}>
            {item.status}
          </Badge>
        </div>
        {/* Shown only when it would actually change the name, so it retires
            itself the moment it is used. Quiet by design: a catalogue title is
            ugly, not broken, and the row it names is still perfectly findable. */}
        {item.suggestedName && (
          <button
            type="button"
            disabled={updateItem.isPending}
            onClick={() => updateItem.mutate(
              { id, name: item.suggestedName },
              {
                onSuccess: () => toast.success('Name shortened'),
                onError: (e: Error) => toast.error(e.message || 'Could not rename it'),
              },
            )}
            className="flex items-start gap-1.5 text-left min-h-[32px] font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--color-primary)] disabled:opacity-45"
          >
            <Scissors className="w-3.5 h-3.5 shrink-0 mt-[1px]" />
            <span className="min-w-0">Shorten to “{item.suggestedName}”</span>
          </button>
        )}
    </div>
  );

  return (
    <div className={cn(
      'flex flex-col gap-4 pb-24 lg:pb-8',
      // At a desk the identity and the actions become a column of their own and
      // the ledger takes the rest. The ledger's own rule is NOT split — it runs
      // top to bottom inside its column exactly as it does on a phone, which is
      // the constraint the single-column note below is protecting. What changes
      // is that a 1400px page no longer puts a label and its value 1300px apart
      // with nothing in between.
      // 1092 = 340 (identity column) + 32 (gap-8) + 720 (the ledger's readable
      // measure). Capping the GRID rather than the ledger is what keeps the top
      // and bottom the same width: col 2 works out to 720 on its own, and the
      // full-width rows below span exactly the same 1092 without being told a
      // second number that could drift out of step with this one.
      split && 'lg:grid lg:grid-cols-[minmax(280px,340px)_minmax(0,1fr)] lg:items-start lg:gap-8 lg:pb-8 lg:max-w-[1092px]',
    )}>
      {/* Breadcrumbs */}
      <div className={cn(split && 'lg:col-span-2')}>
        <Breadcrumbs items={breadcrumbItems} />
      </div>

      {/* Identity + actions: one column at a desk, sticky so the object you are
          reading about stays on screen while its ledger scrolls. */}
      <div className={cn('flex flex-col gap-4', split && 'lg:sticky lg:top-4')}>

      {/* Identity: the photograph, then the name and the three stamps that
          identify it — code, condition, state. The picture leads because it is
          the fastest way to know you are looking at the right object; the
          ledger below carries everything else. */}
      <div className={cn(
        'animate-fade-up flex items-start gap-3',
        // Stacked at a desk: the column is 340px, so a thumbnail beside a name
        // wastes it. The photograph is the fastest way to know you are looking
        // at the right object, so given room it leads at full width.
        split && 'lg:flex-col lg:gap-3',
      )}>
        {photo ? (
          <button
            type="button"
            onClick={() => setPhotoOpen(true)}
            aria-label="View photo"
            className={cn(
              'shrink-0 rounded-[var(--radius-sm)] overflow-hidden border border-[var(--color-rule)]',
              split ? 'w-full aspect-square h-auto' : 'w-16 h-16',
            )}
          >
            <img src={photo} alt={item.name} className="w-full h-full object-cover" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => photoInput.current?.click()}
            aria-label="Add a photo"
            className={cn(
              'shrink-0 rounded-[var(--radius-sm)] border border-dashed border-[var(--color-text-muted)] flex items-center justify-center text-[var(--color-text-muted)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]',
              split ? 'w-full aspect-square h-auto' : 'w-16 h-16',
            )}
          >
            <Camera className={cn(split ? 'w-8 h-8' : 'w-5 h-5')} />
          </button>
        )}

        {/* On a phone the name sits beside the thumbnail. At a desk it leads
            the ledger instead — see identityText below. */}
        {!split && (
          <div className="min-w-0 flex-1 flex flex-col gap-2">
        <TitleBar className="w-fit max-w-full">{item.name}</TitleBar>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-[11px] text-[var(--color-text-muted)]">{item.qrCode}</span>
          {item.condition && (
            <Badge>{item.condition.charAt(0).toUpperCase() + item.condition.slice(1)}</Badge>
          )}
          {/* 'active' is the unremarkable case, so it gets the plain ink stamp;
              only the states worth noticing take a colour. */}
          <Badge variant={item.status === 'lent' ? 'warning' : item.status === 'active' ? 'default' : 'danger'}>
            {item.status}
          </Badge>
        </div>
        {/* Shown only when it would actually change the name, so it retires
            itself the moment it is used. Quiet by design: a catalogue title is
            ugly, not broken, and the row it names is still perfectly findable. */}
        {item.suggestedName && (
          <button
            type="button"
            disabled={updateItem.isPending}
            onClick={() => updateItem.mutate(
              { id, name: item.suggestedName },
              {
                onSuccess: () => toast.success('Name shortened'),
                onError: (e: Error) => toast.error(e.message || 'Could not rename it'),
              },
            )}
            className="flex items-start gap-1.5 text-left min-h-[32px] font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--color-primary)] disabled:opacity-45"
          >
            <Scissors className="w-3.5 h-3.5 shrink-0 mt-[1px]" />
            <span className="min-w-0">Shorten to “{item.suggestedName}”</span>
          </button>
        )}
          </div>
        )}
      </div>

      {/*
        Actions, in the mockup's order.
        At a desk they all show. The "…" exists because a phone has room for two
        buttons and a menu; a 340px column under the photograph has room for six,
        and hiding Lend, Share, Print and Delete behind a dot menu makes you
        hunt for things the page could simply offer.
      */}
      <div className={cn('gap-2 animate-fade-up', split ? 'grid grid-cols-2' : 'flex')} style={{ animationDelay: '50ms' }}>
        <Button variant="outline" size="sm" className={cn('text-xs', !split && 'flex-1')} onClick={() => setEditOpen(true)}>
          <Pencil className="w-3.5 h-3.5" />
          Edit
        </Button>
        <Button
          variant="outline"
          size="sm"
          className={cn('text-xs', !split && 'flex-1')}
          onClick={() => {
            // Move picks the item UP; the carry banner follows you and any
            // container label you scan puts it down.
            pickUp([{
              id: item.id,
              name: item.name,
              kind: 'item',
              fromContainerId: containerId,
              fromContainerName: breadcrumb?.filter((b) => b.type === 'container').at(-1)?.name ?? undefined,
              // Where it lives now, so the bin picker on /move opens on this
              // area instead of making you drill the whole cascade again.
              fromAreaId: breadcrumb?.find((b) => b.type === 'area')?.id,
            }]);
            // 'scan' is the phone instruction. At a desk the picker is the
            // path and there may be no camera to scan with, so the prompt has
            // to name the thing the user can actually do.
            toast(`Carrying ${item.name} — ${split ? 'choose where it goes' : 'scan where it goes'}`);
            navigate('/move');
          }}
        >
          <ArrowRightLeft className="w-3.5 h-3.5" />
          Move
        </Button>
        {split ? (
          <>
            <Button variant="outline" size="sm" className="text-xs" onClick={() => setLendFormOpen(true)}>
              <HandCoins className="w-3.5 h-3.5" />
              {item.status === 'lent' ? 'Return' : 'Lend'}
            </Button>
            <Button variant="outline" size="sm" className="text-xs" onClick={() => setPrintOpen(true)}>
              <Printer className="w-3.5 h-3.5" />
              Label
            </Button>
            <Button variant="outline" size="sm" className="text-xs" onClick={() => setShareOpen(true)}>
              <Share2 className="w-3.5 h-3.5" />
              Share
            </Button>
            {/* Destructive, so it is last and it is the only one that is red. */}
            <Button variant="outline" size="sm" className="text-xs text-[var(--color-red)] border-[var(--color-red)]" onClick={() => setDeleteOpen(true)}>
              <Trash2 className="w-3.5 h-3.5" />
              Delete
            </Button>
          </>
        ) : (
          <OverflowMenu
            onLend={() => setLendFormOpen(true)}
            lendLabel={item.status === 'lent' ? 'Return' : 'Lend'}
            onShare={() => setShareOpen(true)}
            onPrint={() => setPrintOpen(true)}
            onDelete={() => setDeleteOpen(true)}
          />
        )}
      </div>
      </div>

      {/* The ledger column. Its 720px measure — a receipt line is only legible
          while the label and its value stay within a glance of each other — now
          comes from the grid's cap above, so this column no longer carries a
          width of its own that the rows below it cannot see. */}
      <div className="flex flex-col gap-4">
      {split && identityText}

      {/* THE LEDGER. Every fact on one rule, present or not. An absent fact
          keeps its row and ends in "+ add", so the page states what it could
          still know instead of hiding it behind an empty card. */}
      <div className="flex flex-col animate-fade-up" style={{ animationDelay: '80ms' }}>
        <ColHead action="Edit" onAction={() => setEditOpen(true)}>Details</ColHead>

        {/* 0 is a real answer ("none left"), not a missing one — and QUANTITY
            is NOT NULL in the schema, so this row is never an invitation. */}
        <LedgerRow label="Quantity" value={item.quantity} onEdit={() => setField({ key: 'quantity', label: 'Quantity', kind: 'number' })} />

        <LedgerRow
          label="Condition"
          value={item.condition ? item.condition.charAt(0).toUpperCase() + item.condition.slice(1) : null}
          onEdit={() => setConditionFormOpen(true)}
          onAdd={() => setConditionFormOpen(true)}
        />

        <LedgerRow
          label="Value"
          value={item.purchasePrice != null ? `$${item.purchasePrice.toFixed(2)}` : null}
          onEdit={() => setField({ key: 'purchasePrice', label: 'Value', kind: 'money', hint: 'What you paid for it.' })}
          onAdd={() => setField({ key: 'purchasePrice', label: 'Value', kind: 'money', hint: 'What you paid for it.' })}
        />

        {/* The catalogue's price is a different fact from what YOU paid, so it
            gets its own rule rather than filling in the row above. Value feeds
            the insurance total and every share link; it only ever changes on an
            explicit confirm. Zero is a scrape artefact, not a price. */}
        {item.productRetailPrice != null && item.productRetailPrice > 0 && (
          <LedgerRow
            label="Retail"
            value={`$${item.productRetailPrice.toFixed(2)}`}
            inherited="product"
            onEdit={item.purchasePrice == null ? () => setUseRetailOpen(true) : undefined}
          />
        )}

        {/* Depreciation was only ever shown inside the Value card; as a row it
            survives the rebuild and reads better next to what was paid. */}
        {depreciation && (
          <LedgerRow
            label="Now worth"
            value={`$${depreciation.currentValue.toFixed(2)} · ${depreciation.ratePercent}%/yr`}
            // Derived from the purchase price and the rate, so editing it means
            // editing what it is derived FROM.
            onEdit={() => setField({ key: 'purchasePrice', label: 'Value', kind: 'money', hint: 'What you paid — the depreciated figure follows from it.' })}
          />
        )}

        <LedgerRow
          label="Description"
          value={item.description ?? item.productDescription ?? null}
          inherited={item.description == null && item.productDescription ? 'product' : undefined}
          wrap
          onEdit={() => setField({ key: 'description', label: 'Description', kind: 'multiline' })}
          onAdd={() => setField({ key: 'description', label: 'Description', kind: 'multiline' })}
        />

        {/* Already selected, mapped and typed by getById, so these rows cost
            no extra query. */}
        {item.productBrand && <LedgerRow label="Brand" value={item.productBrand} inherited="product" />}
        {item.productCategory && <LedgerRow label="Category" value={item.productCategory} inherited="product" />}
        {typeof item.productSpecs?.model === 'string' && item.productSpecs.model && (
          <LedgerRow label="Model" value={item.productSpecs.model} inherited="product" />
        )}

        {/* Dates are user-named, so the row shows the soonest one and the
            section below lists the rest when there is more than one. */}
        <LedgerRow
          label={itemDates?.[0]?.dateType || 'Warranty'}
          value={itemDates?.[0] ? new Date(itemDates[0].dateValue).toLocaleDateString() : null}
          onAdd={() => setDateFormOpen(true)}
        />

        <LedgerRow
          label="Lent to"
          value={item.status === 'lent' ? (openLoan?.lentTo ?? 'Someone') : null}
          onEdit={() => setLendFormOpen(true)}
          onAdd={() => setLendFormOpen(true)}
        />

      </div>

      {propertyId > 0 && (
        <Section title="Tags" defaultOpen>
          <div className="py-2">
            <TagPicker entityType="item" entityId={item.id} propertyId={propertyId} />
          </div>
        </Section>
      )}


      </div>

      {/*
        The records, spanning the full width below both columns.
        
        These were stacked under the ledger, which left the page taller than it
        needed to be and the whole area beside the identity column empty. They
        are not part of the ledger's rule — they are separate lists of separate
        things — so they belong out of that column, in the space the two-column
        layout leaves at the bottom.

        auto-fill rather than a fixed count: an item with one file and no loans
        gets one card, not one card and three gaps.
      */}
      <div className={cn(
        // Three, not auto-fill. At 1400px auto-fill gave four ~330px columns, which
        // is narrower than the content wants and reads as a row of strips.
        split && 'lg:col-span-2 grid grid-cols-3 items-start gap-4',
        !split && 'flex flex-col gap-4',
      )}>

      {/* Only things that are genuinely LISTS, and only when they have
          contents. Anything with no rows is already represented in the ledger
          as "+ add". */}


      {/* The soonest date is a ledger row; this is the rest of them. */}
      {(itemDates?.length ?? 0) > 0 && (
        <Section card={split} defaultOpen title="Dates" count={itemDates?.length} action="Add date" onAction={() => setDateFormOpen(true)}>
          <DateList itemId={id} />
        </Section>
      )}

      {hasAccessories && (
        <Section card={split} defaultOpen title="Accessories" count={accessories?.length} action="Link" onAction={() => setAccessoryPickerOpen(true)}>
          <AccessoryList itemId={id} />
        </Section>
      )}

      {/* The OPEN loan is a ledger row ("Lent to"); this is the record. */}
      {hasLending && (
        <Section card={split} defaultOpen title="Lending history" count={lendingHistory?.length}>
          <LendingList itemId={id} itemName={item.name} />
        </Section>
      )}

      {hasConditions && (
        <Section card={split} defaultOpen title="Condition history" count={conditions?.length} action="Record" onAction={() => setConditionFormOpen(true)}>
          <ConditionTimeline itemId={id} />
        </Section>
      )}

      {/* Photos live in the ledger row, so this is receipts, manuals, warranties. */}
      {hasFilesAny && (
        <Section card={split} defaultOpen title="Photos" count={photoCount}>
          <FileList itemId={id} only="photos" />
          <FilesBox id={id} types={['photo']} />
        </Section>
      )}

      {/* Same table, different things: a photo is looked AT, a receipt or a
          manual is opened and read. One list ordered by upload date buries
          whichever you did not come for. */}
      {hasFilesAny && (
        <Section card={split} defaultOpen title="Documents" count={docCount}>
          <FileList itemId={id} only="documents" />
          <FilesBox id={id} types={['receipt', 'warranty', 'manual', 'other']} />
        </Section>
      )}

      {/* Nothing attached at all: one panel and one box, rather than two empty
          headings side by side. */}
      {!hasFilesAny && (
        <Section card={split} defaultOpen title="Files">
          <FilesBox id={id} />
        </Section>
      )}

      {/* Moved out of the ledger column: history is a record of what has
          happened, which is the same kind of thing as the files and dates
          beside it — not a fact about the object like the rows above. */}
      <div className={cn(split && 'rounded-[var(--radius-sm)] border border-[var(--color-rule)] px-3 pb-2 pt-1.5')}>
        <ItemHistory
          itemId={id}
          containerId={containerId}
          containerName={breadcrumb?.filter((b) => b.type === 'container').at(-1)?.name ?? null}
        />
      </div>

      {/* Last on the page: everything above describes THIS object — where it
          is, what it cost, what has happened to it. This describes the product
          it happens to be an instance of, which is the least specific thing
          the page knows and the least often what you came for. */}
      {(item.productName || item.productImageUrl) && (
        <Section card={split} title="Product" defaultOpen>
          <div className="flex items-start gap-3 py-3">
            {item.productImageUrl && (
              <img
                src={item.productImageUrl}
                alt={item.productName || item.name}
                className="w-16 h-16 object-contain rounded-[var(--radius-sm)] bg-[var(--color-elevated)] shrink-0"
              />
            )}
            <div className="min-w-0 flex-1">
              {item.productName && <p className="text-sm font-semibold">{item.productName}</p>}
              {/* Brand and description are ledger rows — the same fact twice
                  on one page reads like two different facts. */}
              {(item.productRetailLinks?.length ?? 0) > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {item.productRetailLinks!.slice(0, 5).map((link, i) => (
                    <a
                      key={i}
                      href={safeExternalUrl(link.url)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 border border-[var(--color-rule)] rounded-[var(--radius-sm)] px-2 min-h-[28px] font-mono text-[10px] uppercase tracking-[0.06em] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]"
                    >
                      <span className="truncate max-w-[110px]">{link.retailer}</span>
                      {link.price != null && <span>${link.price.toFixed(2)}</span>}
                    </a>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Section>
      )}

      {/* One row, one field. The combined form is still behind the page's own
          Edit button, which is where "change several things" belongs. */}
      <FieldDialog
        open={field !== null}
        onOpenChange={(v) => { if (!v) setField(null); }}
        label={field?.label ?? ''}
        kind={field?.kind}
        hint={field?.hint}
        pending={updateItem.isPending}
        value={
          field?.key === 'quantity' ? item.quantity
            : field?.key === 'purchasePrice' ? item.purchasePrice
            : field?.key === 'description' ? (item.description ?? '')
            : ''
        }
        onSave={(next) => {
          if (!field) return;
          const patch =
            field.key === 'quantity' ? { quantity: Math.max(1, Number(next) || 1) }
              : field.key === 'purchasePrice' ? { purchasePrice: next == null ? null : Number(next) }
              : { description: next };
          updateItem.mutate({ id, ...patch }, {
            onSuccess: () => { setField(null); toast.success(`${field.label} saved`); },
            onError: (e: Error) => toast.error(e.message || 'Could not save it'),
          });
        }}
      />
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
          onOpenChange={(o) => { if (!o) { setEditOpen(false); setAdoptDesc(false); } }}
          type="item"
          defaultValues={{
            name: item.name,
            // Pre-filled ONLY when the Description row opened this dialog, so
            // saving there ADOPTS the catalogue text and the row stops being
            // inherited — while an edit to the quantity leaves it alone.
            description: item.description ?? (adoptDesc ? item.productDescription ?? '' : ''),
            quantity: item.quantity,
            purchasePrice: item.purchasePrice ?? '',
            condition: item.condition,
          }}
          isPending={updateItem.isPending}
          onSubmit={async (data) => {
            try {
              // EntityForm strips empty values (it was built for create, where
              // absent means "don't set"). In EDIT, absent means the user
              // CLEARED the field. The description clears to '' rather than
              // NULL: NULL is what makes the row fall back to the catalogue,
              // so a cleared description would immediately reappear.
              const cleared: Record<string, unknown> = {};
              if (!('description' in data)) cleared.description = '';
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

      <ShareDialog
        entityType="item"
        entityId={item.id}
        entityName={item.name}
        isOpen={shareOpen}
        onOpenChange={setShareOpen}
      />

      {/* Forms the ledger rows open. They used to be nested inside the section
          cards; the ledger opens them directly from its "+ add". */}
      <DateForm itemId={id} isOpen={dateFormOpen} onOpenChange={setDateFormOpen} />
      <AccessoryPicker itemId={id} isOpen={accessoryPickerOpen} onOpenChange={setAccessoryPickerOpen} />
      <LendForm itemId={id} isOpen={lendFormOpen} onOpenChange={setLendFormOpen} />
      <ConditionForm itemId={id} isOpen={conditionFormOpen} onOpenChange={setConditionFormOpen} onComplete={() => {}} />

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

      <ConfirmDialog
        open={useRetailOpen}
        onOpenChange={setUseRetailOpen}
        title="Use the retail price?"
        description={
          item.productRetailPrice != null
            ? `Record $${item.productRetailPrice.toFixed(2)} as what you paid for this. It will count towards your insurance and total-value reports, and show on any share link.`
            : ''
        }
        confirmLabel="Use it"
        isPending={updateItem.isPending}
        onConfirm={() => {
          updateItem.mutate(
            { id, purchasePrice: item.productRetailPrice },
            {
              onSuccess: () => { setUseRetailOpen(false); toast('Value set'); },
              onError: (e: Error) => toast(e.message),
            },
          );
        }}
      />
    </div>
  );
}

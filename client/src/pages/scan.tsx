import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Loader2,
  ChevronDown,
  Search,
  Plus,
  Package,
  Box,
  ArrowRight,
  CheckCircle2,
  MoveRight,
  MapPin,
  Printer,
  Smartphone,
  X,
} from 'lucide-react';
import { CameraScanner } from '@/components/scanner/camera-scanner';
import { UrlExtractor } from '@/components/scanner/url-extractor';
import { ScanResult } from '@/components/scanner/scan-result';
import { ProductSearch } from '@/components/scanner/product-search';
import { DuplicateCheck } from '@/components/scanner/duplicate-check';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ColHead } from '@/components/ui/col-head';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import {
  useProperties,
  useAreas,
  useContainers,
  useCreateItem,
  useMoveItem,
} from '@/hooks/use-inventory';
import { cn } from '@/lib/utils';
import { usePrintQueueStore } from '@/store/print-queue-store';
import { useCarryStore } from '@/store/carry-store';
import { useCreatePrintJob, usePrinters } from '@/hooks/use-print';

// -- Tab mode ----------------------------------------------------------------

type TabMode = 'add' | 'move';

// -- Add-mode state machine --------------------------------------------------

type ScanState =
  | 'idle'
  | 'looking_up'
  | 'found'
  | 'not_found'
  | 'adding'
  | 'searching';

interface LookupResult {
  source: string;
  product: Record<string, unknown>;
}

interface DuplicateItem {
  id: number;
  name: string;
  containerName: string;
  areaName: string;
  propertyName: string;
}

// -- Move-mode state machine -------------------------------------------------

type MoveState =
  | 'move_idle'
  | 'move_item_scanned'
  | 'move_container_scanned'
  | 'move_completing';

interface ResolvedEntity {
  type: string;
  id: number;
  name: string;
  exists: boolean;
}

interface CompletedMove {
  itemId: number;
  itemName: string;
  containerId: number;
  containerName: string;
}

const TLY_CODE_REGEX = /^TLY-[PACI]-[0-9A-Fa-f]{4,8}$/;


/**
 * Product titles from the catalogues run long ("… 1 Liter Pump Bottle, Pack of
 * 2"). The label renderer will ellipsize anything, but a 70-character name is
 * unreadable on a 2x1 and useless in a list, so trim to the first sensible
 * clause when auto-filling. The user can always type something longer.
 */
function tidyProductName(raw: string): string {
  const name = raw.trim();
  if (name.length <= 60) return name;
  const cut = name.slice(0, 60);
  const at = Math.max(cut.lastIndexOf(','), cut.lastIndexOf(' - '), cut.lastIndexOf(' '));
  return (at > 24 ? cut.slice(0, at) : cut).trim();
}

export function Scan() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // -- Tab ------------------------------------------------------------------
  const [tab, setTab] = useState<TabMode>('add');

  // -- Add mode state -------------------------------------------------------
  const [state, setState] = useState<ScanState>('idle');
  const [manualBarcode, setManualBarcode] = useState('');
  const [lookupResult, setLookupResult] = useState<LookupResult | null>(null);
  const [duplicates, setDuplicates] = useState<DuplicateItem[]>([]);
  const [showDuplicates, setShowDuplicates] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<Record<string, unknown> | null>(null);
  const [currentBarcode, setCurrentBarcode] = useState<string>('');

  // Add-to-inventory form state
  const [propertyId, setPropertyId] = useState<number>(0);
  const [areaId, setAreaId] = useState<number>(0);
  const [containerId, setContainerId] = useState<number>(0);
  const [itemName, setItemName] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [condition, setCondition] = useState<'new' | 'good' | 'fair' | 'poor'>('good');

  // The container the LAST item landed in — the put-away flow adds ten
  // things to the same bin in a row, and re-picking property→area→container
  // for each one was the slowest part of the loop. Persisted so it survives
  // leaving the page between sessions at the shelf.
  const [lastContainer, setLastContainer] = useState<
    { id: number; name: string; areaId: number; propertyId: number } | null
  >(() => {
    try {
      const raw = localStorage.getItem('tally-last-container');
      const p = raw ? JSON.parse(raw) : null;
      return p && typeof p.id === 'number' && p.id > 0 &&
        typeof p.areaId === 'number' && p.areaId > 0 &&
        typeof p.propertyId === 'number' && p.propertyId > 0 &&
        typeof p.name === 'string' && p.name.length > 0 ? p : null;
    } catch { return null; }
  });

  // True once the user has manually driven the P→A→C cascade this session —
  // suppresses the chip, whose one mid-session appearance (Property change
  // zeroes containerId) would offer to revert the choice they just made.
  const [cascadeTouched, setCascadeTouched] = useState(false);

  // A LIST, not a slot. The camera is live the moment an item is created, so
  // the next barcode entering frame — often the one still in your hand — used
  // to wipe the Print affordance mid-reach. Receipts accumulate for the session.
  const [receipts, setReceipts] = useState<
    { id: number; name: string; qrCode: string; propertyId: number }[]
  >([]);

  // -- Move mode state ------------------------------------------------------
  const [moveState, setMoveState] = useState<MoveState>('move_idle');
  const [moveItem, setMoveItem] = useState<ResolvedEntity | null>(null);
  const [moveContainer, setMoveContainer] = useState<ResolvedEntity | null>(null);
  const [completedMoves, setCompletedMoves] = useState<CompletedMove[]>([]);

  // Data hooks
  const { data: properties } = useProperties();
  const { data: areas } = useAreas(propertyId);
  const { data: containers } = useContainers(areaId);
  const createItem = useCreateItem();
  // named ...Mutation because `moveItem` is the held-item state below
  const moveItemMutation = useMoveItem();
  const carried = useCarryStore((s) => s.carried);
  const recordMove = useCarryStore((s) => s.recordMove);
  // handleBarcodeScanned is memoised and handed to the camera, so it would
  // close over a stale `carried`. A ref keeps the scanner honest.
  const carriedRef = useRef(carried);
  useEffect(() => { carriedRef.current = carried; }, [carried]);

  /**
   * Put the carried items down in the scanned container. Areas resolve to the
   * area's "Loose in <name>" container so a shelf label is never a dead end.
   */
  const completeCarryMove = useCallback(async (code: string) => {
    const load = carriedRef.current;
    try {
      // resolve returns the entity fields at the TOP level of `data`
      // ({ type, id, name, exists }) — not wrapped in { entity }.
      const entity = await api.get<ResolvedEntity>(
        `/api/labels/_x_/resolve/${encodeURIComponent(code)}`,
      );
      if (!entity?.exists) {
        toast.error(`Code ${code} is not in your inventory`);
        return;
      }
      if (entity.type === 'area') {
        // Areas can't hold items directly; a "Loose in <area>" container is the
        // agreed answer but does not exist yet, so say so rather than fail mute.
        toast.error(`${entity.name} is an area — scan a bin inside it`);
        return;
      }
      if (entity.type !== 'container') {
        toast.error('That label is not a bin');
        return;
      }
      // Everything already there is a no-op, not a failure.
      const toMove = load.filter((i) => i.fromContainerId !== entity.id);
      if (toMove.length === 0) {
        toast(`Already in ${entity.name}`);
        return;
      }
      for (const it of toMove) {
        await moveItemMutation.mutateAsync({ id: it.id, containerId: entity.id });
      }
      recordMove({ items: toMove, toContainerId: entity.id, toContainerName: entity.name });
      toast.success(
        toMove.length === 1
          ? `${toMove[0].name} → ${entity.name}`
          : `${toMove.length} items → ${entity.name}`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not move it there');
    }
  }, [moveItemMutation, recordMove]);
  const stageLabel = usePrintQueueStore((st) => st.add);
  const stageMany = usePrintQueueStore((st) => st.addMany);
  const createPrintJob = useCreatePrintJob();
  // Poll for a printer only while a receipt is on screen (that is the only
  // place a Print button exists), and key it to the ADDED item's property.
  const { data: scanPrinters } = usePrinters(receipts[0]?.propertyId || undefined);
  const hasPrinter = !!scanPrinters?.length;

  // -- Context-aware pre-fill from URL params
  // Resolves parent IDs: containerId → areaId + propertyId, areaId → propertyId
  const [contextLoaded, setContextLoaded] = useState(false);
  useEffect(() => {
    if (contextLoaded) return;
    setContextLoaded(true);

    const ctxProperty = Number(searchParams.get('propertyId')) || 0;
    const ctxArea = Number(searchParams.get('areaId')) || 0;
    const ctxContainer = Number(searchParams.get('containerId')) || 0;

    if (ctxProperty) setPropertyId(ctxProperty);
    if (ctxArea) setAreaId(ctxArea);
    if (ctxContainer) setContainerId(ctxContainer);

    // Resolve parent IDs from child if parents not provided
    (async () => {
      try {
        if (ctxContainer && (!ctxArea || !ctxProperty)) {
          const data = await api.get<{ container: { areaId: number; breadcrumb: { id: number; type: string }[] } }>(
            `/api/containers/_x_/${ctxContainer}`
          );
          if (data.container) {
            const propCrumb = data.container.breadcrumb?.find((b: { type: string }) => b.type === 'property');
            if (data.container.areaId) setAreaId(data.container.areaId);
            if (propCrumb?.id) setPropertyId(propCrumb.id);
          }
        } else if (ctxArea && !ctxProperty) {
          const data = await api.get<{ area: { propertyId: number } }>(
            `/api/areas/_x_/${ctxArea}`
          );
          if (data.area?.propertyId) setPropertyId(data.area.propertyId);
        }
      } catch { /* context resolution failed, dropdowns stay empty */ }
    })();
  }, [searchParams, contextLoaded]);

  // -- Add mode handlers ----------------------------------------------------

  // resetFlow restores the current propertyId/areaId/containerId (which may have been resolved from URL params)
  const resetFlow = useCallback(() => {
    setState('idle');
    setLookupResult(null);
    setDuplicates([]);
    setShowDuplicates(false);
    setSelectedProduct(null);
    setCurrentBarcode('');
    // Keep current property/area/container — don't reset location context
    setItemName('');
    setQuantity(1);
    setCondition('good');
  }, []);

  const handleBarcodeScanned = useCallback(async (code: string) => {
    // A new add cycle starts — the previous item's success row has done its
    // job; letting it stack above the form pushes Add Item below the fold.
    // A tally QR is not a product barcode. Scanning the label on one of our
    // own bins used to fall through to the product lookup and dead-end at
    // "No product found" — the only working path was leaving the app for the
    // OS camera. Route TLY codes through the existing resolver instead, which
    // lands on the entity (a container opens straight onto its contents).
    if (TLY_CODE_REGEX.test(code)) {
      // Carrying something? Then a bin label is an ANSWER, not a navigation:
      // resolve it and put the load down. Navigating away here used to destroy
      // the in-flight capture (and would destroy a carry), which made the very
      // gesture the move flow depends on the destructive one.
      if (carriedRef.current.length > 0) {
        void completeCarryMove(code);
        return;
      }
      navigate(`/s/${code}`);
      return;
    }
    setState('looking_up');
    setCurrentBarcode(code);

    try {
      // Minimum 1.5s loading state so user sees the lookup is happening
      const [lookupData, dupeResponse] = await Promise.all([
        api.post<LookupResult>('/api/products/_y_/lookup', { barcode: code }),
        api.post<{ existingItems: DuplicateItem[] }>('/api/products/_y_/check-duplicate', { barcode: code }).catch(() => ({ existingItems: [] })),
        new Promise(r => setTimeout(r, 1500)),
      ]);

      setLookupResult(lookupData);
      setDuplicates(dupeResponse.existingItems || []);

      if (lookupData.source === 'not_found') {
        setState('not_found');
        setLookupResult({ source: 'not_found', product: { barcode: code } });
      } else {
        setState('found');
        if ((dupeResponse.existingItems || []).length > 0) {
          setShowDuplicates(true);
        }
      }
    } catch {
      setState('not_found');
      setLookupResult({ source: 'not_found', product: { barcode: code } });
    }
  }, [navigate]);

  const handleAddToInventory = useCallback((product: Record<string, unknown>) => {
    setSelectedProduct(product);
    setItemName(tidyProductName((product.name as string) || ''));
    setState('adding');
    setShowDuplicates(false);
  }, []);

  const handleSearchManually = useCallback(() => {
    setState('searching');
  }, []);

  const handleProductSelected = useCallback((product: Record<string, unknown>) => {
    setSelectedProduct(product);
    setItemName(tidyProductName((product.name as string) || ''));
    setState('adding');
  }, []);

  const handleCreateManually = useCallback(() => {
    setSelectedProduct(null);
    setItemName('');
    setState('adding');
  }, []);

  const handleSubmitItem = useCallback(async () => {
    if (!containerId || !itemName.trim()) {
      toast.error('Please select a container and enter an item name');
      return;
    }

    try {
      const res = await createItem.mutateAsync({
        name: itemName.trim(),
        containerId,
        quantity,
        condition,
        ...(selectedProduct?.id ? { productId: selectedProduct.id as number } : {}),
      } as Parameters<typeof createItem.mutateAsync>[0]);

      // Remember where this landed for the next add's one-tap chip — from the
      // create response's breadcrumb (authoritative ids AND names), not form
      // state: on the chip's own fast path `containers` hasn't loaded yet, and
      // the URL-context path can have areaId/propertyId still 0.
      const created = res?.item;
      const crumbs = created?.breadcrumb ?? [];
      const propCrumb = crumbs.find((b) => b.type === 'property');
      const areaCrumb = crumbs.find((b) => b.type === 'area');
      const contCrumb = crumbs.find((b) => b.type === 'container');
      if (propCrumb?.id && areaCrumb?.id && contCrumb?.id && contCrumb.name) {
        const dest = {
          id: contCrumb.id, name: contCrumb.name,
          areaId: areaCrumb.id, propertyId: propCrumb.id,
        };
        setLastContainer(dest);
        try { localStorage.setItem('tally-last-container', JSON.stringify(dest)); } catch { /* private mode */ }
      }

      if (created) {
        const receipt = {
          id: created.id, name: created.name, qrCode: created.qrCode,
          propertyId: propCrumb?.id ?? propertyId,
        };
        setReceipts((prev) => [receipt, ...prev]);
      }

      toast.success('Item added!');
      resetFlow();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to add item';
      // The remembered bin is dead (deleted since it was saved) — stop
      // offering it.
      if (lastContainer && containerId === lastContainer.id && /not.?found/i.test(msg)) {
        setLastContainer(null);
        try { localStorage.removeItem('tally-last-container'); } catch { /* ignore */ }
      }
      toast.error(msg);
    }
  }, [containerId, areaId, propertyId, lastContainer, itemName, quantity, condition, selectedProduct, createItem, resetFlow]);

  const handleGoToExisting = useCallback(
    (itemId: number) => {
      navigate(`/item/${itemId}`);
    },
    [navigate]
  );

  // -- Move mode handlers ---------------------------------------------------

  const resetMoveFlow = useCallback(() => {
    setMoveState('move_idle');
    setMoveItem(null);
    setMoveContainer(null);
    setCompletedMoves([]);
  }, []);

  const handleMoveCodeScanned = useCallback(async (code: string) => {
    // Only handle TLY codes in move mode
    if (!TLY_CODE_REGEX.test(code)) return;

    try {
      const entity = await api.get<ResolvedEntity>(`/api/labels/_x_/resolve/${code}`);

      if (!entity.exists) {
        toast.error(`Code ${code} not found in inventory`);
        return;
      }

      if (entity.type === 'item') {
        if (moveState === 'move_container_scanned' && moveContainer) {
          // Batch mode: move item into current container immediately
          setMoveState('move_completing');
          try {
            // Via the mutation, not raw api.patch: the hook invalidates the
            // item/container/area caches. Calling the endpoint directly left
            // the moved item visible in its old container.
            await moveItemMutation.mutateAsync({ id: entity.id, containerId: moveContainer.id });
            const newMove: CompletedMove = {
              itemId: entity.id,
              itemName: entity.name,
              containerId: moveContainer.id,
              containerName: moveContainer.name,
            };
            setCompletedMoves((prev) => [newMove, ...prev]);
            toast.success(`${entity.name} -> ${moveContainer.name}`);
            setMoveState('move_container_scanned');
          } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to move item');
            setMoveState('move_container_scanned');
          }
        } else {
          // Item-first flow: hold item, wait for container
          setMoveItem(entity);
          setMoveState('move_item_scanned');
        }
      } else if (entity.type === 'container') {
        if (moveState === 'move_item_scanned' && moveItem) {
          // Item already scanned -- complete the single move
          setMoveState('move_completing');
          try {
            await moveItemMutation.mutateAsync({ id: moveItem.id, containerId: entity.id });
            const newMove: CompletedMove = {
              itemId: moveItem.id,
              itemName: moveItem.name,
              containerId: entity.id,
              containerName: entity.name,
            };
            setCompletedMoves((prev) => [newMove, ...prev]);
            toast.success(`${moveItem.name} -> ${entity.name}`);
            setMoveItem(null);
            setMoveContainer(null);
            setMoveState('move_idle');
          } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to move item');
            setMoveState('move_item_scanned');
          }
        } else {
          // Container-first flow: enter batch mode
          setMoveContainer(entity);
          setMoveItem(null);
          setMoveState('move_container_scanned');
        }
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to resolve code');
    }
  }, [moveState, moveItem, moveContainer]);

  const isMoveActive =
    moveState === 'move_idle' ||
    moveState === 'move_item_scanned' ||
    moveState === 'move_container_scanned';

  // -- Tab switch -----------------------------------------------------------

  const handleTabChange = useCallback((newTab: TabMode) => {
    setTab(newTab);
    if (newTab === 'add') {
      resetMoveFlow();
    } else {
      resetFlow();
    }
  }, [resetFlow, resetMoveFlow]);

  // -- Move mode status message ---------------------------------------------

  const moveStatusMessage = (() => {
    switch (moveState) {
      case 'move_idle':
        return 'Scan an item or container to start';
      case 'move_item_scanned':
        return 'Now scan the destination container';
      case 'move_container_scanned':
        return moveContainer
          ? `Now scan items to move into ${moveContainer.name}`
          : 'Now scan items to move';
      case 'move_completing':
        return 'Moving...';
    }
  })();

  return (
    <div className="flex flex-col gap-4 px-4 py-4 max-w-lg mx-auto xl:max-w-md">
      {/* Scanning is a phone workflow — you are standing at the shelf with a bin
          in your hands. Desktops usually have no usable camera, and the tab was
          removed from the sidebar for that reason, so anyone who still lands
          here on a big screen gets told where this actually belongs rather than
          a camera that will not focus on a QR label. */}
      <div className="hidden xl:flex items-start gap-2 border-2 border-[var(--color-text)] rounded-[var(--radius-sm)] px-3 py-2.5">
        <Smartphone className="w-4 h-4 shrink-0 mt-0.5" />
        <p className="font-mono text-[11px] uppercase tracking-[0.06em] leading-relaxed text-[var(--color-text-secondary)]">
          Scanning is built for your phone — open tally there to use the camera.
          Manual entry below still works on any device.
        </p>
      </div>

      {/* Mode tabs + Manual search -- compact top bar */}
      <div className="flex flex-col gap-2 animate-fade-up">
        <div className="flex gap-1 p-1 rounded-[var(--radius-lg)] bg-[var(--color-elevated)]">
          <button
            type="button"
            onClick={() => handleTabChange('add')}
            className={cn(
              'flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-[var(--radius-md)] text-sm font-semibold transition-all duration-200 cursor-pointer',
              tab === 'add'
                ? 'bg-[var(--color-card)] text-[var(--color-primary)] shadow-sm'
                : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
            )}
          >
            <Plus className="w-4 h-4" />
            Add Item
          </button>
          <button
            type="button"
            onClick={() => handleTabChange('move')}
            className={cn(
              'flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-[var(--radius-md)] text-sm font-semibold transition-all duration-200 cursor-pointer',
              tab === 'move'
                ? 'bg-[var(--color-card)] text-[var(--color-amber)] shadow-sm'
                : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
            )}
          >
            <MoveRight className="w-4 h-4" />
            Move Item
          </button>
        </div>

        {/* Manual search alternative -- above camera for add mode */}
        {tab === 'add' && state === 'idle' && (
          <button
            type="button"
            className="flex items-center justify-center gap-2 w-full py-2.5 rounded-[var(--radius-lg)] text-sm font-medium text-[var(--color-primary)] bg-[var(--color-primary-bg)] hover:bg-[var(--color-primary-bg)]/80 transition-all duration-200 cursor-pointer"
            onClick={handleSearchManually}
          >
            <Search className="w-4 h-4" />
            Search products manually
          </button>
        )}
      </div>

      {/* -- ADD MODE -------------------------------------------------------- */}
      {tab === 'add' && (
        <>
          {/* Session receipts — a LIST, so the next scan cannot wipe the Print
              affordance out from under your hand. Newest first. */}
          {receipts.length > 0 && (
            <div className="flex flex-col animate-fade-up">
              <ColHead
                action={receipts.length > 1 ? `Queue all ${receipts.length}` : undefined}
                onAction={receipts.length > 1 ? () => {
                  const n = stageMany(receipts.map((r) => ({
                    id: r.id, entityType: 'item' as const, name: r.name,
                    qrCode: r.qrCode, propertyId: r.propertyId || undefined,
                  })));
                  toast.success(n > 0 ? `${n} labels queued` : 'Already queued');
                } : undefined}
              >
                Added this session · {receipts.length}
              </ColHead>
              {receipts.map((r) => (
                <div key={r.id} className="flex items-center gap-2 py-2.5 border-b border-[var(--color-rule)] last:border-b-0">
                  <CheckCircle2 className="w-4 h-4 text-[var(--color-green)] shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold truncate">{r.name}</p>
                    <p className="font-mono text-[10px] text-[var(--color-text-muted)]">{r.qrCode}</p>
                  </div>
                  {hasPrinter && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={createPrintJob.isPending}
                      onClick={() =>
                        createPrintJob.mutate(
                          { entityType: 'item', entityIds: [r.id], preset: 'small',
                            propertyId: r.propertyId || undefined },
                          {
                            onSuccess: (res) => toast.success(res.status === 'held'
                              ? 'Queued — waiting for the 2×1 roll'
                              : 'Printing label'),
                            onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not queue the print'),
                          },
                        )
                      }
                    >
                      <Printer className="w-3.5 h-3.5" />
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      stageLabel({ id: r.id, entityType: 'item', name: r.name,
                        qrCode: r.qrCode, propertyId: r.propertyId || undefined });
                      toast.success('Queued — print from the Print tab');
                    }}
                  >
                    Queue
                  </Button>
                </div>
              ))}
            </div>
          )}
          {/* Camera -- active when idle or looking_up */}
          {(state === 'idle' || state === 'looking_up') && (
            <div className="relative animate-fade-up" style={{ animationDelay: '50ms' }}>
              {/* Camera with corner brackets on video area only */}
              <CameraScanner
                isActive={state === 'idle'}
                onBarcodeScanned={handleBarcodeScanned}
                onClose={() => navigate(-1)}
              />

              {/* Scanning status below camera */}
              <div className="flex items-center justify-center gap-2 mt-3">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--color-primary)] opacity-75" />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-[var(--color-primary)]" />
                </span>
                <p className="text-sm font-medium text-[var(--color-text-secondary)]">
                  {state === 'looking_up' ? 'Looking up barcode...' : 'Scanning for barcodes'}
                </p>
              </div>

              {/* Manual barcode entry — fallback when the camera can't read the
                  code (denied permission, poor lighting, or a damaged label). */}
              {state === 'idle' && (
                <form
                  className="flex gap-2 mt-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const code = manualBarcode.trim();
                    if (!code) return;
                    handleBarcodeScanned(code);
                    setManualBarcode('');
                  }}
                >
                  <Input
                    inputMode="numeric"
                    placeholder="Or type a barcode (UPC/EAN)…"
                    value={manualBarcode}
                    onChange={(e) => setManualBarcode(e.target.value)}
                    className="flex-1"
                  />
                  <Button type="submit" variant="outline" disabled={!manualBarcode.trim()}>
                    Look up
                  </Button>
                </form>
              )}
            </div>
          )}

          {/* Loading overlay */}
          {state === 'looking_up' && (
            <Card className="flex items-center gap-3">
              <Loader2 className="w-5 h-5 text-[var(--color-primary)] animate-spin" />
              <div>
                <p className="text-sm font-medium text-[var(--color-text)]">
                  Looking up barcode...
                </p>
                <p className="text-xs text-[var(--color-text-muted)] font-mono">
                  {currentBarcode}
                </p>
              </div>
            </Card>
          )}

          {/* Scan result */}
          {(state === 'found' || state === 'not_found') && lookupResult && (
            <>
              <ScanResult
                product={lookupResult.product}
                source={lookupResult.source}
                onAddToInventory={handleAddToInventory}
                onSearchManually={handleSearchManually}
                onDismiss={resetFlow}
              />
              <Button variant="ghost" size="sm" onClick={resetFlow}>
                Scan another
              </Button>
            </>
          )}

          {/* Duplicate check dialog */}
          {showDuplicates && duplicates.length > 0 && lookupResult && (
            <DuplicateCheck
              duplicates={duplicates}
              productName={(lookupResult.product.name as string) || 'this item'}
              onAddNew={() => {
                setShowDuplicates(false);
                handleAddToInventory(lookupResult.product);
              }}
              onGoToExisting={handleGoToExisting}
              onClose={() => setShowDuplicates(false)}
            />
          )}

          {/* Manual search mode */}
          {state === 'searching' && (
            <ProductSearch
              onProductSelected={handleProductSelected}
              onCreateManually={handleCreateManually}
              onClose={resetFlow}
            />
          )}

          {/* Adding mode -- container picker + item form */}
          {state === 'adding' && (
            <Card className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <Package className="w-5 h-5 text-[var(--color-primary)]" />
                <h2 className="font-mono text-xs uppercase tracking-[0.1em] font-semibold text-[var(--color-text)]">
                  Add to Inventory
                </h2>
              </div>

              {/* Fields scroll; the submit bar below never leaves the screen.
                  With the whole card scrolling, Add Item lived below the fold
                  on phones — the form's own button was invisible. */}
              <div className="flex flex-col gap-3 max-h-[45dvh] overflow-y-auto -mx-1 px-1 py-1">

              {/* URL paste for product extraction */}
              {!selectedProduct && (
                <UrlExtractor onProductExtracted={(product) => {
                  setSelectedProduct(product);
                  setItemName(tidyProductName((product.name as string) || ''));
                }} />
              )}

              {selectedProduct && (
                <div className="flex items-start gap-2 px-3 py-2 rounded-[var(--radius-md)] bg-[var(--color-elevated)]">
                  {(selectedProduct.imageUrl as string) && (
                    <img src={selectedProduct.imageUrl as string} alt="" className="w-10 h-10 rounded object-cover shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-[var(--color-text)] truncate">
                      {selectedProduct.name as string}
                    </p>
                    {(selectedProduct.brand as string) && (
                      <p className="text-[10px] text-[var(--color-text-muted)]">{selectedProduct.brand as string}</p>
                    )}
                    {(selectedProduct.retailPrice as number) != null && (
                      <p className="text-[10px] text-[var(--color-green)]">${(selectedProduct.retailPrice as number).toFixed(2)}</p>
                    )}
                  </div>
                  <button type="button" onClick={() => { setSelectedProduct(null); setItemName(''); }}
                    className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] p-1 shrink-0">
                    <X className="w-3 h-3" />
                  </button>
                </div>
              )}

              {/* Item name */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-[var(--color-text-secondary)]">
                  Item name
                </label>
                <Input
                  value={itemName}
                  onChange={(e) => setItemName(e.target.value)}
                  placeholder="Enter item name"
                />
              </div>

              {/* One-tap destination: the bin the previous item landed in */}
              {lastContainer && containerId === 0 && !cascadeTouched && (
                <button
                  type="button"
                  onClick={() => {
                    setPropertyId(lastContainer.propertyId);
                    setAreaId(lastContainer.areaId);
                    setContainerId(lastContainer.id);
                  }}
                  className="self-start inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-[var(--color-primary)] text-[var(--color-primary)] text-xs font-medium hover:bg-[var(--color-primary-bg)] transition-colors"
                >
                  <MapPin className="w-3.5 h-3.5" />
                  Add to {lastContainer.name}
                </button>
              )}

              {/* Property select */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-[var(--color-text-secondary)]">
                  Property
                </label>
                <div className="relative">
                  <select
                    value={propertyId}
                    onChange={(e) => {
                      setCascadeTouched(true);
                      setPropertyId(Number(e.target.value));
                      setAreaId(0);
                      setContainerId(0);
                    }}
                    className="w-full appearance-none bg-[var(--color-card)] border border-[var(--color-border)] rounded-[var(--radius-md)] px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:ring-offset-1 cursor-pointer transition-shadow duration-200"
                  >
                    <option value={0}>Select property...</option>
                    {properties?.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)] pointer-events-none" />
                </div>
              </div>

              {/* Area select */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-[var(--color-text-secondary)]">
                  Area
                </label>
                <div className="relative">
                  <select
                    value={areaId}
                    onChange={(e) => {
                      setCascadeTouched(true);
                      setAreaId(Number(e.target.value));
                      setContainerId(0);
                    }}
                    disabled={!propertyId}
                    className="w-full appearance-none bg-[var(--color-card)] border border-[var(--color-border)] rounded-[var(--radius-md)] px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-shadow duration-200"
                  >
                    <option value={0}>Select area...</option>
                    {areas?.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)] pointer-events-none" />
                </div>
              </div>

              {/* Container select */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-[var(--color-text-secondary)]">
                  Container
                </label>
                <div className="relative">
                  <select
                    value={containerId}
                    onChange={(e) => { setCascadeTouched(true); setContainerId(Number(e.target.value)); }}
                    disabled={!areaId}
                    className="w-full appearance-none bg-[var(--color-card)] border border-[var(--color-border)] rounded-[var(--radius-md)] px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-shadow duration-200"
                  >
                    <option value={0}>Select container...</option>
                    {containers?.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)] pointer-events-none" />
                </div>
              </div>

              {/* Quantity + condition row */}
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-[var(--color-text-secondary)]">
                    Quantity
                  </label>
                  <Input
                    type="number"
                    min={1}
                    value={quantity}
                    onChange={(e) => setQuantity(Number(e.target.value) || 1)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-[var(--color-text-secondary)]">
                    Condition
                  </label>
                  <div className="relative">
                    <select
                      value={condition}
                      onChange={(e) => setCondition(e.target.value as typeof condition)}
                      className="w-full appearance-none bg-[var(--color-card)] border border-[var(--color-border)] rounded-[var(--radius-md)] px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:ring-offset-1 cursor-pointer transition-shadow duration-200"
                    >
                      <option value="new">New</option>
                      <option value="good">Good</option>
                      <option value="fair">Fair</option>
                      <option value="poor">Poor</option>
                    </select>
                    <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)] pointer-events-none" />
                  </div>
                </div>
              </div>

              </div>

              {/* Actions — outside the scroll area, always visible */}
              <div className="flex gap-2 pt-2 border-t border-[var(--color-border)]">
                <Button
                  className="flex-1"
                  disabled={!containerId || !itemName.trim() || createItem.isPending}
                  onClick={handleSubmitItem}
                >
                  {createItem.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Plus className="w-4 h-4" />
                  )}
                  Add Item
                </Button>
                <Button variant="outline" onClick={resetFlow}>
                  Cancel
                </Button>
              </div>
            </Card>
          )}
        </>
      )}

      {/* -- MOVE MODE ------------------------------------------------------- */}
      {tab === 'move' && (
        <>
          {/* Camera -- active whenever in move mode (except while completing) */}
          <div className="relative rounded-2xl overflow-hidden animate-fade-up" style={{ animationDelay: '50ms' }}>
            <CameraScanner
              isActive={isMoveActive}
              onBarcodeScanned={handleMoveCodeScanned}
              onClose={() => navigate(-1)}
            />
            {/* Corner bracket overlays */}
            <div className="absolute top-3 left-3 w-6 h-6 border-t-[3px] border-l-[3px] border-[var(--color-amber)] rounded-tl-sm pointer-events-none" />
            <div className="absolute top-3 right-3 w-6 h-6 border-t-[3px] border-r-[3px] border-[var(--color-amber)] rounded-tr-sm pointer-events-none" />
            <div className="absolute bottom-3 left-3 w-6 h-6 border-b-[3px] border-l-[3px] border-[var(--color-amber)] rounded-bl-sm pointer-events-none" />
            <div className="absolute bottom-3 right-3 w-6 h-6 border-b-[3px] border-r-[3px] border-[var(--color-amber)] rounded-br-sm pointer-events-none" />
          </div>

          {/* Status banner below camera */}
          <div className="flex items-center justify-center gap-2 mt-1 mb-1">
            <span className="relative flex h-2.5 w-2.5">
              <span className={cn(
                'animate-ping absolute inline-flex h-full w-full rounded-full opacity-75',
                moveState === 'move_idle' ? 'bg-[var(--color-text-muted)]' : 'bg-[var(--color-amber)]'
              )} />
              <span className={cn(
                'relative inline-flex rounded-full h-2.5 w-2.5',
                moveState === 'move_idle' ? 'bg-[var(--color-text-muted)]' : 'bg-[var(--color-amber)]'
              )} />
            </span>
            <p className="text-sm font-medium text-[var(--color-text-secondary)]">
              {moveStatusMessage}
            </p>
          </div>

          {/* Context panel -- shown when something is in buffer */}
          {(moveState === 'move_item_scanned' || moveState === 'move_container_scanned') && (
            <Card className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-[var(--color-text-secondary)] uppercase tracking-wide">
                  Current context
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setMoveItem(null);
                    setMoveContainer(null);
                    setMoveState('move_idle');
                  }}
                  className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] cursor-pointer transition-colors duration-150"
                >
                  Clear
                </button>
              </div>

              {moveState === 'move_item_scanned' && moveItem && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-[var(--radius-md)] bg-[var(--color-amber-bg)] border border-[var(--color-amber)]">
                  <Box className="w-4 h-4 text-[var(--color-amber)] shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-[var(--color-text)] truncate">
                      {moveItem.name}
                    </p>
                    <p className="text-xs text-[var(--color-text-muted)]">
                      item -- scan a container to move it
                    </p>
                  </div>
                  <ArrowRight className="w-4 h-4 text-[var(--color-amber)] shrink-0" />
                  <span className="text-xs text-[var(--color-text-muted)]">?</span>
                </div>
              )}

              {moveState === 'move_container_scanned' && moveContainer && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-[var(--radius-md)] bg-[var(--color-amber-bg)] border border-[var(--color-amber)]">
                  <Package className="w-4 h-4 text-[var(--color-amber)] shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-[var(--color-text)] truncate">
                      Moving to: {moveContainer.name}
                    </p>
                    <p className="text-xs text-[var(--color-text-muted)]">
                      container -- scan items to move in
                    </p>
                  </div>
                </div>
              )}

              {moveState === 'move_container_scanned' && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setMoveContainer(null);
                    setMoveState('move_idle');
                  }}
                  className="border-[var(--color-amber)] text-[var(--color-amber)] hover:bg-[var(--color-amber-bg)]"
                >
                  Done -- exit batch mode
                </Button>
              )}
            </Card>
          )}

          {/* Completed moves list */}
          {completedMoves.length > 0 && (
            <Card className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-[var(--color-text-secondary)] uppercase tracking-wide">
                  Completed moves ({completedMoves.length})
                </p>
                <button
                  type="button"
                  onClick={() => setCompletedMoves([])}
                  className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] cursor-pointer transition-colors duration-150"
                >
                  Clear
                </button>
              </div>
              <ul className="flex flex-col gap-2">
                {completedMoves.map((move, i) => (
                  <li
                    key={`${move.itemId}-${move.containerId}-${i}`}
                    className="flex items-center gap-2 text-sm animate-fade-up"
                    style={{ animationDelay: `${i * 30}ms` }}
                  >
                    <CheckCircle2 className="w-4 h-4 text-[var(--color-green)] shrink-0" />
                    <span className="text-[var(--color-text)] truncate flex-1 min-w-0">
                      {move.itemName}
                    </span>
                    <ArrowRight className="w-3.5 h-3.5 text-[var(--color-text-muted)] shrink-0" />
                    <span className="text-[var(--color-text-muted)] truncate max-w-[120px]">
                      {move.containerName}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {/* Reset button when idle with no history */}
          {moveState === 'move_idle' && completedMoves.length === 0 && (
            <p className="text-center text-sm text-[var(--color-text-muted)] py-2">
              Point the camera at a TLY QR code to start
            </p>
          )}
        </>
      )}
    </div>
  );
}

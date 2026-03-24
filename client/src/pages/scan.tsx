import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ScanLine,
  Loader2,
  ChevronDown,
  Search,
  Plus,
  Package,
} from 'lucide-react';
import { CameraScanner } from '@/components/scanner/camera-scanner';
import { ScanResult } from '@/components/scanner/scan-result';
import { ProductSearch } from '@/components/scanner/product-search';
import { DuplicateCheck } from '@/components/scanner/duplicate-check';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import {
  useProperties,
  useAreas,
  useContainers,
  useCreateItem,
} from '@/hooks/use-inventory';

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

export function Scan() {
  const navigate = useNavigate();

  // State machine
  const [state, setState] = useState<ScanState>('idle');
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

  // Data hooks
  const { data: properties } = useProperties();
  const { data: areas } = useAreas(propertyId);
  const { data: containers } = useContainers(areaId);
  const createItem = useCreateItem();

  const resetFlow = useCallback(() => {
    setState('idle');
    setLookupResult(null);
    setDuplicates([]);
    setShowDuplicates(false);
    setSelectedProduct(null);
    setCurrentBarcode('');
    setPropertyId(0);
    setAreaId(0);
    setContainerId(0);
    setItemName('');
    setQuantity(1);
    setCondition('good');
  }, []);

  const handleBarcodeScanned = useCallback(async (code: string) => {
    setState('looking_up');
    setCurrentBarcode(code);

    try {
      const [lookupData, dupeData] = await Promise.all([
        api.post<LookupResult>('/api/products/_y_/lookup', { barcode: code }),
        api.post<DuplicateItem[]>('/api/products/_y_/check-duplicate', { barcode: code }).catch(() => [] as DuplicateItem[]),
      ]);

      setLookupResult(lookupData);
      setDuplicates(dupeData);

      if (lookupData.source === 'not_found') {
        setState('not_found');
        setLookupResult({ source: 'not_found', product: { barcode: code } });
      } else {
        setState('found');
        if (dupeData.length > 0) {
          setShowDuplicates(true);
        }
      }
    } catch {
      setState('not_found');
      setLookupResult({ source: 'not_found', product: { barcode: code } });
    }
  }, []);

  const handleAddToInventory = useCallback((product: Record<string, unknown>) => {
    setSelectedProduct(product);
    setItemName((product.name as string) || '');
    setState('adding');
    setShowDuplicates(false);
  }, []);

  const handleSearchManually = useCallback(() => {
    setState('searching');
  }, []);

  const handleProductSelected = useCallback((product: Record<string, unknown>) => {
    setSelectedProduct(product);
    setItemName((product.name as string) || '');
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
      await createItem.mutateAsync({
        name: itemName.trim(),
        containerId,
        quantity,
        condition,
        ...(selectedProduct?.id ? { productId: selectedProduct.id as number } : {}),
      } as Parameters<typeof createItem.mutateAsync>[0]);

      toast.success('Item added!');
      resetFlow();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add item');
    }
  }, [containerId, itemName, quantity, condition, selectedProduct, createItem, resetFlow]);

  const handleGoToExisting = useCallback(
    (itemId: number) => {
      navigate(`/item/${itemId}`);
    },
    [navigate]
  );

  return (
    <div className="flex flex-col gap-4 px-4 py-4 max-w-lg mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="flex items-center justify-center w-10 h-10 rounded-full bg-[var(--color-primary-bg)]">
          <ScanLine className="w-5 h-5 text-[var(--color-primary)]" />
        </div>
        <div>
          <h1 className="text-lg font-bold text-[var(--color-text)]">Scanner</h1>
          <p className="text-xs text-[var(--color-text-muted)]">
            Scan barcodes to look up and add items
          </p>
        </div>
      </div>

      {/* Camera — active when idle or looking_up */}
      {(state === 'idle' || state === 'looking_up') && (
        <CameraScanner
          isActive={state === 'idle'}
          onBarcodeScanned={handleBarcodeScanned}
          onClose={() => navigate(-1)}
        />
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

      {/* Adding mode — container picker + item form */}
      {state === 'adding' && (
        <Card className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <Package className="w-5 h-5 text-[var(--color-primary)]" />
            <h2 className="text-base font-semibold text-[var(--color-text)]">
              Add to Inventory
            </h2>
          </div>

          {selectedProduct && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-[var(--radius-md)] bg-[var(--color-elevated)]">
              <p className="text-xs text-[var(--color-text-secondary)] truncate">
                Product: {selectedProduct.name as string}
              </p>
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

          {/* Property select */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-[var(--color-text-secondary)]">
              Property
            </label>
            <div className="relative">
              <select
                value={propertyId}
                onChange={(e) => {
                  setPropertyId(Number(e.target.value));
                  setAreaId(0);
                  setContainerId(0);
                }}
                className="w-full appearance-none bg-[var(--color-card)] border border-[var(--color-border)] rounded-[var(--radius-md)] px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:ring-offset-1 cursor-pointer"
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
                  setAreaId(Number(e.target.value));
                  setContainerId(0);
                }}
                disabled={!propertyId}
                className="w-full appearance-none bg-[var(--color-card)] border border-[var(--color-border)] rounded-[var(--radius-md)] px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
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
                onChange={(e) => setContainerId(Number(e.target.value))}
                disabled={!areaId}
                className="w-full appearance-none bg-[var(--color-card)] border border-[var(--color-border)] rounded-[var(--radius-md)] px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
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
                  className="w-full appearance-none bg-[var(--color-card)] border border-[var(--color-border)] rounded-[var(--radius-md)] px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:ring-offset-1 cursor-pointer"
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

          {/* Actions */}
          <div className="flex gap-2 pt-2">
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

      {/* Quick actions when idle */}
      {state === 'idle' && (
        <button
          type="button"
          className="flex items-center justify-center gap-2 w-full py-3 border border-dashed border-[var(--color-border)] rounded-[var(--radius-md)] text-sm text-[var(--color-primary)] hover:bg-[var(--color-primary-bg)] transition-colors cursor-pointer"
          onClick={handleSearchManually}
        >
          <Search className="w-4 h-4" />
          Search products manually
        </button>
      )}
    </div>
  );
}

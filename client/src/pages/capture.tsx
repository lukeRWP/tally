import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { Camera, ScanLine, Check, X, Printer, Plus, MapPin, SkipForward } from 'lucide-react';
import { CameraScanner } from '@/components/scanner/camera-scanner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ColHead } from '@/components/ui/col-head';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useCreateItem } from '@/hooks/use-inventory';
import { useUploadFile } from '@/hooks/use-files';
import { usePrinters, useCreatePrintJob } from '@/hooks/use-print';
import { usePrintQueueStore } from '@/store/print-queue-store';
import { cn } from '@/lib/utils';

/**
 * The capture flow: PICTURE → SCAN → SCAN → DONE.
 *
 * One continuous camera session. The photo captures the thing, the product
 * barcode names it, the bin label files it — and the bin then stays pinned so
 * the second item is only picture + scan.
 *
 * Two rules make it a loop instead of a wizard:
 *  1. Steps are TARGETS, not gates. Any code is accepted at any time and routed
 *     by its shape (TLY → destination, UPC/EAN → product), so you can point the
 *     camera at whatever is nearest.
 *  2. Nothing is mandatory. No barcode → type it or leave it unnamed. No label
 *     on the bin → pick from recents. The commit needs a container and a name,
 *     and the flow synthesises a name rather than blocking.
 *
 * The photo is held as a Blob and uploaded AFTER the item exists — item_files
 * has an FK to the item and the upload route 404s without one. So "picture
 * first" is a gesture ordering, not a durability guarantee: this is stated in
 * the UI rather than pretended away.
 */

const TLY_CODE_REGEX = /^TLY-[PACI]-[0-9A-Fa-f]{4,8}$/;
const DEST_KEY = 'tally-last-container';

interface Destination {
  id: number;
  name: string;
  areaId?: number;
  propertyId?: number;
}

interface Draft {
  name: string;
  barcode?: string;
  productId?: number;
  photo?: Blob;
  photoUrl?: string;
}

interface Receipt {
  id: number;
  name: string;
  qrCode: string;
  propertyId?: number;
  photoFailed?: boolean;
}

type Phase = 'photo' | 'identify' | 'place';

/** Downscale to keep uploads small on garage wifi (and dodge the 20MB cap). */
async function downscale(file: File, max = 1600): Promise<Blob> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size < 1_500_000) return file;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b ?? file), 'image/jpeg', 0.82),
  );
}

function tidyName(raw: string): string {
  const name = raw.trim();
  if (name.length <= 60) return name;
  const cut = name.slice(0, 60);
  const at = Math.max(cut.lastIndexOf(','), cut.lastIndexOf(' '));
  return (at > 24 ? cut.slice(0, at) : cut).trim();
}

export function Capture() {
  const navigate = useNavigate();
  const photoInput = React.useRef<HTMLInputElement>(null);

  const [dest, setDest] = React.useState<Destination | null>(() => {
    try {
      const raw = localStorage.getItem(DEST_KEY);
      const p = raw ? JSON.parse(raw) : null;
      return p && typeof p.id === 'number' && p.id > 0 ? p : null;
    } catch { return null; }
  });
  const [phase, setPhase] = React.useState<Phase>('photo');
  const [draft, setDraft] = React.useState<Draft>({ name: '' });
  const [receipts, setReceipts] = React.useState<Receipt[]>([]);
  const [busy, setBusy] = React.useState<string | null>(null);

  const createItem = useCreateItem();
  const uploadFile = useUploadFile();
  const createPrintJob = useCreatePrintJob();
  const stage = usePrintQueueStore((s) => s.add);
  const { data: printers } = usePrinters(receipts[0]?.propertyId || undefined);
  const hasPrinter = !!printers?.length;

  // The scanner callback is handed to the camera once, so it must not close
  // over stale state.
  const stateRef = React.useRef({ dest, draft, phase });
  React.useEffect(() => { stateRef.current = { dest, draft, phase }; }, [dest, draft, phase]);

  function pinDestination(d: Destination) {
    setDest(d);
    try { localStorage.setItem(DEST_KEY, JSON.stringify(d)); } catch { /* private mode */ }
  }

  async function commit(d: Draft, destination: Destination) {
    const name = d.name.trim() || (d.barcode ? `Item ${d.barcode}` : 'Untitled item');
    setBusy('Saving…');
    try {
      const res = await createItem.mutateAsync({
        name,
        containerId: destination.id,
        ...(d.productId ? { productId: d.productId } : {}),
      } as Parameters<typeof createItem.mutateAsync>[0]);
      const created = res?.item;
      if (!created) throw new Error('Create returned no item');

      const receipt: Receipt = {
        id: created.id,
        name: created.name,
        qrCode: created.qrCode,
        propertyId: (created as unknown as { breadcrumb?: { id: number; type: string }[] })
          .breadcrumb?.find((b) => b.type === 'property')?.id,
      };

      // Photo second — the item must exist for the upload route to accept it.
      if (d.photo) {
        setBusy('Uploading photo…');
        try {
          await uploadFile.mutateAsync({
            itemId: created.id,
            file: new File([d.photo], `capture-${created.id}.jpg`, { type: 'image/jpeg' }),
            fileType: 'photo',
          });
        } catch {
          receipt.photoFailed = true; // the item is saved; only the photo failed
        }
      }

      setReceipts((prev) => [receipt, ...prev]);
      setDraft({ name: '' });
      setPhase('photo');
      toast.success(`${created.name} → ${destination.name}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the item');
    } finally {
      setBusy(null);
    }
  }

  const handleCode = React.useCallback(async (code: string) => {
    const { dest: curDest, draft: curDraft } = stateRef.current;

    // Rule 1: route by code shape, not by which step we think we're on.
    if (TLY_CODE_REGEX.test(code)) {
      try {
        const entity = await api.get<{ type: string; id: number; name: string; exists: boolean }>(
          `/api/labels/_x_/resolve/${encodeURIComponent(code)}`,
        );
        if (!entity?.exists) { toast.error('That label is not in your inventory'); return; }
        if (entity.type === 'area') {
          toast(`${entity.name} is an area — scan a bin inside it`);
          return;
        }
        if (entity.type !== 'container') { toast.error('That is not a bin label'); return; }
        pinDestination({ id: entity.id, name: entity.name });
        toast.success(`Adding to ${entity.name}`);
        // If a draft is already waiting on a home, this completes it.
        if (curDraft.name || curDraft.photo || curDraft.barcode) {
          void commit(curDraft, { id: entity.id, name: entity.name });
        } else {
          setPhase('photo');
        }
      } catch {
        toast.error('Could not read that label');
      }
      return;
    }

    // Otherwise it is a product barcode.
    setBusy('Looking it up…');
    try {
      const result = await api.post<{ product?: { id?: number; name?: string } | null }>(
        '/api/products/_y_/lookup', { barcode: code },
      );
      const product = result?.product;
      const next: Draft = {
        ...curDraft,
        barcode: code,
        name: product?.name ? tidyName(product.name) : curDraft.name,
        productId: product?.id,
      };
      setDraft(next);
      if (product?.name && curDest) {
        // Named and homed: commit straight away — this is what makes it a loop.
        void commit(next, curDest);
      } else {
        setPhase(curDest ? 'identify' : 'place');
        if (!product?.name) toast('No match — name it yourself');
      }
    } catch {
      setDraft((d) => ({ ...d, barcode: code }));
      setPhase('identify');
      toast('Lookup failed — the barcode was kept');
    } finally {
      setBusy(null);
    }
  }, [createItem, uploadFile]); // eslint-disable-line react-hooks/exhaustive-deps

  async function onPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const blob = await downscale(file);
    setDraft((d) => ({ ...d, photo: blob, photoUrl: URL.createObjectURL(blob) }));
    setPhase('identify');
  }

  const step = phase === 'photo' ? 1 : phase === 'identify' ? 2 : 3;

  return (
    <div className="flex flex-col gap-3 p-4 pb-28 max-w-lg mx-auto">
      {/* progress + destination */}
      <div className="flex items-center gap-2">
        {[1, 2, 3].map((n) => (
          <span key={n} className={cn('h-[3px] w-5 rounded-full',
            n < step ? 'bg-[var(--color-text)]' : n === step ? 'bg-[var(--color-primary)]' : 'bg-[var(--color-border)]')} />
        ))}
        <span className="flex-1" />
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
          step {step} of 3
        </span>
      </div>

      <button
        type="button"
        onClick={() => setPhase('place')}
        className={cn('flex items-center gap-2 rounded-[var(--radius-sm)] border-2 px-3 py-2 text-left',
          dest ? 'border-[var(--color-text)]' : 'border-dashed border-[var(--color-primary)]')}
      >
        <MapPin className="w-4 h-4 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
            {dest ? 'adding to' : 'no bin chosen'}
          </span>
          <span className="block text-sm font-semibold truncate">
            {dest ? dest.name : 'Scan a bin label, or pick one'}
          </span>
        </span>
        <span className="font-mono text-[10px] uppercase text-[var(--color-primary)]">change</span>
      </button>

      {/* the draft being built */}
      {(draft.photoUrl || draft.name || draft.barcode) && (
        <div className="flex items-center gap-2 border border-[var(--color-rule)] rounded-[var(--radius-sm)] p-2">
          {draft.photoUrl
            ? <img src={draft.photoUrl} alt="" className="w-11 h-11 rounded-[var(--radius-sm)] object-cover" />
            : <span className="w-11 h-11 rounded-[var(--radius-sm)] border border-dashed border-[var(--color-rule)]" />}
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold truncate">{draft.name || 'Unnamed'}</span>
            {draft.barcode && <span className="block font-mono text-[10px] text-[var(--color-text-muted)]">{draft.barcode}</span>}
            {draft.photo && (
              <span className="block font-mono text-[9px] uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
                photo held — saves with the item
              </span>
            )}
          </span>
          <button type="button" aria-label="Discard" onClick={() => { setDraft({ name: '' }); setPhase('photo'); }}
            className="min-w-[36px] min-h-[36px] flex items-center justify-center text-[var(--color-text-muted)]">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {busy && (
        <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--color-primary)] text-center">{busy}</p>
      )}

      {/* ── step 1: the picture ─────────────────────────────────────────── */}
      {phase === 'photo' && (
        <div className="flex flex-col gap-2">
          <input ref={photoInput} type="file" accept="image/*" capture="environment"
            className="hidden" onChange={onPhoto} />
          <button type="button" onClick={() => photoInput.current?.click()}
            className="flex flex-col items-center justify-center gap-2 border-2 border-[var(--color-text)] rounded-[var(--radius-sm)] py-10">
            <Camera className="w-8 h-8" />
            <span className="font-mono text-xs uppercase tracking-[0.1em] font-bold">Take the picture</span>
            <span className="font-mono text-[10px] text-[var(--color-text-muted)]">the only step you can't do later</span>
          </button>
          <Button variant="ghost" size="sm" onClick={() => setPhase('identify')}>
            <SkipForward className="w-3.5 h-3.5" />
            Skip photo
          </Button>
        </div>
      )}

      {/* ── step 2/3: the camera hunts codes ────────────────────────────── */}
      {(phase === 'identify' || phase === 'place') && (
        <div className="flex flex-col gap-2">
          <CameraScanner isActive onBarcodeScanned={handleCode} onClose={() => navigate(-1)} />
          <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-muted)] text-center">
            {phase === 'identify' ? 'Find the product barcode' : 'Scan the bin label'}
            {' · '}either works
          </p>

          {phase === 'identify' && (
            <div className="flex gap-2">
              <Input placeholder="Or type a name…" value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
              <Button size="sm" disabled={!dest || !!busy}
                onClick={() => dest && commit(draft, dest)}>
                <Check className="w-4 h-4" />
                Add
              </Button>
            </div>
          )}

          {phase === 'place' && (
            <Button variant="outline" size="sm" onClick={() => navigate('/scan')}>
              <ScanLine className="w-4 h-4" />
              Pick a bin manually
            </Button>
          )}
        </div>
      )}

      {/* ── receipts ─────────────────────────────────────────────────────── */}
      {receipts.length > 0 && (
        <div className="flex flex-col">
          <ColHead>Added this session · {receipts.length}</ColHead>
          {receipts.map((r) => (
            <div key={r.id} className="flex items-center gap-2 py-2.5 border-b border-[var(--color-rule)] last:border-b-0">
              <Check className="w-4 h-4 text-[var(--color-green)] shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold truncate">{r.name}</span>
                <span className="block font-mono text-[10px] text-[var(--color-text-muted)]">
                  {r.qrCode}{r.photoFailed ? ' · photo failed' : ''}
                </span>
              </span>
              {hasPrinter && (
                <Button size="sm" variant="outline"
                  onClick={() => createPrintJob.mutate(
                    { entityType: 'item', entityIds: [r.id], preset: 'small', propertyId: r.propertyId },
                    { onSuccess: () => toast.success('Printing label'),
                      onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not print') })}>
                  <Printer className="w-3.5 h-3.5" />
                </Button>
              )}
              <Button size="sm" variant="outline"
                onClick={() => { stage({ id: r.id, entityType: 'item', name: r.name, qrCode: r.qrCode, propertyId: r.propertyId }); toast.success('Queued'); }}>
                Queue
              </Button>
            </div>
          ))}
          <Button className="mt-3" onClick={() => { setDraft({ name: '' }); setPhase('photo'); }}>
            <Plus className="w-4 h-4" />
            Add another
          </Button>
        </div>
      )}
    </div>
  );
}

export default Capture;

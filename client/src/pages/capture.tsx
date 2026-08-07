import * as React from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Camera, Check, X, Printer, Plus, MapPin, SkipForward, List, AlertTriangle } from 'lucide-react';
import { CameraScanner } from '@/components/scanner/camera-scanner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ColHead } from '@/components/ui/col-head';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { findOrCreateLooseContainer } from '@/hooks/use-put-down';
import { useCreateItem, useProperties, useAreas, useContainers } from '@/hooks/use-inventory';
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
 *
 * This is the app's primary create surface (the centre nav button), so it has
 * to carry what that implies: a keyboard-only path to a destination, duplicate
 * warnings before you add a second of something, and an answer for labels that
 * are not destinations at all.
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

/** An item you already own with this barcode — shown before you add another. */
interface Dupe {
  id: number;
  name: string;
  containerName: string;
  areaName: string;
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
  const [params] = useSearchParams();
  const photoInput = React.useRef<HTMLInputElement>(null);

  const [dest, setDest] = React.useState<Destination | null>(() => {
    try {
      const raw = localStorage.getItem(DEST_KEY);
      const p = raw ? JSON.parse(raw) : null;
      return p && typeof p.id === 'number' && p.id > 0 ? p : null;
    } catch { return null; }
  });
  /**
   * Whether the destination was chosen IN THIS SESSION (scanned, picked, or
   * carried in from the page you tapped Add on) rather than merely remembered
   * from last time.
   *
   * The loop — "item two is just picture + scan" — depends on committing the
   * moment a product barcode resolves. But that is only right once you have
   * actually told the flow where you are standing. Treating a leftover
   * localStorage bin as an answer silently filed items into whatever tote you
   * used days ago and skipped the scan-the-bin step entirely.
   */
  const [destConfirmed, setDestConfirmed] = React.useState(false);
  const [phase, setPhase] = React.useState<Phase>('photo');
  const [picking, setPicking] = React.useState(false);
  const [dupes, setDupes] = React.useState<Dupe[]>([]);
  const [draft, setDraft] = React.useState<Draft>({ name: '' });
  const [receipts, setReceipts] = React.useState<Receipt[]>([]);
  const [busy, setBusy] = React.useState<string | null>(null);

  // The picker is the keyboard path to a destination: no label on the bin, no
  // camera, or simply knowing where it goes. Seeded from wherever you tapped Add.
  const [pickProperty, setPickProperty] = React.useState(0);
  const [pickArea, setPickArea] = React.useState(0);
  const { data: pickProperties } = useProperties();
  const { data: pickAreas } = useAreas(pickProperty);
  const { data: pickContainers } = useContainers(pickArea);

  const createItem = useCreateItem();
  const uploadFile = useUploadFile();
  const createPrintJob = useCreatePrintJob();
  const stage = usePrintQueueStore((s) => s.add);
  const stageMany = usePrintQueueStore((s) => s.addMany);
  const { data: printers } = usePrinters(receipts[0]?.propertyId || undefined);
  const hasPrinter = !!printers?.length;

  // The scanner callback is handed to the camera once, so it must not close
  // over stale state.
  const stateRef = React.useRef({ dest, draft, phase, destConfirmed });
  React.useEffect(() => { stateRef.current = { dest, draft, phase, destConfirmed }; }, [dest, draft, phase, destConfirmed]);

  // Where you were standing when you tapped Add. A container pre-pins outright;
  // an area or property only seeds the picker, because "somewhere in the garage"
  // is not a place an item can live.
  const ctxContainer = Number(params.get('containerId')) || 0;
  const ctxArea = Number(params.get('areaId')) || 0;
  const ctxProperty = Number(params.get('propertyId')) || 0;

  React.useEffect(() => {
    if (!ctxContainer) return;
    let cancelled = false;
    (async () => {
      try {
        const { container } = await api.get<{ container: Destination & { areaId: number } }>(
          `/api/containers/_x_/${ctxContainer}`,
        );
        if (cancelled || !container?.id) return;
        pinDestination({ id: container.id, name: container.name, areaId: container.areaId });
      } catch { /* fall back to whatever was pinned before */ }
    })();
    return () => { cancelled = true; };
  }, [ctxContainer]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    if (ctxArea) setPickArea(ctxArea);
    if (ctxProperty) setPickProperty(ctxProperty);
  }, [ctxArea, ctxProperty]);

  // One property is the common case; pre-select it so the picker opens on areas.
  React.useEffect(() => {
    if (!pickProperty && pickProperties?.length === 1) setPickProperty(pickProperties[0].id);
  }, [pickProperties, pickProperty]);

  // An area arriving without its property leaves the cascade blank, so backfill.
  React.useEffect(() => {
    if (!ctxArea || pickProperty) return;
    (async () => {
      try {
        const { area } = await api.get<{ area: { propertyId: number } }>(`/api/areas/_x_/${ctxArea}`);
        if (area?.propertyId) setPickProperty(area.propertyId);
      } catch { /* the picker still works, it just starts at the property step */ }
    })();
  }, [ctxArea, pickProperty]);

  // The picker belongs to the "where does this go" step. Any path that leaves
  // that step — scanning a bin, committing, discarding the draft, starting the
  // next item — must take the panel with it, or it strands itself open
  // underneath "Take the picture" with its selects still live.
  React.useEffect(() => {
    if (phase !== 'place') setPicking(false);
  }, [phase]);

  function pinDestination(d: Destination) {
    setDest(d);
    setDestConfirmed(true);
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
      // The warning belongs to the draft that just landed, not to the next one —
      // leaving it up would claim you already own something you haven't scanned.
      setDupes([]);
      setPhase('photo');
      toast.success(`${created.name} → ${destination.name}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the item');
    } finally {
      setBusy(null);
    }
  }

  const handleCode = React.useCallback(async (code: string) => {
    const { dest: curDest, draft: curDraft, destConfirmed: curConfirmed } = stateRef.current;

    // Rule 1: route by code shape, not by which step we think we're on.
    if (TLY_CODE_REGEX.test(code)) {
      try {
        const entity = await api.get<{ type: string; id: number; name: string; exists: boolean }>(
          `/api/labels/_x_/resolve/${encodeURIComponent(code)}`,
        );
        if (!entity?.exists) { toast.error('That label is not in your inventory'); return; }
        // An item or property label is not somewhere an item can go — but the
        // user clearly pointed at it on purpose, so treat it as "show me this"
        // rather than an error. That keeps scan-to-look-up alive inside the
        // flow that now owns the thumb button.
        if (entity.type === 'item' || entity.type === 'property') {
          navigate(`/s/${encodeURIComponent(code)}`);
          return;
        }
        if (entity.type !== 'container' && entity.type !== 'area') {
          toast.error('That label is not in your inventory');
          return;
        }
        // An area label is a valid answer to "where does this go" — items just
        // can't live in an area directly, so it resolves to the area's
        // catch-all bin (created on first use).
        const target = entity.type === 'area'
          ? await findOrCreateLooseContainer(entity.id, entity.name).then(
              (c) => ({ id: c.id, name: c.name }))
          : { id: entity.id, name: entity.name };
        pinDestination(target);
        toast.success(`Adding to ${target.name}`);
        // If a draft is already waiting on a home, this completes it.
        if (curDraft.name || curDraft.photo || curDraft.barcode) {
          void commit(curDraft, target);
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
      // Ask both questions at once: what is this, and do I already own one?
      // Without the second, the primary add flow would silently grow duplicates.
      const [result, dup] = await Promise.all([
        api.post<{ product?: { id?: number; name?: string } | null }>(
          '/api/products/_y_/lookup', { barcode: code },
        ),
        api.post<{ existingItems: Dupe[] }>(
          '/api/products/_y_/check-duplicate', { barcode: code },
        ).catch(() => ({ existingItems: [] as Dupe[] })),
      ]);
      setDupes(dup?.existingItems ?? []);
      const product = result?.product;
      const next: Draft = {
        ...curDraft,
        barcode: code,
        name: product?.name ? tidyName(product.name) : curDraft.name,
        productId: product?.id,
      };
      setDraft(next);
      if (product?.name && curDest && curConfirmed) {
        // Named and homed: commit straight away — this is what makes it a loop.
        void commit(next, curDest);
      } else {
        // Named but not homed yet: go to the step that asks where it goes,
        // which is the whole point of scan → scan → done.
        setPhase('place');
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

      {/* Where it goes. A destination confirmed in this session is a statement;
          one merely remembered from last time is an offer, and must look like
          one — the difference is the whole bug this drawing fixes. */}
      <div className={cn('flex items-center gap-2 rounded-[var(--radius-sm)] border-2 px-3 py-2',
        dest && destConfirmed ? 'border-[var(--color-text)]' : 'border-dashed border-[var(--color-primary)]')}
      >
        <MapPin className="w-4 h-4 shrink-0" />
        <button type="button" onClick={() => setPhase('place')} className="min-w-0 flex-1 text-left">
          <span className="block font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
            {!dest ? 'no bin chosen' : destConfirmed ? 'adding to' : 'last used'}
          </span>
          <span className="block text-sm font-semibold truncate">
            {dest ? dest.name : 'Scan a bin or area label'}
          </span>
        </button>
        {dest && !destConfirmed ? (
          <button
            type="button"
            onClick={() => setDestConfirmed(true)}
            className="shrink-0 bg-[var(--color-primary)] text-white rounded-[var(--radius-sm)] px-2.5 min-h-[32px] font-mono text-[10px] font-bold uppercase tracking-[0.06em]"
          >
            Still here
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setPhase('place')}
            className="shrink-0 font-mono text-[10px] uppercase text-[var(--color-primary)] px-1 min-h-[32px]"
          >
            change
          </button>
        )}
      </div>

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
          <button type="button" aria-label="Discard" onClick={() => { setDraft({ name: '' }); setDupes([]); setPhase('photo'); }}
            className="min-w-[36px] min-h-[36px] flex items-center justify-center text-[var(--color-text-muted)]">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {dupes.length > 0 && (
        <div className="flex items-start gap-2 border-2 border-[var(--color-amber)] rounded-[var(--radius-sm)] p-2.5">
          <AlertTriangle className="w-4 h-4 shrink-0 text-[var(--color-amber)] mt-0.5" />
          <span className="min-w-0 flex-1">
            <span className="block font-mono text-[10px] uppercase tracking-[0.1em] font-bold text-[var(--color-amber)]">
              you already have {dupes.length === 1 ? 'one of these' : `${dupes.length} of these`}
            </span>
            {dupes.slice(0, 3).map((d) => (
              <button key={d.id} type="button" onClick={() => navigate(`/item/${d.id}`)}
                className="block w-full text-left text-sm truncate underline decoration-dotted">
                {d.name}
                <span className="font-mono text-[10px] text-[var(--color-text-muted)]">
                  {' · '}{[d.areaName, d.containerName].filter(Boolean).join(' › ')}
                </span>
              </button>
            ))}
            <span className="block font-mono text-[9px] uppercase tracking-[0.06em] text-[var(--color-text-muted)] mt-0.5">
              adding another is fine — this is a heads-up, not a block
            </span>
          </span>
          <button type="button" aria-label="Dismiss" onClick={() => setDupes([])}
            className="min-w-[32px] min-h-[32px] flex items-center justify-center text-[var(--color-text-muted)]">
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
            {phase === 'identify' ? 'Find the product barcode' : 'Scan the bin or area label'}
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

          {phase === 'place' && !picking && (
            <Button variant="outline" size="sm" onClick={() => setPicking(true)}>
              <List className="w-4 h-4" />
              Pick a bin from the list
            </Button>
          )}
        </div>
      )}

      {/* ── the keyboard path to a destination ──────────────────────────── */}
      {picking && (
        <div className="flex flex-col gap-2 border-2 border-[var(--color-text)] rounded-[var(--radius-sm)] p-3">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] font-bold">Choose a bin</span>
            <button type="button" aria-label="Close" onClick={() => setPicking(false)}
              className="min-w-[32px] min-h-[32px] flex items-center justify-center text-[var(--color-text-muted)]">
              <X className="w-4 h-4" />
            </button>
          </div>

          {(pickProperties?.length ?? 0) > 1 && (
            <select value={pickProperty} onChange={(e) => { setPickProperty(Number(e.target.value)); setPickArea(0); }}
              className="w-full min-h-[40px] px-2 rounded-[var(--radius-sm)] border border-[var(--color-rule)] bg-[var(--color-bg)] text-sm">
              <option value={0}>Property…</option>
              {pickProperties?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}

          <select value={pickArea} onChange={(e) => setPickArea(Number(e.target.value))} disabled={!pickProperty}
            className="w-full min-h-[40px] px-2 rounded-[var(--radius-sm)] border border-[var(--color-rule)] bg-[var(--color-bg)] text-sm disabled:opacity-50">
            <option value={0}>Area…</option>
            {pickAreas?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>

          {pickArea > 0 && (
            (pickContainers?.length ?? 0) === 0 ? (
              <p className="font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--color-text-muted)] py-2">
                No bins in this area yet — scan its area label to file loose
              </p>
            ) : (
              <div className="flex flex-col max-h-56 overflow-y-auto">
                {pickContainers?.map((c) => (
                  <button key={c.id} type="button"
                    onClick={() => {
                      pinDestination({ id: c.id, name: c.name, areaId: c.areaId });
                      setPicking(false);
                      toast.success(`Adding to ${c.name}`);
                      const d = stateRef.current.draft;
                      if (d.name || d.photo || d.barcode) void commit(d, { id: c.id, name: c.name, areaId: c.areaId });
                      else setPhase('photo');
                    }}
                    className="flex items-center gap-2 py-2.5 border-b border-[var(--color-rule)] last:border-b-0 text-left">
                    <MapPin className="w-3.5 h-3.5 shrink-0 text-[var(--color-text-muted)]" />
                    <span className="min-w-0 flex-1 text-sm font-medium truncate">{c.name}</span>
                    <span className="font-mono text-[10px] text-[var(--color-text-muted)]">{c.itemCount ?? 0}</span>
                  </button>
                ))}
              </div>
            )
          )}
        </div>
      )}

      {/* ── receipts ─────────────────────────────────────────────────────── */}
      {receipts.length > 0 && (
        <div className="flex flex-col">
          <ColHead
            action={receipts.length > 1 ? `Queue all ${receipts.length}` : undefined}
            onAction={() => {
              // addMany dedupes and returns how many were NEWLY staged. Report
              // that, not the number asked for — queueing the same receipts
              // twice stages nothing, and saying "Queued 5" would be a lie.
              const n = stageMany(receipts.map((r) => ({
                id: r.id, entityType: 'item' as const, name: r.name, qrCode: r.qrCode, propertyId: r.propertyId,
              })));
              toast.success(n > 0 ? `${n} labels queued` : 'Already queued');
            }}
          >
            Added this session · {receipts.length}
          </ColHead>
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
          <Button className="mt-3" onClick={() => { setDraft({ name: '' }); setDupes([]); setPhase('photo'); }}>
            <Plus className="w-4 h-4" />
            Add another
          </Button>
        </div>
      )}
    </div>
  );
}

export default Capture;

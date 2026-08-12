import * as React from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Camera, Check, X, Printer, Plus, MapPin, SkipForward, List, AlertTriangle, Search } from 'lucide-react';
import { ProductScanner } from '@/components/scanner/product-scanner';
import { TagScanner } from '@/components/scanner/tag-scanner';
import { ProductSearch } from '@/components/scanner/product-search';
import { UrlExtractor } from '@/components/scanner/url-extractor';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ColHead } from '@/components/ui/col-head';
import { toast } from '@/components/ui/toast';
import { api, getCsrfToken, parseEnvelope } from '@/lib/api';
import { findOrCreateLooseContainer } from '@/hooks/use-put-down';
import { DestinationPicker } from '@/components/inventory/destination-picker';
import { useCreateItem } from '@/hooks/use-inventory';
import { useUploadFile } from '@/hooks/use-files';
import { usePrinters, useCreatePrintJob } from '@/hooks/use-print';
import { usePrintQueueStore } from '@/store/print-queue-store';
import { cn } from '@/lib/utils';
import { extractTlyCode } from '@/lib/tly';
import { useVisionPref } from '@/store/vision-store';
import { decideSuggestion } from '@/lib/vision-decision';

/**
 * The capture flow: PICTURE → SCAN → SCAN → DONE.
 *
 * The photo captures the thing, the product barcode names it, the tag files
 * it. All three steps run for every item.
 *
 * Step 3 is the one that cannot be skipped. Identifying something says WHAT it
 * is and never where it belongs, so nothing is written until it has been put
 * somewhere — an item that appears in a bin nobody chose for it is worse than
 * one more tap, and the tote in front of you is rarely the tote from an hour
 * ago. A remembered bin is a shortcut for ANSWERING step 3 (one tap on a
 * recent chip), never a reason to skip past it.
 *
 * Each step uses the scanner that matches its question: step 2 decodes UPC/EAN
 * only, step 3 QR only. A scanner that cannot read the other kind cannot
 * mistake one job for the other. (This replaced an earlier rule where one
 * scanner read everything and the page routed by the code's shape — it made
 * both steps able to swallow the other's input.)
 *
 * Within a step nothing is mandatory. No photo → skip it. No barcode → type a
 * name, search the catalogue, or paste a link. No tag on the tote → tap a
 * recent one or pick from the list. The commit needs a container and a name,
 * and the flow synthesises a name rather than blocking.
 *
 * The photo is held as a Blob and uploaded AFTER the item exists — item_files
 * has an FK to the item and the upload route 404s without one. So "picture
 * first" is a gesture ordering, not a durability guarantee: this is stated in
 * the UI rather than pretended away. A photo can also be added later from the
 * item page, which is why this step no longer claims otherwise.
 *
 * This is the app's primary create surface (the centre nav button), so it has
 * to carry what that implies: a keyboard-only path to a destination, duplicate
 * warnings before you add a second of something, and an answer for labels that
 * are not destinations at all.
 */

const DEST_KEY = 'tally-last-container';
/** How many recent bins to offer at step 3. Three fits one row at 390px. */
const RECENTS = 3;

/**
 * The remembered destinations, newest first.
 *
 * The key used to hold a single object; a value written by an older build is
 * read as a one-entry list rather than thrown away, so nobody loses the bin
 * they were working out of when this ships.
 */
function readRecents(): Destination[] {
  try {
    const raw = localStorage.getItem(DEST_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    return list.filter((d) => d && typeof d.id === 'number' && d.id > 0).slice(0, RECENTS);
  } catch { return []; }
}

interface Destination {
  id: number;
  name: string;
  areaId?: number;
  propertyId?: number;
}

interface Draft {
  name: string;
  /**
   * The catalogue title before shortening — kept only for the case where the
   * lookup could NOT be saved to the catalogue, so PRODUCT_ID will be null and
   * nothing else in the database will ever hold these words.
   */
  fullName?: string;
  barcode?: string;
  productId?: number;
  photo?: Blob;
  photoUrl?: string;
  /** Free text the user accepted. Only ever set by tapping Keep. */
  description?: string;
  /**
   * Becomes a property-scoped tag on save. Not a column on items. Only ever set
   * by tapping Keep — a guess must not arrive here on its own.
   */
  category?: string;
  /**
   * Reaches items.CURRENT_VALUE, which the insurance report reads. Only ever
   * set by tapping Keep, and always shown as an estimate.
   */
  currentValue?: number;
  quantity?: number;
}

/**
 * What the photo-identification endpoint offered.
 *
 * Deliberately NOT part of Draft, and deliberately not passed to commit().
 * commit() takes a Draft and writes what is in it, so a suggestion the user has
 * not accepted is unreachable from the write path structurally — because the
 * value is not in the object commit() receives, rather than because a rule says
 * not to read it. Accepting a field copies it into the Draft; that copy is the
 * consent.
 */
interface Vision {
  name: string | null;
  description: string | null;
  category: string | null;
  brand: string | null;
  quantity: number | null;
  /** Rough replacement cost. Never auto-applied — see the review panel. */
  estimatedValue: number | null;
  confidence: 'high' | 'medium' | 'low';
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

export function Capture() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const photoInput = React.useRef<HTMLInputElement>(null);
  const nameField = React.useRef<HTMLInputElement>(null);

  const [recents, setRecents] = React.useState<Destination[]>(readRecents);
  const [dest, setDest] = React.useState<Destination | null>(() => readRecents()[0] ?? null);
  /**
   * Whether the destination was chosen IN THIS SESSION (scanned, picked, or
   * carried in from the page you tapped Add on) rather than merely remembered
   * from last time.
   *
   * It decides how step 3 PRESENTS a bin, not whether step 3 runs: a confirmed
   * bin reads "adding to", a remembered one reads "last used" and has to be
   * tapped before it counts. Either way the item is not written until someone
   * answers the question on that step.
   */
  const [destConfirmed, setDestConfirmed] = React.useState(false);
  const [phase, setPhase] = React.useState<Phase>('photo');
  const [picking, setPicking] = React.useState(false);
  // Step 2 without a usable barcode: search the catalogue or paste a link.
  const [identifying, setIdentifying] = React.useState(false);
  const [dupes, setDupes] = React.useState<Dupe[]>([]);
  const [draft, setDraft] = React.useState<Draft>({ name: '' });
  const [receipts, setReceipts] = React.useState<Receipt[]>([]);
  const [busy, setBusy] = React.useState<string | null>(null);

  // See the Vision type: held apart from draft on purpose.
  const [vision, setVision] = React.useState<Vision | null>(null);
  const [visionPending, setVisionPending] = React.useState(false);
  // The name is the one field allowed to pre-fill, so it is the one field that
  // needs to look unconfirmed until someone has actually looked at it.
  const [nameIsSuggested, setNameIsSuggested] = React.useState(false);
  const [reviewOpen, setReviewOpen] = React.useState(false);
  /**
   * Set the moment a barcode resolves to a real catalogue product.
   *
   * A ref, not state: the vision request is in flight when this flips, and its
   * callback needs the CURRENT answer, not the value captured when it started.
   */
  const catalogueHit = React.useRef(false);
  // A failed identify used to be indistinguishable from a disabled feature and
  // from an honest 'cannot tell'. All three showed nothing.
  const [visionFailed, setVisionFailed] = React.useState(false);
  // The model was asked and had nothing useful to say. Distinct from failure
  // (the request broke) and from the feature being off (nothing was asked).
  const [visionEmpty, setVisionEmpty] = React.useState(false);

  /**
   * Clear everything belonging to the item just finished (or abandoned).
   *
   * A helper rather than three inline resets because the suggestion is the easy
   * one to forget: leaving it set would offer the previous object's description
   * on the next photo, which reads as the feature confidently misidentifying
   * something it never saw.
   */
  function resetDraft() {
    setDraft({ name: '' });
    setDupes([]);
    setVision(null);
    setVisionPending(false);
    setNameIsSuggested(false);
    setReviewOpen(false);
    setVisionFailed(false);
    setVisionEmpty(false);
    catalogueHit.current = false;
  }

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

  // The picker belongs to the "where does this go" step. Any path that leaves
  // that step — scanning a bin, committing, discarding the draft, starting the
  // next item — must take the panel with it, or it strands itself open
  // underneath "Take the picture" with its selects still live.
  React.useEffect(() => {
    if (phase !== 'place') setPicking(false);
    if (phase !== 'identify') setIdentifying(false);
  }, [phase]);

  function adoptProduct(product: Record<string, unknown>) {
    // shortName is the catalogue title with the sales copy taken off. Nothing
    // is lost: the full title stays on the product row and the item page shows
    // it under "Product".
    const short = typeof product.shortName === 'string' ? product.shortName : '';
    const full = typeof product.name === 'string' ? product.name : '';
    const id = typeof product.id === 'number' ? product.id : undefined;
    setDraft((d) => ({
      ...d,
      name: short || full || d.name,
      fullName: id ? undefined : full,
      productId: id ?? d.productId,
      barcode: typeof product.barcode === 'string' && product.barcode ? product.barcode : d.barcode,
    }));
    setIdentifying(false);
  }

  function pinDestination(d: Destination) {
    setDest(d);
    setDestConfirmed(true);
    // Newest first, no duplicates, capped — a most-recently-used list.
    setRecents((prev) => {
      const next = [d, ...prev.filter((r) => r.id !== d.id)].slice(0, RECENTS);
      try { localStorage.setItem(DEST_KEY, JSON.stringify(next)); } catch { /* private mode */ }
      return next;
    });
  }

  async function commit(d: Draft, destination: Destination) {
    const name = d.name.trim() || (d.barcode ? `Item ${d.barcode}` : 'Untitled item');
    // Without a product row there is nothing to inherit from and no way back —
    // items has no BARCODE column. Whatever the scan did learn rides along as
    // the description so it stays searchable (ft_items_search covers NAME and
    // DESCRIPTION) rather than surviving only by disfiguring the title.
    const kept = !d.productId
      ? [d.fullName && d.fullName !== name ? d.fullName : null,
         d.barcode ? `UPC ${d.barcode}` : null].filter(Boolean).join('\n')
      : '';
    // An accepted description leads; what the scan salvaged follows it. Both
    // are already in the draft, so neither can be here without consent.
    const description = [d.description || null, kept || null].filter(Boolean).join('\n');
    setBusy('Saving…');
    try {
      const res = await createItem.mutateAsync({
        name,
        containerId: destination.id,
        ...(d.productId ? { productId: d.productId } : {}),
        ...(description ? { description } : {}),
        // Its own field, never folded into the description text. The server
        // validates it against a closed enum and turns it into a
        // property-scoped tag.
        ...(d.category ? { category: d.category } : {}),
        ...(d.quantity != null ? { quantity: d.quantity } : {}),
        // An estimate the user explicitly accepted. It is the only AI-derived
        // number that reaches a money column, so it travels only when kept.
        ...(d.currentValue != null ? { currentValue: d.currentValue } : {}),
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
      // The warning (and the suggestion) belong to the draft that just landed,
      // not to the next one — leaving either up would claim something about an
      // object that has not been photographed yet.
      resetDraft();
      setPhase('photo');
      toast.success(`${created.name} → ${destination.name}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the item');
    } finally {
      setBusy(null);
    }
  }

  const handleCode = React.useCallback(async (code: string) => {
    // Deliberately no draft snapshot here. Both branches below await a network
    // round trip before they use the draft, so each one re-reads it from
    // stateRef at the point of use.

    // Rule 1: route by code shape, not by which step we think we're on.
    // extractTlyCode also unwraps the /s/<code> URL our printed labels encode.
    const tlyCode = extractTlyCode(code);
    if (tlyCode) {
      try {
        const entity = await api.get<{ type: string; id: number; name: string; exists: boolean }>(
          `/api/labels/_x_/resolve/${encodeURIComponent(tlyCode)}`,
        );
        if (!entity?.exists) { toast.error('That label is not in your inventory'); return; }
        // An item or property label is not somewhere an item can go — but the
        // user clearly pointed at it on purpose, so treat it as "show me this"
        // rather than an error. That keeps scan-to-look-up alive inside the
        // flow that now owns the thumb button.
        if (entity.type === 'item' || entity.type === 'property') {
          navigate(`/s/${encodeURIComponent(tlyCode)}`);
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
        // Read the draft fresh: the resolve round trip above is long enough for
        // the user to have typed a name, and committing the snapshot taken
        // before the await silently discards whatever they entered.
        const live = stateRef.current.draft;
        // If a draft is already waiting on a home, this completes it.
        if (live.name || live.photo || live.barcode) {
          void commit(live, target);
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
        api.post<{ product?: { id?: number; name?: string; shortName?: string } | null }>(
          '/api/products/_y_/lookup', { barcode: code },
        ),
        api.post<{ existingItems: Dupe[] }>(
          '/api/products/_y_/check-duplicate', { barcode: code },
        ).catch(() => ({ existingItems: [] as Dupe[] })),
      ]);
      setDupes(dup?.existingItems ?? []);
      const product = result?.product;
      // Same reason as the label branch above — spreading the pre-await
      // snapshot would wipe anything typed while the lookup was in flight.
      const live = stateRef.current.draft;
      const next: Draft = {
        ...live,
        barcode: code,
        name: product?.shortName || product?.name || live.name,
        fullName: product?.id ? undefined : product?.name,
        productId: product?.id,
      };
      setDraft(next);
      if (product?.name) {
        // A catalogue hit is a fact about this exact object; the photo guess is
        // an inference about what it looks like. Drop the guess rather than
        // offering the user a choice between a real record and a plausible one.
        // Anything already accepted stays — it is in the draft, not here.
        catalogueHit.current = true;
        setVision(null);
        setReviewOpen(false);
        setNameIsSuggested(false);
        // A barcode says WHAT the thing is, never where it goes. Every item
        // earns its place by being put somewhere on step 3 — a pinned bin is a
        // shortcut for answering that question, not a reason to skip it.
        setPhase('place');
      } else {
        // Half the household is not in any catalogue. Telling someone to name
        // a thing and then taking the field away leaves the barcode standing
        // in as the title, which is how items end up called "Item 036000…".
        toast('Not in the catalogue — name it yourself');
        nameField.current?.focus();
      }
    } catch {
      setDraft((d) => ({ ...d, barcode: code }));
      setPhase('identify');
      toast('Lookup failed — the barcode was kept');
    } finally {
      setBusy(null);
    }
  }, [createItem, uploadFile]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Ask what the photo shows. Fired unawaited: the answer is a convenience, and
   * the flow must reach step 2 at the same speed whether or not it arrives — or
   * ever arrives. Every failure path here is a no-op, never a toast: the user
   * did not ask for this, so it cannot interrupt them by failing.
   */
  /**
   * The vision route accepts jpeg/png/webp only, and rejects anything else with
   * a 415 before spending a token. downscale() has three paths that hand back
   * the ORIGINAL File untouched — bitmap decode failure, the small-image
   * passthrough, and toBlob returning null — and on iOS `accept="image/*"` can
   * hand us HEIC. So the blob reaching here is not reliably a jpeg.
   *
   * Re-encode when the type is not one the route takes. The item photo upload
   * is a different route with a different accept list, which is why that path
   * never surfaced this.
   */
  async function asSendableImage(blob: Blob): Promise<Blob> {
    if (['image/jpeg', 'image/png', 'image/webp'].includes(blob.type)) return blob;
    const bitmap = await createImageBitmap(blob).catch(() => null);
    if (!bitmap) return blob;   // let the server reject it and say so
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
    return new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b ?? blob), 'image/jpeg', 0.82),
    );
  }

  /**
   * Ask what the photo shows. Fired unawaited: the answer is a convenience, and
   * the flow must reach step 2 at the same speed whether or not it arrives.
   *
   * Failures do not interrupt — no toast, nothing blocking — but they are no
   * longer invisible. Swallowing every error made "feature off", "model
   * declined", and "request rejected" render identically as nothing at all,
   * which cost two sessions of diagnosis.
   */
  async function identifyPhoto(blob: Blob) {
    // Checked here rather than at the call site so every future caller inherits
    // it. Switched off means no request, no upload, no spend — not a request
    // whose answer is discarded.
    if (!useVisionPref.getState().enabled) return;
    setVisionPending(true);
    setVisionFailed(false);
    setVisionEmpty(false);
    try {
      const sendable = await asSendableImage(blob);
      const form = new FormData();
      form.append('file', sendable, 'photo.jpg');
      // Raw fetch (FormData) — attach CSRF manually; no Content-Type so the
      // browser sets the multipart boundary itself.
      const csrf = getCsrfToken();
      const res = await fetch('/api/products/_y_/identify-photo', {
        method: 'POST',
        credentials: 'include',
        headers: csrf ? { 'x-csrf-token': csrf } : undefined,
        body: form,
      });
      if (!res.ok) {
        console.warn('[vision] identify failed', res.status, blob.type, sendable.type);
        setVisionFailed(true);
        return;
      }
      const data = await parseEnvelope<{ available: boolean; suggestion: Vision | null }>(res);
      if (!data?.suggestion) {
        // Two very different things used to look the same here, and telling
        // them apart from the outside cost hours: the feature being switched
        // off (nothing was asked) versus the model being asked and having
        // nothing useful to say. Only the second is worth reporting — but it
        // IS worth reporting, because silence reads as "it didn't run".
        console.info('[vision] no suggestion', { available: data?.available });
        if (data?.available) setVisionEmpty(true);
        return;
      }

      const s = data.suggestion;

      // The rule lives in lib/vision-decision, tested there. Both inputs are
      // read from refs rather than from values captured when the request
      // started — the whole point is that either can change mid-flight.
      const { accept, applyName } = decideSuggestion({
        catalogueHit: catalogueHit.current,
        currentName: stateRef.current.draft.name,
        suggestedName: s.name,
      });
      if (!accept) return;

      setVision(s);
      if (applyName) {
        // The guard is repeated inside the updater as the last line of defence:
        // the decision above is a read, this is the invariant.
        setDraft((d) => (d.name.trim() ? d : { ...d, name: s.name as string }));
        setNameIsSuggested(true);
      }
    } catch (err) {
      console.warn('[vision] identify threw', err);
      setVisionFailed(true);
    } finally {
      setVisionPending(false);
    }
  }

  async function onPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const blob = await downscale(file);
    setDraft((d) => ({ ...d, photo: blob, photoUrl: URL.createObjectURL(blob) }));
    setPhase('identify');
    // Not awaited: step 2 is already on screen and the camera scanner is live.
    void identifyPhoto(blob);
  }

  const step = phase === 'photo' ? 1 : phase === 'identify' ? 2 : 3;

  /**
   * Step 2 answers "what is this?"; step 3 answers "where does it go?". The
   * second question is never assumed — nothing is filed until it is put
   * somewhere on step 3, so an item cannot land in a bin nobody named for it.
   *
   * A photo or a barcode identifies a thing as well as a typed name does —
   * commit() names the unnamed rather than refusing them.
   */
  const identified = !!(draft.name.trim() || draft.barcode || draft.photo);
  function finishIdentifying() {
    if (busy || !identified) return;
    setPhase('place');
  }

  return (
    <div className="flex flex-col gap-3 max-w-lg mx-auto h-full">
      {/* progress + destination */}
      <div className="flex items-center gap-2 shrink-0">
        {[1, 2, 3].map((n) => (
          <span key={n} className={cn('h-[3px] rounded-full transition-all duration-300 ease-out',
            n === step ? 'w-8 bg-[var(--color-primary)]' : 'w-5',
            n < step ? 'bg-[var(--color-text)]' : n > step ? 'bg-[var(--color-border)]' : '')} />
        ))}
        <span className="flex-1" />
        <span key={phase} className="animate-step-in font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
          <b className="text-[var(--color-text)]">{step}/3</b>{' '}
          {phase === 'photo' ? 'picture' : phase === 'identify' ? 'identify' : 'place'}
        </span>
      </div>

      {/* the draft being built */}
      {(draft.photoUrl || draft.name || draft.barcode) && (
        <div className="flex items-center gap-2 border border-[var(--color-rule)] rounded-[var(--radius-sm)] p-2 shrink-0">
          {draft.photoUrl
            ? <img src={draft.photoUrl} alt="" className="w-11 h-11 rounded-[var(--radius-sm)] object-cover" />
            : <span className="w-11 h-11 rounded-[var(--radius-sm)] border border-dashed border-[var(--color-rule)]" />}
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold truncate">{draft.name || 'Unnamed'}</span>
            {draft.barcode && <span className="block font-mono text-[10px] text-[var(--color-text-muted)]">{draft.barcode}</span>}
            {draft.photo && (
              <span className="block font-mono text-[9px] uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
                {visionPending ? 'photo held — looking at it…'
                  : visionFailed ? "photo held — couldn't read it"
                  : visionEmpty ? 'photo held — nothing recognised'
                  : vision ? `photo held — ${vision.confidence === 'high' ? 'read' : 'guessed'} from the photo`
                  : 'photo held — saves with the item'}
              </span>
            )}
            {vision && (vision.description || vision.category || vision.brand
              || vision.estimatedValue != null || (vision.quantity ?? 0) > 1) && !reviewOpen && (
              <button type="button" onClick={() => setReviewOpen(true)}
                className="block font-mono text-[9px] uppercase tracking-[0.06em] text-[var(--color-primary)] underline">
                review what it found
              </button>
            )}
          </span>
          <button type="button" aria-label="Discard" onClick={() => { resetDraft(); setPhase('photo'); }}
            className="min-w-[36px] min-h-[36px] flex items-center justify-center text-[var(--color-text-muted)]">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {dupes.length > 0 && (
        <div className="flex items-start gap-2 border-2 border-[var(--color-amber)] rounded-[var(--radius-sm)] p-2.5 shrink-0">
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

      {/* Each step enters as its own move, so advancing reads as progress
          rather than the same page quietly rearranging itself. */}
      <div key={phase} className={cn('animate-step-in flex flex-col gap-3', phase !== 'photo' && 'flex-1 min-h-0')}>
      {/* ── step 1: the picture ─────────────────────────────────────────── */}
      {phase === 'photo' && (
        <div className="flex flex-col gap-2">
          <input ref={photoInput} type="file" accept="image/*" capture="environment"
            className="hidden" onChange={onPhoto} />
          <button type="button" onClick={() => photoInput.current?.click()}
            className="flex flex-col items-center justify-center gap-2 border-2 border-[var(--color-text)] rounded-[var(--radius-sm)] py-10">
            <Camera className="w-8 h-8" />
            <span className="font-mono text-xs uppercase tracking-[0.1em] font-bold">Take a photo of the item</span>
          </button>
          <Button variant="ghost" size="sm" onClick={() => setPhase('identify')}>
            <SkipForward className="w-3.5 h-3.5" />
            Skip photo
          </Button>
        </div>
      )}

      {/* ── step 2/3: the camera hunts codes ────────────────────────────── */}
      {(phase === 'identify' || phase === 'place') && (
        <div className="flex flex-col gap-2 flex-1 min-h-0">
          {/* Exactly ONE of four things fills the space above the controls.
              A panel REPLACES the camera rather than stacking under it: that
              is what keeps the step one screen tall, and it also means the
              camera is not decoding while you type into a search box.
              Step 2 reads the maker's barcode, step 3 reads tally's tag — two
              questions, two scanners, and the product one cannot decode a QR,
              so a bin label can no longer be swallowed mid-naming. */}
          {phase === 'identify' && reviewOpen && vision ? (
            // Replaces the camera rather than stacking under it — the rule this
            // layout is built on, stated in the comment above. Stacking is what
            // made this invisible: the step is exactly one screen tall and has
            // no spare rows, so a new block below the controls lands off-screen.
            <div className="flex flex-col gap-2 border-2 border-[var(--color-text)] rounded-[var(--radius-sm)] p-3 flex-1 min-h-0 overflow-y-auto">
              <div className="flex items-center justify-between shrink-0">
                <span className="font-mono text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
                  From the photo — {vision.confidence === 'high' ? 'read' : 'guessed'}
                </span>
                <Button size="sm" variant="ghost" onClick={() => setReviewOpen(false)}>Close</Button>
              </div>
              {vision.description && !draft.description && (
                <div className="flex items-start gap-2">
                  <p className="flex-1 text-xs text-[var(--color-text-secondary)]">{vision.description}</p>
                  <Button size="sm" variant="outline" className="shrink-0"
                    onClick={() => setDraft((d) => ({ ...d, description: vision.description || undefined }))}>
                    Keep
                  </Button>
                </div>
              )}
              {vision.category && !draft.category && (
                <div className="flex items-center gap-2">
                  <p className="flex-1 font-mono text-xs uppercase tracking-wide">{vision.category}</p>
                  <Button size="sm" variant="outline" className="shrink-0"
                    onClick={() => setDraft((d) => ({ ...d, category: vision.category || undefined }))}>
                    Keep
                  </Button>
                </div>
              )}
              {vision.brand && !draft.name.toLowerCase().includes(vision.brand.toLowerCase()) && (
                <div className="flex items-center gap-2">
                  <p className="flex-1 text-xs">
                    <span className="text-[var(--color-text-muted)]">Brand: </span>{vision.brand}
                  </p>
                  {/* items has no BRAND column — products does. For an item with
                      no catalogue match the name is where brand lives, so
                      keeping it means putting it there. */}
                  <Button size="sm" variant="outline" className="shrink-0"
                    onClick={() => setDraft((d) => ({ ...d, name: `${vision.brand} ${d.name}`.trim() }))}>
                    Add to name
                  </Button>
                </div>
              )}
              {vision.quantity != null && vision.quantity > 1 && draft.quantity == null && (
                <div className="flex items-center gap-2">
                  <p className="flex-1 text-xs">
                    <span className="text-[var(--color-text-muted)]">Quantity: </span>{vision.quantity}
                  </p>
                  <Button size="sm" variant="outline" className="shrink-0"
                    onClick={() => setDraft((d) => ({ ...d, quantity: vision.quantity || undefined }))}>
                    Keep
                  </Button>
                </div>
              )}
              {vision.estimatedValue != null && draft.currentValue == null && (
                <div className="flex items-center gap-2">
                  <p className="flex-1 text-xs">
                    <span className="text-[var(--color-text-muted)]">Est. value: </span>
                    ~${vision.estimatedValue}
                    <span className="block font-mono text-[9px] uppercase tracking-wide text-[var(--color-text-muted)]">
                      a guess from the photo — appears in insurance reports
                    </span>
                  </p>
                  <Button size="sm" variant="outline" className="shrink-0"
                    onClick={() => setDraft((d) => ({ ...d, currentValue: vision.estimatedValue || undefined }))}>
                    Keep
                  </Button>
                </div>
              )}
              {(draft.description || draft.category || draft.currentValue != null || draft.quantity != null) && (
                <p className="font-mono text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
                  Kept: {[draft.description ? 'description' : null,
                          draft.category ? `category (${draft.category})` : null,
                          draft.quantity != null ? `qty ${draft.quantity}` : null,
                          draft.currentValue != null ? `value ~$${draft.currentValue}` : null]
                          .filter(Boolean).join(', ')}
                </p>
              )}
              {!vision.description && !vision.category && !vision.brand
                && vision.estimatedValue == null && (vision.quantity ?? 0) <= 1 && (
                <p className="text-xs text-[var(--color-text-muted)]">Only a name was offered.</p>
              )}
            </div>
          ) : phase === 'identify' && identifying ? (
            <div className="flex flex-col gap-2 border-2 border-[var(--color-text)] rounded-[var(--radius-sm)] p-3 flex-1 min-h-0">
              <div className="flex items-center justify-between shrink-0">
                <span className="font-mono text-[10px] uppercase tracking-[0.1em] font-bold">What is it?</span>
                <button
                  type="button"
                  aria-label="Close"
                  onClick={() => setIdentifying(false)}
                  className="min-w-[32px] min-h-[32px] flex items-center justify-center text-[var(--color-text-muted)]"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <ProductSearch initialQuery={draft.name} onProductSelected={adoptProduct} />
              <UrlExtractor onProductExtracted={adoptProduct} />
            </div>
          ) : phase === 'place' && picking ? (
            <DestinationPicker
              {...(ctxArea
                // Both from the same URL, so they always agree.
                ? { seedAreaId: ctxArea, seedPropertyId: ctxProperty }
                // Otherwise seed from the pinned bin ALONE and let the picker
                // backfill its property: pairing a remembered area with a
                // property from elsewhere can list another property's bins.
                : { seedAreaId: dest?.areaId })}
              onPick={(bin) => {
                pinDestination({ id: bin.id, name: bin.name, areaId: bin.areaId });
                setPicking(false);
                toast.success(`Adding to ${bin.name}`);
                const d = stateRef.current.draft;
                if (d.name || d.photo || d.barcode) void commit(d, { id: bin.id, name: bin.name, areaId: bin.areaId });
                else setPhase('photo');
              }}
              onClose={() => setPicking(false)}
            />
          ) : phase === 'identify' ? (
            <ProductScanner
              label={busy ?? 'Scan product barcode'}
              onBarcode={handleCode}
              onClose={() => navigate(-1)}
            />
          ) : (
            <TagScanner
              label={busy ?? 'Scan tote/area tag'}
              onTag={handleCode}
              onClose={() => navigate(-1)}
            />
          )}

          {/* Destination lives ONLY on the step that asks for one, and under
              the frame, because you look here after the camera has failed. */}
          {phase === 'place' && !picking && (
            <div className="flex flex-col gap-1.5 shrink-0">
              {dest && (
                <div className="flex items-center gap-2">
                  <MapPin className="w-3.5 h-3.5 shrink-0 text-[var(--color-text-muted)]" />
                  <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
                    {destConfirmed ? 'adding to' : 'last used'}
                  </span>
                  <span className="text-sm font-semibold truncate">{dest.name}</span>
                </div>
              )}

              {recents.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {recents.map((r) => {
                    const current = dest?.id === r.id && destConfirmed;
                    return (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => {
                          pinDestination(r);
                          const d = stateRef.current.draft;
                          if (d.name || d.photo || d.barcode) void commit(d, r);
                          else setPhase('photo');
                        }}
                        className={cn(
                          'font-mono text-[10px] uppercase tracking-[0.06em] rounded-full px-3 min-h-[32px] border',
                          current
                            ? 'border-[var(--color-primary)] text-[var(--color-primary)] font-bold'
                            : 'border-[var(--color-rule)] text-[var(--color-text)]',
                        )}
                      >
                        {r.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Two escape hatches from the camera on ONE row, not two: the
              catalogue when the thing has no barcode, and the bin step when
              the remembered bin has not been confirmed this session. The
              placeholder below carries the search affordance. */}
          {phase === 'identify' && !identifying && (
            <div className="flex gap-2 shrink-0">
              <Button variant="ghost" size="sm" className="flex-1 min-w-0" onClick={() => setIdentifying(true)}>
                <Search className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">Search</span>
              </Button>
              {!destConfirmed && (
                <Button variant="ghost" size="sm" className="flex-1 min-w-0" onClick={() => setPhase('place')}>
                  <MapPin className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">{dest ? 'Where?' : 'Choose bin'}</span>
                </Button>
              )}
            </div>
          )}

          {phase === 'identify' && (
            <div className="flex gap-2 shrink-0">
              <Input ref={nameField} placeholder="Name it, or search…" value={draft.name}
                // A suggested name is shown as unconfirmed until it is touched:
                // the risk this feature carries is a plausible wrong name being
                // accepted without being read, and a field that looks the same
                // whether a person or a model filled it invites exactly that.
                className={cn(nameIsSuggested && 'border-dashed border-[var(--color-primary)]')}
                onChange={(e) => {
                  // Editing it makes it theirs.
                  setNameIsSuggested(false);
                  setDraft((d) => ({ ...d, name: e.target.value }));
                }}
                // Typing a name and pressing enter is one gesture; making the
                // keyboard's own confirm key do nothing strands anyone who
                // never looks up from the field.
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  finishIdentifying();
                }} />
              {/* The row above hides once the bin is confirmed, so this keeps a
                  way back to step 3. Costs no vertical px. */}
              {destConfirmed && (
                <Button size="sm" variant="outline" aria-label="Change the bin"
                  className="shrink-0" onClick={() => setPhase('place')}>
                  <MapPin className="w-4 h-4" />
                </Button>
              )}
              <Button size="sm" className="shrink-0" disabled={!identified || !!busy}
                onClick={finishIdentifying}>
                <Check className="w-4 h-4" />
                Next
              </Button>
            </div>
          )}


          {phase === 'place' && !picking && (
            <Button variant="outline" size="sm" className="shrink-0" onClick={() => setPicking(true)}>
              <List className="w-4 h-4" />
              Pick a bin from the list
            </Button>
          )}
        </div>
      )}

      </div>

      {/* ── receipts ─────────────────────────────────────────────────────── */}
      {/* Step 1 only: this list is unbounded, and steps 2 and 3 are sized to
          the viewport. Step 1 has no frame to steal from. */}
      {phase === 'photo' && receipts.length > 0 && (
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
          <Button className="mt-3" onClick={() => { resetDraft(); setPhase('photo'); }}>
            <Plus className="w-4 h-4" />
            Add another
          </Button>
        </div>
      )}
    </div>
  );
}

export default Capture;

import * as React from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Camera, Check, X, Printer, Plus, MapPin, SkipForward, List, AlertTriangle, Search, ImagePlus, Sparkles, Keyboard, Loader2, Undo2 } from 'lucide-react';
import { ProductScanner } from '@/components/scanner/product-scanner';
import { PhotoCamera } from '@/components/scanner/photo-camera';
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
import { useCreateItem, useDeleteItem } from '@/hooks/use-inventory';
import { useUploadFile } from '@/hooks/use-files';
import { useQueueMatch } from '@/hooks/use-matches';
import { usePrinters, useCreatePrintJob } from '@/hooks/use-print';
import { usePrintQueueStore } from '@/store/print-queue-store';
import { cn } from '@/lib/utils';
import { extractTlyCode } from '@/lib/tly';
import { useVisionPref } from '@/store/vision-store';
import { decideSuggestion } from '@/lib/vision-decision';
import { useLayoutMode } from '@/hooks/use-layout-mode';
import { useCoarsePointer } from '@/hooks/use-coarse-pointer';

/**
 * The capture flow: PICTURE → SCAN → SCAN → DONE.
 *
 * The photo captures the thing, the product barcode names it, the tag files
 * it. All three steps run for every item — except step 2 is skipped when the
 * photo already named it with confidence: a HIGH-confidence suggestion that
 * also carries a brand means text was legible on the object, which is
 * exactly when a background product search can resolve to one real catalogue
 * row. Step 2 then becomes a "finding this product" chip instead of the
 * barcode scanner, the flow proceeds straight to step 3, and the match gets
 * turned into a real product later at /matches (see notifications.tsx for the
 * Alerts entry that points there). See `canMatch` below for the exact gate.
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

/**
 * The exceptions to "the whole thing is here".
 *
 * A retail box scans as its product, so without this a kept computer box files
 * itself under the computer's name AND its catalogue price, while the computer
 * is in use somewhere else. The insurance report excludes these rows from its
 * totals — see reports.service.js.
 */
const PARTIAL_OPTIONS = [
  { value: 'box_only' as const, label: 'box only' },
  { value: 'accessories_only' as const, label: 'spares only' },
];

/**
 * A value that is a barcode and nothing else: 8–14 digits, the length range
 * every retail symbology this app scans lives in (EAN-8 through GTIN-14).
 *
 * Used on the desk form's submit to catch a scan that landed in the NAME
 * field. #264 fixed where focus goes between items, which is the loop's
 * steady state — but the FIRST scan of a page load (or a remount, or a tablet
 * switching into typed mode) starts with the caret in Name by design, and a
 * USB reader is a keyboard: it types the code there and its terminating Enter
 * submits it. A guard on the submit itself is the version that does not care
 * where focus happened to be, so it also covers a pasted code and the caret
 * being moved by hand.
 *
 * Deliberately anchored and digits-only: a name that is nothing but a GTIN's
 * worth of digits is not a name anyone typed on purpose, and anything with a
 * letter or a space in it is left alone.
 */
const BARE_BARCODE = /^\d{8,14}$/;

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
  /**
   * Set only when the thing itself is NOT in the bin — its box or its spares
   * are. Undefined means complete, which is the overwhelming majority, so the
   * server's default carries it and nothing is sent.
   */
  completeness?: 'box_only' | 'accessories_only';
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

/** What a barcode lookup resolved to. `product` null means not in any catalogue. */
interface BarcodeLookup {
  product: { id?: number; name?: string; shortName?: string } | null;
  dupes: Dupe[];
}

/**
 * Ask both questions about a product barcode at once: what is this, and do I
 * already own one? Without the second, the primary add flow would silently
 * grow duplicates.
 *
 * Shared by the camera flow's handleCode and the desk form's barcode field —
 * one implementation of the network + parsing so the two paths cannot drift.
 * Each call site keeps its own UI reaction. The duplicate check is
 * best-effort and never fails the lookup; the lookup itself throws, and the
 * caller decides what a failure means on its surface.
 */
async function lookupBarcode(code: string): Promise<BarcodeLookup> {
  const [result, dup] = await Promise.all([
    api.post<{ product?: { id?: number; name?: string; shortName?: string } | null }>(
      '/api/products/_y_/lookup', { barcode: code },
    ),
    api.post<{ existingItems: Dupe[] }>(
      '/api/products/_y_/check-duplicate', { barcode: code },
    ).catch(() => ({ existingItems: [] as Dupe[] })),
  ]);
  return { product: result?.product ?? null, dupes: dup?.existingItems ?? [] };
}

/**
 * Everything a commit needs, frozen at the instant the user committed.
 *
 * The commit is optimistic — the flow is scan-ready again before the create
 * round trip resolves — so by the time the network answers, the live draft
 * and vision state belong to the NEXT item. The detached save must only ever
 * read this snapshot: the known race is the next item's photo landing (and
 * overwriting `vision`) before the previous item's create resolves, which
 * would queue a product match under the wrong item's identity. Retry re-runs
 * from the copy stored on the receipt for the same reason — data on the
 * receipt rather than a closure, so the entry survives re-renders identically.
 */
interface CommitSnapshot {
  draft: Draft;
  dest: Destination;
  vision: Vision | null;
  matchAvailable: boolean;
}

interface Receipt {
  /** Stable client key — the receipt exists before (and without) a server id. */
  key: string;
  /** `undone` is TERMINAL: the toast's Undo soft-deleted the item, the row
   *  stays struck-through as the session's account of the scan, and nothing
   *  on it can act again — Retry/undo handlers all guard on this state. */
  state: 'pending' | 'saved' | 'failed' | 'undone';
  /** Shown while pending; replaced by the server's copy once saved. */
  name: string;
  /** The frozen inputs — Retry re-runs from these, never from live state. */
  snapshot: CommitSnapshot;
  /** Server identity, present once state === 'saved'. */
  id?: number;
  qrCode?: string;
  propertyId?: number;
  photoState?: 'uploading' | 'failed' | 'done';
}

/**
 * `crypto.randomUUID` needs a secure context, and this app is reachable over
 * plain http on the LAN — the fallback is not paranoia, it is the phone
 * pointed at http://10.x address. Uniqueness within one session's receipt
 * list is all that is asked of it.
 */
function newReceiptKey(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `rk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** The name commit() writes: synthesised rather than blocking the unnamed. */
function displayName(d: Draft): string {
  return d.name.trim() || (d.barcode ? `Item ${d.barcode}` : 'Untitled item');
}

type Phase = 'photo' | 'identify' | 'place';

// Step number -> phase/label, for the progress dots' back-navigation (#229).
// Only steps BEHIND the current one ever use this — see the dots' render.
const STEP_PHASE: Record<1 | 2 | 3, Phase> = { 1: 'photo', 2: 'identify', 3: 'place' };
const STEP_LABEL: Record<1 | 2 | 3, string> = { 1: 'picture', 2: 'identify', 3: 'place' };

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
  // A desk has no rear camera and usually no camera worth pointing at a shelf,
  // so step 1 stops asking for one.
  const atDesk = useLayoutMode() === 'sidebar';
  // Landscape iPad: sidebar chrome (atDesk) AND a finger for a pointer. That
  // combination gets the phone's camera flow instead of the desk's form —
  // see showForm below for the single predicate that actually picks between
  // them.
  const coarse = useCoarsePointer();
  const tablet = atDesk && coarse;
  // Session-only, camera-first on every cold open: a tablet always starts in
  // the camera flow and can switch to the typed form and back within the
  // same visit, but a reload (or a different item) starts camera-first again.
  // Deliberately NOT reset by a landscape/portrait rotation dip either — the
  // component doesn't remount, so an in-session "Type it instead" choice
  // survives one; camera-first only binds cold opens, and honouring the
  // choice already made is less surprising than reverting it mid-task.
  const [typedMode, setTypedMode] = React.useState(false);
  // The single form-vs-flow predicate every other atDesk-shaped decision in
  // this file now keys on. Equal to atDesk whenever the pointer is fine
  // (coarse === false), which is what keeps phones and mouse-desks rendering
  // byte-identically to before this switch existed.
  const showForm = atDesk && (!coarse || typedMode);
  const [dragging, setDragging] = React.useState(false);
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
  /**
   * #226: step 1's embedded camera has bowed out — getUserMedia is missing,
   * it rejected, or the user tapped "Use system camera" under a bad preview —
   * so the photo phase renders the OS-input button instead. Per MOUNT, never
   * reset: within one visit the answer won't change (and flip-flopping the
   * camera would), while a fresh visit retries the embedded preview.
   */
  const [photoFallback, setPhotoFallback] = React.useState(false);
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
  /**
   * #266: a catalogue title a lookup found but did NOT apply, because the name
   * in the field was typed by a person. Offered behind a Keep rather than
   * taken — see applyBarcodeLookup. Null whenever there is nothing to offer.
   */
  const [catalogueName, setCatalogueName] = React.useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = React.useState(false);
  /**
   * Set the moment a barcode resolves to a real catalogue product.
   *
   * A ref, not state: the vision request is in flight when this flips, and its
   * callback needs the CURRENT answer, not the value captured when it started.
   */
  const catalogueHit = React.useRef(false);
  /**
   * #233: which draft an in-flight identifyPhoto call still belongs to.
   *
   * The commit is optimistic, so a slow vision response for item A can
   * resolve after A was committed and the flow is already photographing item
   * B. The commit-time direction is snapshot-protected (see CommitSnapshot);
   * this ref closes the draft-application direction, which had no guard — A's
   * confidently-applied name and suggestions landed in B's draft. Each
   * identify call claims a fresh generation when it starts (so a retaken
   * photo obsoletes the previous shot's in-flight call too), resetDraft()
   * bumps it when the draft's item finishes, and the response handler applies
   * ONLY while its generation is still current — the same patch-by-key spirit
   * as the receipts. A ref, not state: it is compared inside an async
   * continuation, which must see the value as of NOW, not as of the render
   * that started the request.
   */
  const identifyGen = React.useRef(0);
  // A failed identify used to be indistinguishable from a disabled feature and
  // from an honest 'cannot tell'. All three showed nothing.
  const [visionFailed, setVisionFailed] = React.useState(false);
  // The model was asked and had nothing useful to say. Distinct from failure
  // (the request broke) and from the feature being off (nothing was asked).
  const [visionEmpty, setVisionEmpty] = React.useState(false);
  /**
   * Whether the SERVER actually has product matching turned on
   * (`config.match.enabled`), read off identify-photo's own response.
   *
   * The queue route's own 503 when the feature is off arrives too late — by
   * then step 2 has already been replaced by "Finding this product" and the
   * item ends with no barcode, no product and no worklist row. Independent of
   * `vision`'s own availability: MATCH_ENABLED and VISION_ENABLED are two
   * separate switches, so this must not be inferred from a suggestion having
   * arrived. Defaults to false — the same "nothing asked yet" default the
   * kill switch needs — until a real answer says otherwise.
   */
  const [matchAvailable, setMatchAvailable] = React.useState(false);

  /**
   * The gate: high confidence AND a brand AND the server confirming the
   * feature is actually on. The brand is the real signal — the vision prompt
   * forbids inventing one it cannot read, so a brand coming back means text
   * was legible on the object, exactly when a product search can resolve to
   * one product. An unbranded mug never searches. `matchAvailable` is the
   * kill switch: with it false, step 2 must appear exactly as it does today.
   *
   * True only means step 2 CAN be skipped for a background search — it is
   * recomputed (not reused) at the point commit() actually queues one, since
   * this value and the state it reads can each change up to that moment.
   */
  const canMatch = matchAvailable && vision?.confidence === 'high' && !!vision.brand;

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
    setCatalogueName(null);
    setReviewOpen(false);
    setVisionFailed(false);
    setVisionEmpty(false);
    catalogueHit.current = false;
    // #233: an identify call still in flight belongs to the item just
    // finished (or abandoned) — obsolete it, so its late answer cannot land
    // in the next item's draft.
    identifyGen.current++;
    // Mirrored into stateRef SYNCHRONOUSLY, not left to the effect: with the
    // commit optimistic, the scanner stays live between items, and a second
    // scan callback can fire before React has re-rendered. Reading the dead
    // draft back out of the ref there would commit the same item twice.
    stateRef.current = { ...stateRef.current, draft: { name: '' }, vision: null, nameIsSuggested: false };
  }

  const createItem = useCreateItem();
  // The soft-delete behind the toast's Undo — the recycle-bin path, so an
  // undone item is restorable from there. The hook (not raw api.del) because
  // its onSuccess runs invalidateTree: the mis-filed bin's item list and
  // counts must stop showing the item the moment the undo lands.
  const deleteItem = useDeleteItem();
  const uploadFile = useUploadFile();
  const queueMatch = useQueueMatch();
  const createPrintJob = useCreatePrintJob();
  const stage = usePrintQueueStore((s) => s.add);
  const stageMany = usePrintQueueStore((s) => s.addMany);
  // Any receipt that has already saved knows the property; a pending one does
  // not yet (the propertyId arrives on the create response's breadcrumb).
  const { data: printers } = usePrinters(receipts.find((r) => r.propertyId != null)?.propertyId || undefined);
  const hasPrinter = !!printers?.length;
  /** The rows label actions can act on — the server has confirmed these. */
  const savedReceipts = receipts.filter(
    (r): r is Receipt & { id: number; qrCode: string } =>
      r.state === 'saved' && r.id != null && r.qrCode != null,
  );

  // The scanner callback is handed to the camera once, so it must not close
  // over stale state. vision/matchAvailable ride along for commit()'s
  // snapshot: commit can be reached through that same long-lived callback, so
  // reading them off the render that created it would freeze the values from
  // whenever the camera was mounted, not from the moment of commit.
  // nameIsSuggested rides along for the same reason the draft does: #266's
  // "did a person type this name" test is read AFTER a lookup's round trip,
  // and the render that started the lookup is not the render that answers it.
  const stateRef = React.useRef({ dest, draft, phase, destConfirmed, vision, matchAvailable, nameIsSuggested });
  React.useEffect(() => { stateRef.current = { dest, draft, phase, destConfirmed, vision, matchAvailable, nameIsSuggested }; }, [dest, draft, phase, destConfirmed, vision, matchAvailable, nameIsSuggested]);

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
    // A hand-picked product is a fact about this exact object, exactly like a
    // barcode's catalogue hit below — drop the photo's guess rather than let
    // it linger and satisfy the match-queue gate for an item that already has
    // a real product (see the identical comment and `setVision(null)` on the
    // barcode path). catalogueHit also has to flip here, not just vision:
    // identifyPhoto() can still be in flight when a product is picked by
    // hand, and decideSuggestion() consults this ref — not the vision state —
    // to refuse a late-arriving suggestion. See vision-decision.ts's own
    // comment on why both orders of arrival matter.
    catalogueHit.current = true;
    setVision(null);
    setReviewOpen(false);
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

  /** Save/upload legs currently running, by receipt key (`photo:`-prefixed
   *  for the upload leg). A ref, not state: it exists to be checked
   *  synchronously at the top of the detached blocks, before any await, so a
   *  double-fired retry can never run two creates for one receipt. */
  const inFlight = React.useRef(new Set<string>());

  /** Receipts whose toast Undo has already fired, by key. The same idiom as
   *  `inFlight`, for the same reason: the guard must be a synchronous ref
   *  check before any await, because the toast's onClick reads no fresh
   *  React state — a double click on the still-visible toast (sonner takes
   *  a frame to dismiss it) must be a no-op, not a second DELETE. */
  const undoneKeys = React.useRef(new Set<string>());

  /** Patch one receipt in place by key. A map, never a sort or a move: the
   *  list keeps commit order and state patches must not reorder it. Also safe
   *  after unmount — the detached save below outlives navigation, and a
   *  setState on an unmounted component is a no-op in React 18 (deliberately
   *  no mountedRef guard: one set false on cleanup never re-arms under
   *  StrictMode's dev double-mount, and this codebase has been bitten). */
  function patchReceipt(key: string, patch: Partial<Receipt>) {
    setReceipts((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  /**
   * Commit optimistically. The synchronous part is the whole user experience:
   * prepend a pending receipt, reset the draft, put the camera back on step 1 —
   * the phone user is aiming at the next item while the network works. The
   * hundred-item session must never wait on a round trip.
   *
   * Everything that needs the network happens in a detached async block that
   * reads ONLY the snapshot frozen here (see CommitSnapshot for the race this
   * closes) and reports back by patching the receipt. Failure's recovery
   * surface is the receipt's Retry, which re-runs the same block from the
   * same snapshot — the live draft has long since moved on.
   */
  function commit(d: Draft, destination: Destination) {
    const snapshot: CommitSnapshot = {
      draft: d,
      dest: destination,
      // From the ref, not the render closure — commit can be invoked through
      // the camera's long-lived callback, whose closure predates this item.
      vision: stateRef.current.vision,
      matchAvailable: stateRef.current.matchAvailable,
    };
    const key = newReceiptKey();
    // Newest first: the list renders below the step-1 block and is unbounded,
    // so the just-committed row — the one whose failure toast says "Retry
    // from the list" — must be the row above the fold, not underneath six
    // older ones. Ordering STABILITY is patchReceipt's job (keyed map, never
    // a move); direction is decided here, once, at insert.
    setReceipts((prev) => [{ key, state: 'pending', name: displayName(d), snapshot }, ...prev]);
    // Scan-ready NOW. The warning (and the suggestion) belong to the draft
    // just committed, not to the next one — leaving either up would claim
    // something about an object that has not been photographed yet.
    resetDraft();
    setPhase('photo');
    void runCommit(key, snapshot);
  }

  /**
   * The detached save. Never awaited by commit(), and never able to reject
   * unhandled — every path runs inside a try. Reads only the snapshot.
   */
  async function runCommit(key: string, snap: CommitSnapshot) {
    // Structural re-entry guard: a double-fired Retry (or any future second
    // caller) must not run two creates for one receipt. The retry handler
    // checks the row's state at render time; this closes the residual
    // not-yet-rendered window by construction instead of leaning on React's
    // discrete-event flush timing.
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    const { draft: d, dest: destination, vision: seen, matchAvailable: matchOn } = snap;
    const name = displayName(d);
    // The create leg. Its catch spans ONLY the create: past it, the item row
    // exists, and a receipt marked failed after that point would offer a
    // Retry that duplicates the item.
    let created;
    try {
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
        //
        // The flag is unconditional because this screen has exactly one way to
        // set currentValue — the Keep button on the model's guess. If a
        // hand-entry value field is ever added here, this MUST become
        // conditional, or a typed number will be filed as an estimate.
        ...(d.currentValue != null
          ? { currentValue: d.currentValue, currentValueIsEstimate: true }
          : {}),
        // Omitted when complete — the column defaults, so sending it would only
        // be restating the norm.
        ...(d.completeness ? { completeness: d.completeness } : {}),
      });
      created = res?.item;
      if (!created) throw new Error('Create returned no item');
    } catch {
      // The receipt is the recovery surface — the toast points at it rather
      // than carrying its own retry.
      patchReceipt(key, { state: 'failed' });
      toast.error(`Couldn't save "${name}" — Retry from the list`);
    }
    if (!created) {
      // The create failed (the catch above has already said so) — nothing
      // more may run for this receipt until its Retry re-arms it.
      inFlight.current.delete(key);
      return;
    }

    // Past here the item IS saved. Nothing below may demote the receipt to
    // failed — each leg handles its own partial-failure state — so this
    // catch only reports: 'failed' here would invite a duplicating Retry.
    try {
      patchReceipt(key, {
        state: 'saved',
        id: created.id,
        name: created.name,
        qrCode: created.qrCode,
        propertyId: (created as unknown as { breadcrumb?: { id: number; type: string }[] })
          .breadcrumb?.find((b) => b.type === 'property')?.id,
      });
      // The Undo closes over THIS commit's key and created id — never shared
      // state read at click time. Commits are rapid-fire and sonner stacks
      // several ~4s toasts at once; a shared "last created" slot would undo
      // whatever landed most recently, not the item this toast is about
      // (the exact bug the distribute toast's per-toast closure fixed).
      //
      // Skipped under showForm (#265): at a desk with the form open, the
      // toast painted directly over the Name field — its Undo sat exactly
      // where a mouse goes to type the next item, so reaching for the next
      // item could soft-delete the one just saved. The receipts list — which
      // sits beside the form, in its right-hand column (#277) — is already
      // the desk's natural record of every commit, and it carries its own
      // Undo action for the same reason: this isn't a lost capability, just
      // a moved one.
      if (!showForm) {
        toast.success(`${created.name} → ${destination.name}`, {
          action: { label: 'Undo', onClick: () => { void undoCreate(key, created.id, created.name); } },
        });
      }

      // Read from the SNAPSHOT (`seen`/`matchOn`), never live state: by now
      // the next item's photo may have landed and overwritten `vision`, and
      // queueing a match under that item's identity is exactly the race the
      // snapshot exists to close. A queue failure must never block the
      // capture — mutate() is fire-and-forget and the item is already saved
      // either way; it can still be scanned by hand later.
      //
      // `matchOn` MUST be part of this condition: it decides whether the
      // POST fires at all, and without it a capture with the kill switch off
      // would still queue — 503, then the onError toast below fires on every
      // branded capture, which is worse than the silent version this
      // replaced.
      //
      // `!d.productId` is a second, independent gate: adoptProduct() clears
      // `vision` the moment a product is picked by hand, but requiring this
      // here too means the commit itself can never queue a redundant search
      // for an item that already resolved to a real product — no future path
      // that sets productId without remembering to clear vision can reopen
      // this hole.
      if (matchOn && seen?.confidence === 'high' && seen.brand && !d.productId) {
        queueMatch.mutate({
          itemId: created.id,
          brand: seen.brand,
          name: seen.name ?? name,
          category: seen.category,
          description: seen.description,
        }, {
          // Every 503/429/400/network failure used to vanish here — after
          // step 2 was already skipped in favor of "Finding this product",
          // so the item ended with no barcode, no product AND no worklist
          // row, and nobody was ever told. The item itself is unaffected
          // (already saved above); only the background search never started,
          // so it will not show up to pick a product from later — the same
          // thing a `failed` worklist row would say, said up front instead.
          onError: () => toast.error(
            `${created.name} saved, but won't appear in the product worklist — `
            + 'scan its barcode or search for it another time',
          ),
        });
      }

      // Photo second — the item must exist for the upload route to accept it.
      // Awaited only within this detached block; the user is long gone.
      if (d.photo) {
        await uploadReceiptPhoto(key, created.id, d.photo);
      }
    } catch (err) {
      console.warn('[capture] post-create step threw; the item is saved', err);
    } finally {
      inFlight.current.delete(key);
    }
  }

  /** The photo leg, shared by the commit and the receipt's own retry. The
   *  item is saved either way — only the photoState is at stake here. */
  async function uploadReceiptPhoto(key: string, itemId: number, photo: Blob) {
    const token = `photo:${key}`;
    if (inFlight.current.has(token)) return;
    inFlight.current.add(token);
    patchReceipt(key, { photoState: 'uploading' });
    try {
      await uploadFile.mutateAsync({
        itemId,
        file: new File([photo], `capture-${itemId}.jpg`, { type: 'image/jpeg' }),
        fileType: 'photo',
      });
      // The blob was held on the snapshot only so a retry could re-run from
      // it; with the photo landed, no retry can need it again (commit Retry
      // shows only on failed rows, photo retry only on photoState 'failed').
      // A hundred-item session must not retain a hundred JPEGs.
      setReceipts((prev) => prev.map((r) => (r.key === key
        ? { ...r, photoState: 'done', snapshot: { ...r.snapshot, draft: { ...r.snapshot.draft, photo: undefined } } }
        : r)));
    } catch {
      patchReceipt(key, { photoState: 'failed' }); // the item is saved; only the photo failed
    } finally {
      inFlight.current.delete(token);
    }
  }

  /**
   * The success toast's Undo (#227): a mis-scanned bin files the item
   * silently, and before this the only way back was hunting it down on the
   * item page. Soft-delete it instead — DELETE /api/items is the recycle-bin
   * path, so the undo itself is reversible from there, which is why it can
   * run without a confirm.
   *
   * The receipt flips to `undone` optimistically and terminally: the row
   * stays, struck through, so the session list still accounts for the scan.
   * The one failure path flips it back to `saved` (the item IS still filed —
   * a struck-through row would be a lie) and re-arms the guard.
   *
   * Photo upload / product match possibly still in flight for this item are
   * deliberately NOT awaited or cancelled (spec §2): a late arrival against
   * a soft-deleted item is harmless server-side, and match rows for deleted
   * items are invisible by the existing joins. No coordination.
   */
  async function undoCreate(key: string, itemId: number, name: string) {
    if (undoneKeys.current.has(key)) return; // single-shot, checked before any await
    undoneKeys.current.add(key);
    patchReceipt(key, { state: 'undone' });
    try {
      await deleteItem.mutateAsync(itemId);
      toast(`${name} moved to the recycle bin`);
    } catch {
      undoneKeys.current.delete(key);
      patchReceipt(key, { state: 'saved' });
      toast.error(`Couldn't undo "${name}" — it's still where you filed it`);
    }
  }

  /** Re-run the whole save from the snapshot stored on the receipt. */
  function retryCommit(r: Receipt) {
    // Only a failed row may re-run: the receipt flips out of 'failed' before
    // any async work, so a second click is a no-op rather than a second
    // create. (runCommit's inFlight set covers the not-yet-rendered window.)
    if (r.state !== 'failed') return;
    patchReceipt(r.key, { state: 'pending' });
    void runCommit(r.key, r.snapshot);
  }

  /** Re-run only the photo leg — the item row already exists. */
  function retryPhoto(r: Receipt) {
    // `saved` only: an undone receipt is terminal — its photoState may still
    // read 'failed' from before the undo, but the item is soft-deleted and
    // nothing may act for it again. Same shape as retryCommit's guard.
    if (r.state !== 'saved' || r.photoState !== 'failed') return;
    if (r.id == null || !r.snapshot.draft.photo) return;
    void uploadReceiptPhoto(r.key, r.id, r.snapshot.draft.photo);
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
          commit(live, target);
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
      // What is this, and do I already own one — see lookupBarcode.
      const { product, dupes: existing } = await lookupBarcode(code);
      setDupes(existing);
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
   * The desk form's reaction to a barcode lookup (#230): the same draft, dupe
   * and vision writes handleCode makes for a scanned code, minus the phase
   * moves — the form has no steps to advance and no scanner to hand focus
   * back to. The outcome goes back to the FIELD, which owns focus and the
   * lookup-guard re-arm; the shared network + parsing is lookupBarcode.
   */
  async function applyBarcodeLookup(
    code: string,
    opts?: { fromNameField?: boolean },
  ): Promise<'hit' | 'miss' | 'failed'> {
    try {
      const { product, dupes: existing } = await lookupBarcode(code);
      setDupes(existing);
      // Read the draft fresh, exactly like handleCode: the lookup round trip
      // is long enough for the user to have typed a description, and spreading
      // a pre-await snapshot would silently discard it.
      //
      // `fromNameField` is the rescue path (see BARE_BARCODE): the code was
      // typed into Name by a scanner, so whatever the ref still holds there
      // is the code, not a name. Blanking it here rather than trusting the
      // caller's setDraft to have landed keeps this independent of React's
      // flush timing — the answer must not depend on whether the mirroring
      // effect ran before the network did.
      const live = opts?.fromNameField
        ? { ...stateRef.current.draft, name: '' }
        : stateRef.current.draft;
      const title = product?.shortName || product?.name || '';
      /**
       * #266: whether the name in the field is one a PERSON put there.
       *
       * At a desk both fields are on screen at once, so "name it, then scan
       * it" is the natural order for anything the catalogue title is wrong
       * for — "Dad's old drill", "the good extension lead". A typed name is a
       * decision about this object; the catalogue title is a fact about the
       * product. The fact does not get to overwrite the decision (and merely
       * TABBING OUT of the barcode field used to be enough to make it),
       * so the title is offered behind a Keep instead — the same consent gate
       * VisionReview uses for everything the model guesses.
       *
       * A model-suggested name is not protected: it is a guess, and a
       * catalogue hit is a better answer to the same question. That is the
       * existing rule from the camera path, unchanged.
       */
      const userNamed = !!live.name.trim() && !stateRef.current.nameIsSuggested;
      setDraft({
        ...live,
        barcode: code,
        name: userNamed ? live.name : (title || live.name),
        fullName: product?.id ? undefined : product?.name,
        productId: product?.id,
      });
      // Only worth offering when it says something the field does not.
      setCatalogueName(userNamed && title && title !== live.name.trim() ? title : null);
      if (product?.name) {
        // A catalogue hit is a fact about this exact object; the photo guess
        // is an inference. Drop the guess, exactly as the camera path does.
        catalogueHit.current = true;
        setVision(null);
        setReviewOpen(false);
        setNameIsSuggested(false);
        return 'hit';
      }
      // Same message as the camera path: half the household is in no catalogue.
      toast('Not in the catalogue — name it yourself');
      return 'miss';
    } catch {
      // The typed code is already in the draft — the field wrote it on every
      // keystroke — so unlike the camera path there is nothing to keep here,
      // only a failure to report (and a guard to re-arm, the caller's job).
      toast('Lookup failed — the barcode was kept');
      return 'failed';
    }
  }

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
    // #233: claim a generation for this call — see identifyGen. The guard
    // lives HERE, in the one shared entry point (acceptPhotoFile funnels both
    // the camera flow and ManualCreate's dropped photo through this), so no
    // caller can forget it. Every per-photo state write below applies only
    // while `gen` is still current; the deliberate exception is
    // setMatchAvailable, a server capability flag that is true or false
    // regardless of which photo's response carried it.
    const gen = ++identifyGen.current;
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
        if (gen === identifyGen.current) setVisionFailed(true);
        return;
      }
      const data = await parseEnvelope<{
        available: boolean; suggestion: Vision | null; matchAvailable: boolean;
      }>(res);
      // Set regardless of whether a suggestion arrived: this is a capability
      // flag (does the SERVER have MATCH_ENABLED on), not a fact about this
      // one photo, and canMatch needs it even on a call that finds nothing.
      // Deliberately NOT generation-guarded for the same reason — a stale
      // call's answer to "is matching on?" is as true as a fresh one's.
      setMatchAvailable(!!data?.matchAvailable);
      // #233: past here everything is about THIS photo. If the draft it was
      // taken for is gone — committed, discarded, or re-photographed — the
      // answer must not touch the draft that replaced it.
      if (gen !== identifyGen.current) return;
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
      if (gen === identifyGen.current) setVisionFailed(true);
    } finally {
      // Guarded too: a stale call settling late must not clear the pending
      // indicator of the NEWER call still in flight for the current draft.
      if (gen === identifyGen.current) setVisionPending(false);
    }
  }

  /**
   * One path for a chosen photo, however it arrived — file picker on any
   * device, or dropped onto the panel at a desk. Two copies of this would
   * drift on the part that matters least visibly: whether identification runs.
   */
  async function acceptPhotoFile(file: File) {
    const blob = await downscale(file);
    setDraft((d) => ({ ...d, photo: blob, photoUrl: URL.createObjectURL(blob) }));
    setPhase('identify');
    // Not awaited: step 2 is already on screen and the camera scanner is live.
    void identifyPhoto(blob);
  }

  /**
   * Drop the photo held for this draft, and nothing else (#277).
   *
   * The desk form's only photo-removing control used to be the draft strip's
   * X, which threw the WHOLE draft away; with the strip not rendering there,
   * a wrong photo needed an affordance that costs the name and the barcode
   * nothing. The suggestion goes with it — it is an inference about a picture
   * that is no longer attached.
   */
  function clearPhoto() {
    setDraft((d) => ({ ...d, photo: undefined, photoUrl: undefined }));
    // #233: an identify call still in flight belongs to the photo just
    // removed — obsolete it, so its answer cannot land in this draft.
    identifyGen.current++;
    setVision(null);
    setVisionPending(false);
    setVisionFailed(false);
    setVisionEmpty(false);
    setReviewOpen(false);
  }

  async function onPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    await acceptPhotoFile(file);
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

  /**
   * #268: the scanner's `Close` — 8px from `Stop`, same size, same weight —
   * is dropped on a finger-driven screen.
   *
   * `Stop` pauses the decode loop and is one tap to undo. `Close` unmounts
   * Capture, taking the held photo Blob, the typed name and any Kept vision
   * fields with it, no confirm and no undo. Adjacent identical 32px controls,
   * one benign and one destructive, is a mis-tap waiting to happen every
   * scanning session. A coarse pointer already has two safer ways out — the
   * draft strip's Discard and the browser's own back — so the destructive one
   * simply is not offered there. A mouse keeps it: a cursor does not slip 8px.
   */
  const scannerClose = coarse ? undefined : () => navigate(-1);

  /**
   * The one sentence this page says about a held photo — and the one link that
   * opens what the model found. Computed once because two surfaces say them
   * now: the camera flow's draft strip, and the desk form's photo panel, which
   * inherited them when the strip stopped rendering there (#277). Two copies
   * would drift on exactly the states that are hardest to see.
   */
  const photoStatus = visionPending ? 'photo held — looking at it…'
    : visionFailed ? "photo held — couldn't read it"
    : visionEmpty ? 'photo held — nothing recognised'
    : vision ? `photo held — ${vision.confidence === 'high' ? 'read' : 'guessed'} from the photo`
    : 'photo held — saves with the item';
  /** Did the model offer anything BEYOND the name, i.e. is there anything to review? */
  const reviewOffered = !!vision && !reviewOpen && !!(
    vision.description || vision.category || vision.brand
    || vision.estimatedValue != null || (vision.quantity ?? 0) > 1
  );

  /** One warning, two positions — see the render sites and #277. */
  const dupeWarning = dupes.length > 0
    ? <DupeWarning dupes={dupes} onDismiss={() => setDupes([])} />
    : null;

  /**
   * The session log: every commit this visit, newest first, with each
   * row's Retry / photo-retry / Queue / Print handles on it.
   *
   * A node rather than JSX in place, because it has two homes (#277). In
   * the camera flow it renders under step 1, the only step with height to
   * spare. On the desk form it moves into the grid's right column, under
   * the photo panel that already owns 320px there — stacked below the form
   * it fell off the fold at ~10 items, while 796px of width sat empty
   * beside it, and a fifty-item session is exactly when the log IS the
   * work product.
   *
   * The gate is showForm OR step 1, not step 1 alone: attaching a photo
   * moves the flow to `identify`, and that used to take the whole list
   * with it — every earlier row's Retry, Queue and Print unreachable until
   * the item in your hand was finished.
   */
  const receiptList = (showForm || phase === 'photo') && receipts.length > 0 ? (
    <div className="flex flex-col">
      <ColHead
        // Only rows the server has confirmed can be queued — a pending
        // receipt has no id or qr code yet, and a failed one never will.
        action={savedReceipts.length > 1 ? `Queue all ${savedReceipts.length}` : undefined}
        onAction={() => {
          // addMany dedupes and returns how many were NEWLY staged. Report
          // that, not the number asked for — queueing the same receipts
          // twice stages nothing, and saying "Queued 5" would be a lie.
          const n = stageMany(savedReceipts.map((r) => ({
            id: r.id, entityType: 'item' as const, name: r.name, qrCode: r.qrCode, propertyId: r.propertyId,
          })));
          toast.success(n > 0 ? `${n} labels queued` : 'Already queued');
        }}
      >
        Added this session · {receipts.length}
      </ColHead>
      {receipts.map((r) => {
        // Narrowed into a plain object so the button closures below hold
        // concrete numbers — `r.id` alone un-narrows inside a callback.
        const saved = r.state === 'saved' && r.id != null && r.qrCode != null
          ? { id: r.id, qrCode: r.qrCode }
          : null;
        return (
        <div key={r.key} className="flex items-center gap-2 py-2.5 border-b border-[var(--color-rule)] last:border-b-0">
          {r.state === 'saved' ? (
            <Check className="w-4 h-4 text-[var(--color-green)] shrink-0" />
          ) : r.state === 'failed' ? (
            <AlertTriangle className="w-4 h-4 text-[var(--color-red)] shrink-0" />
          ) : r.state === 'undone' ? (
            <Undo2 className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
          ) : (
            <Loader2 className="w-4 h-4 animate-spin text-[var(--color-text-muted)] shrink-0" />
          )}
          <span className="min-w-0 flex-1">
            <span className={cn('block text-sm font-semibold truncate',
              r.state === 'undone' && 'line-through text-[var(--color-text-muted)]')}>{r.name}</span>
            <span className="block font-mono text-[10px] text-[var(--color-text-muted)]">
              {r.state === 'pending' ? 'saving…'
                : r.state === 'failed' ? 'not saved'
                // Terminal: no qr code (the item is gone), no Retry, no
                // label actions — `saved` above is null for this row.
                : r.state === 'undone' ? 'removed · in the recycle bin'
                : (
                  <>
                    {r.qrCode}
                    {r.photoState === 'uploading' && ' · uploading photo'}
                    {r.photoState === 'failed' && (
                      <>
                        {' · '}
                        <button type="button" onClick={() => retryPhoto(r)}
                          className="underline decoration-dotted text-[var(--color-red)]">
                          photo failed · retry
                        </button>
                      </>
                    )}
                  </>
                )}
            </span>
          </span>
          {r.state === 'failed' && (
            <Button size="sm" variant="outline" onClick={() => retryCommit(r)}>
              Retry
            </Button>
          )}
          {/* Only under showForm (#265): everywhere else, the per-commit
              toast still carries its own Undo action. A row action here as
              well would just be a second way to do the same thing. */}
          {saved && showForm && (
            <Button size="sm" variant="outline" onClick={() => void undoCreate(r.key, saved.id, r.name)}>
              <Undo2 className="w-3.5 h-3.5" />
              Undo
            </Button>
          )}
          {saved && hasPrinter && (
            <Button size="sm" variant="outline"
              onClick={() => createPrintJob.mutate(
                { entityType: 'item', entityIds: [saved.id], preset: 'small', propertyId: r.propertyId },
                { onSuccess: () => toast.success('Printing label'),
                  onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not print') })}>
              <Printer className="w-3.5 h-3.5" />
            </Button>
          )}
          {saved && (
            <Button size="sm" variant="outline"
              onClick={() => { stage({ id: saved.id, entityType: 'item', name: r.name, qrCode: saved.qrCode, propertyId: r.propertyId }); toast.success('Queued'); }}>
              Queue
            </Button>
          )}
        </div>
        );
      })}
      {/*
        #277: the camera flow only. There, "Add another" is the way back to a
        live viewfinder after a commit left you looking at the receipt list.
        On the desk form the phase is ALREADY 'photo', so the only surviving
        effect of this button was resetDraft() — the widest, boldest control
        on the page silently throwing away whatever had been typed, with no
        confirm. The form is always there and clears itself after every
        commit; it does not need a button to start the next item.
      */}
      {!showForm && (
        <Button className="mt-3" onClick={() => { resetDraft(); setPhase('photo'); }}>
          <Plus className="w-4 h-4" />
          Add another
        </Button>
      )}
    </div>
  ) : null;

  return (
    <div className={cn(
      'flex flex-col gap-3 mx-auto h-full',
      // max-w-lg frames a camera viewfinder, which is what this page is on a
      // phone. The desk form is a form: it needs room for a label beside its
      // field, not a 512px column that truncates every placeholder. The
      // tablet camera flow is the phone's viewfinder too (spec §3.1:
      // whitespace, not stretched controls), so this keys on showForm, not
      // atDesk.
      showForm ? 'w-full max-w-[900px]' : 'max-w-lg',
    )}>
      {/* progress + destination */}
      <div className={cn('flex items-center gap-2 shrink-0', showForm && 'hidden')}>
        {([1, 2, 3] as const).map((n) => {
          const dotClass = cn('h-[3px] rounded-full transition-all duration-300 ease-out',
            n === step ? 'w-8 bg-[var(--color-primary)]' : 'w-5',
            n < step ? 'bg-[var(--color-text)]' : n > step ? 'bg-[var(--color-border)]' : '');
          // Only PREVIOUS steps are a way back — the current and forward dots
          // stay inert (mirrors the whole flow's linear, camera-first shape:
          // there is no "skip ahead by tapping a dot"). Going back never
          // touches the draft — place → identify keeps the photo AND the
          // draft; identify → photo keeps the photo too, since retaking it is
          // the photo area's own job, not this dot's.
          if (n >= step) return <span key={n} className={dotClass} />;
          return (
            <button
              key={n}
              type="button"
              aria-label={`Back to ${STEP_LABEL[n]}`}
              onClick={() => setPhase(STEP_PHASE[n])}
              // `flex` is load-bearing, not decoration (#273): the dot is a
              // <span>, and inside a plain block button it is an ordinary
              // INLINE child, where the dotClass width/height do not apply —
              // it rendered 0x0 inside an 8x8 button, so the completed step
              // vanished from the row and #229's way back was invisible.
              // Blockifying it as a flex item paints it again; p-2 -m-2 is
              // what makes the target big enough for a finger without moving
              // anything around it.
              className="flex p-2 -m-2"
            >
              <span className={dotClass} />
            </button>
          );
        })}
        <span className="flex-1" />
        {tablet && !showForm && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto shrink-0"
            onClick={() => setTypedMode(true)}
          >
            <Keyboard className="w-4 h-4" />
            Type it instead
          </Button>
        )}
        <span key={phase} className="animate-step-in font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
          <b className="text-[var(--color-text)]">{step}/3</b>{' '}
          {phase === 'photo' ? 'picture' : phase === 'identify' ? 'identify' : 'place'}
        </span>
      </div>

      {/*
        The draft being built — the camera flow's only view of it.

        #277: NOT rendered on the desk form. There the fields themselves are
        the draft, three rows below, so the strip restates them — and it
        appears on the first character typed, shoving the field under the
        caret down 74px mid-word, once per item. Its two genuinely unique
        parts moved into the form instead: the completeness pills next to
        Quantity, and the photo's status and review link onto the photo panel
        that already owns the picture.
      */}
      {!showForm && (draft.photoUrl || draft.name || draft.barcode) && (
        <div className="flex items-center gap-2 border border-[var(--color-rule)] rounded-[var(--radius-sm)] p-2 shrink-0">
          {draft.photoUrl
            ? <img src={draft.photoUrl} alt="" className="w-11 h-11 rounded-[var(--radius-sm)] object-cover" />
            : <span className="w-11 h-11 rounded-[var(--radius-sm)] border border-dashed border-[var(--color-rule)]" />}
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold truncate">{draft.name || 'Unnamed'}</span>
            {draft.barcode && <span className="block font-mono text-[10px] text-[var(--color-text-muted)]">{draft.barcode}</span>}
            {draft.photo && (
              <span className="block font-mono text-[9px] uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
                {photoStatus}
              </span>
            )}
            {reviewOffered && (
              <button type="button" onClick={() => setReviewOpen(true)}
                className="block font-mono text-[9px] uppercase tracking-[0.06em] text-[var(--color-primary)] underline">
                review what it found
              </button>
            )}

            {/*
              It lives in the draft strip because the strip is shrink-0 and
              always visible — step 2 is exactly one screen tall, and a control
              below the fold is a control nobody uses. (The desk form has no
              strip; it renders the same pills beside Quantity — see #277.)
            */}
            <CompletenessPills
              value={draft.completeness}
              onToggle={(value) => setDraft((d) => ({
                ...d,
                completeness: d.completeness === value ? undefined : value,
              }))}
            />
          </span>
          <button type="button" aria-label="Discard" onClick={() => { resetDraft(); setPhase('photo'); }}
            className="min-w-[36px] min-h-[36px] flex items-center justify-center text-[var(--color-text-muted)]">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* The camera flow's position for it. The desk form renders the same
          component BELOW its fields (#277): up here it landed between the
          caret and the form and pushed every field down ~195px the moment a
          scan found a duplicate. */}
      {!showForm && dupeWarning}

      {/*
        `capture="environment"` asks the OS for the REAR camera, which is right
        on a phone (or tablet) held up to a shelf and wrong for a form pick —
        it either does nothing or opens a webcam pointed at your face. A form
        pick drops the attribute and gets a plain file picker instead.

        Mounted here, unconditionally — outside both the showForm fork and the
        phase==='photo' check — because it is the one piece of photo machinery
        both branches share: ManualCreate's "Choose file" button and the flow's
        camera button both just call `photoInput.current?.click()`. Mounting it
        only inside the flow's phase==='photo' block (as it was before this
        fix) meant `photoInput.current` was null whenever ManualCreate
        rendered, so "Choose file" silently no-opped on every fine-pointer
        desk — drag-and-drop covered the same gesture, so nobody noticed until
        this task's "Type it instead" switch gave tablets the same dead button.
      */}
      <input ref={photoInput} type="file" accept="image/*"
        {...(showForm ? {} : { capture: 'environment' as const })}
        className="hidden" onChange={onPhoto} />

      {/* Each step enters as its own move, so advancing reads as progress
          rather than the same page quietly rearranging itself. */}
      {showForm ? (
        /*
         * MANUAL CREATION: a desk (no coarse pointer), or a tablet that has
         * switched to "Type it instead" this session.
         *
         * The three-step flow is built around a camera: photograph the thing,
         * scan its barcode, scan the bin's tag. All three are gestures you make
         * while holding a phone (or a tablet) in front of a shelf. A fine-pointer
         * desk has none of them available, so following the same three screens
         * means pressing Skip twice to reach the only step that works.
         *
         * So the form gets ONE screen: name it, say where it goes, optionally
         * attach a photo. Same draft, same commit — this is a different way in,
         * not a different thing being made.
         */
        <ManualCreate
          draft={draft}
          setDraft={setDraft}
          dest={dest}
          onPickDest={pinDestination}
          // #277: the same one-tap bins the camera flow offers at step 3. The
          // desk is the mode actually used to file fifty things across several
          // bins, and it was the one mode without the shortcut — Change → area
          // select → row click, per bin change.
          recents={recents}
          onChoosePhoto={() => photoInput.current?.click()}
          dragging={dragging}
          setDragging={setDragging}
          onDropFile={(f) => void acceptPhotoFile(f)}
          onSubmit={() => { if (dest) commit(draft, dest); }}
          // The desk form commits through the same optimistic path as the
          // camera flow: the submit returns synchronously, the form clears,
          // and the receipt list below the form carries the network's answer.
          // `createItem.isPending` deliberately dropped — keying the button
          // on a background save would make the NEXT item wait on the
          // previous one's round trip, which is the exact thing this commit
          // shape exists to prevent. (busy is barcode-lookup only now, and
          // unreachable in form mode — kept wired for honesty.)
          pending={busy !== null}
          // #230: the scanner-grade barcode path. The reaction (draft, dupes,
          // vision writes) lives on this page; the field's own behaviour
          // (Enter/blur guards, focus) lives in ManualCreate.
          onLookupBarcode={applyBarcodeLookup}
          // The submit is optimistic, so the transition ManualCreate can see
          // a commit in is the receipt APPENDING — synchronously, at commit —
          // not any network settle. Its focus-return effect keys on this.
          receiptCount={receipts.length}
          // The vision surface the camera flow already renders — same state,
          // same component (VisionReview), same unconfirmed-name styling. A
          // photo dropped on the form already ran identify; before these
          // props its answer was silently unreachable here.
          vision={vision}
          reviewOpen={reviewOpen}
          setReviewOpen={setReviewOpen}
          // What the draft strip used to say about a held photo, said by the
          // panel that already shows the photo (#277) — the strip itself does
          // not render here any more.
          photoStatus={photoStatus}
          reviewOffered={reviewOffered}
          onClearPhoto={clearPhoto}
          // The duplicate warning, rendered BELOW the fields here instead of
          // above them: up top it pushed the field under the caret down ~195px
          // the moment a scan found one.
          dupeWarning={dupeWarning}
          // The session log lives in this form's own right column — see
          // receiptList.
          receiptsSlot={receiptList}
          nameIsSuggested={nameIsSuggested}
          setNameIsSuggested={setNameIsSuggested}
          // #266: the catalogue title a lookup found and did NOT apply over a
          // hand-typed name, offered on the same terms as everything else this
          // page suggests — behind a Keep.
          catalogueName={catalogueName}
          onKeepCatalogueName={() => {
            if (!catalogueName) return;
            setDraft((d) => ({ ...d, name: catalogueName }));
            // Taken deliberately, so it is theirs now: no unconfirmed border,
            // and nothing left to offer.
            setNameIsSuggested(false);
            setCatalogueName(null);
          }}
          seedAreaId={ctxArea || dest?.areaId}
          seedPropertyId={ctxProperty || undefined}
          // Switching back to the flow must land on the LIVE camera, not
          // whatever panel happened to be open when "Type it instead" was
          // tapped. identifying/picking/reviewOpen aren't cleared by a phase
          // change (see resetDraft/setPhase call sites), and the step 2/3
          // ternary checks reviewOpen first, then identifying, then picking —
          // any of the three left stale would resurrect that panel instead of
          // the scanner, so all three are cleared here.
          onUseCamera={tablet ? () => {
            setTypedMode(false);
            setIdentifying(false);
            setPicking(false);
            setReviewOpen(false);
          } : undefined}
        />
      ) : (
      <div key={phase} className={cn('animate-step-in flex flex-col gap-3', phase !== 'photo' && 'flex-1 min-h-0')}>
      {/* ── step 1: the picture ─────────────────────────────────────────── */}
      {phase === 'photo' && (
        <div className="flex flex-col gap-2">
          {/*
            #226: the embedded live camera replaces the OS-input round trip —
            an app-switch plus a per-shot confirm screen, hundreds of times a
            session — with an in-page shutter feeding the SAME acceptPhotoFile
            entry point the input uses. The OS button below survives as the
            fallback fork: no getUserMedia, a rejected acquire, or an explicit
            "Use system camera" all land there via photoFallback.

            #217: this whole subtree renders only when showForm is false — the
            desk form is ManualCreate, on the other side of the fork — so the
            form-side ternary arms that used to sit here (drop-zone drag
            handlers and styling, the ImagePlus icon, the form copy, the
            outline Skip variant) were unreachable and have been collapsed to
            their live sides. The desk drop-zone lives in ManualCreate.
          */}
          {!photoFallback ? (
            <PhotoCamera
              onCapture={(f) => void acceptPhotoFile(f)}
              onFallback={() => setPhotoFallback(true)}
            />
          ) : (
          <button
            type="button"
            onClick={() => photoInput.current?.click()}
            className={cn(
              'flex flex-col items-center justify-center gap-2 border-2 rounded-[var(--radius-sm)] py-10',
              dragging ? 'border-[var(--color-primary)] bg-[var(--color-primary-bg)]' : 'border-[var(--color-text)]',
              // Viewport cap, tablet only — the phone side of this block is
              // already sized by its py-10 padding alone.
              tablet && 'max-h-[clamp(260px,50vh,420px)] overflow-hidden',
            )}
          >
            <Camera className="w-8 h-8" />
            <span className="font-mono text-xs uppercase tracking-[0.1em] font-bold">
              Take a photo of the item
            </span>
          </button>
          )}
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
            <VisionReview vision={vision} draft={draft} setDraft={setDraft}
              onClose={() => setReviewOpen(false)} />
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
                if (d.name || d.photo || d.barcode) commit(d, { id: bin.id, name: bin.name, areaId: bin.areaId });
                else setPhase('photo');
              }}
              onClose={() => setPicking(false)}
            />
          ) : phase === 'identify' && canMatch ? (
            // The photo already named this with a brand attached — a real
            // product search is running in the background (queued on commit,
            // see below). Step 2 becomes a status chip instead of asking for
            // a barcode; "Search" and the name field below still work as the
            // manual escape hatch, unchanged.
            <div className="flex items-center gap-2 border border-[var(--color-rule)] rounded-[var(--radius-sm)] px-3 py-2">
              <Sparkles className="h-4 w-4 text-[var(--color-primary)]" />
              <span className="text-sm">Finding this product — pick it later in Alerts</span>
            </div>
          ) : phase === 'identify' ? (
            // html5-qrcode sizes its video by width only, so on a wide
            // landscape tablet the stream would otherwise take over the page —
            // the cap is tablet-only; the phone wrapper is unstyled. The base
            // classes (flex flex-col flex-1 min-h-0) are NOT decoration — this
            // wrapper is itself a flex item of the step container above,
            // which promises "exactly ONE of four things fills the space" via
            // flex-1 min-h-0 on every sibling. Without repeating that contract
            // here, this wrapper becomes an auto-height flex item that
            // swallows CameraScanner's own flex-1 (phones lost ~200px of
            // scanner height to this before the fix), AND on tablet flex-1 is
            // what makes the wrapper grow enough for max-h to ever bind.
            <div className={cn('flex flex-col flex-1 min-h-0', tablet && 'max-h-[clamp(240px,38vh,300px)] overflow-hidden')}>
              <ProductScanner
                label={busy ?? 'Scan product barcode'}
                onBarcode={handleCode}
                onClose={scannerClose}
              />
            </div>
          ) : (
            <div className={cn('flex flex-col flex-1 min-h-0', tablet && 'max-h-[clamp(230px,36vh,280px)] overflow-hidden')}>
              <TagScanner
                label={busy ?? 'Scan tote/area tag'}
                onTag={handleCode}
                onClose={scannerClose}
              />
            </div>
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
                          if (d.name || d.photo || d.barcode) commit(d, r);
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
      )}
      {/* ── receipts ─────────────────────────────────────────────────── */}
      {/* The desk form renders this itself, inside its own grid — see
          receiptList. */}
      {!showForm && receiptList}
    </div>
  );
}

export default Capture;


/**
 * "box only" / "spares only".
 *
 * Two toggles rather than a three-way picker: 'complete' is the default and
 * needs no control, so the only thing to express is the exception. Tapping the
 * active one returns to complete.
 *
 * One component, two call sites (#277): the camera flow's draft strip, and the
 * desk form beside Quantity — the strip's one genuinely unique control, which
 * had to survive the strip not rendering there.
 */
function CompletenessPills({ value, onToggle, className }: {
  value?: 'box_only' | 'accessories_only';
  onToggle: (v: 'box_only' | 'accessories_only') => void;
  className?: string;
}) {
  return (
    <span className={cn('mt-1 flex gap-1', className)}>
      {PARTIAL_OPTIONS.map(({ value: option, label }) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          onClick={() => onToggle(option)}
          className={cn(
            'font-mono text-[9px] uppercase tracking-[0.06em] px-1.5 py-0.5 rounded-full border',
            value === option
              ? 'bg-[var(--color-text)] text-[var(--color-bg)] border-[var(--color-text)]'
              : 'border-[var(--color-rule)] text-[var(--color-text-muted)]',
          )}
        >
          {label}
        </button>
      ))}
    </span>
  );
}

/**
 * "You already have one of these" — shown before you add another.
 *
 * The rows open the item you already own in a NEW TAB (#277). They used to
 * navigate in place, which unmounted Capture: the banner's own copy says
 * "adding another is fine — this is a heads-up, not a block", and its only
 * actionable control ended the session, taking the draft, any un-uploaded
 * photo Blob and every receipt's Queue/Print/Retry handle with it. Going to
 * look at what you already own is not a decision to abandon what you are
 * holding.
 */
function DupeWarning({ dupes, onDismiss }: { dupes: Dupe[]; onDismiss: () => void }) {
  return (
    <div className="flex items-start gap-2 border-2 border-[var(--color-amber)] rounded-[var(--radius-sm)] p-2.5 shrink-0">
      <AlertTriangle className="w-4 h-4 shrink-0 text-[var(--color-amber)] mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className="block font-mono text-[10px] uppercase tracking-[0.1em] font-bold text-[var(--color-amber)]">
          you already have {dupes.length === 1 ? 'one of these' : `${dupes.length} of these`}
        </span>
        {dupes.slice(0, 3).map((d) => (
          <button
            key={d.id}
            type="button"
            // noopener because the opened tab must not hold a handle on this
            // one — and min-h because a 20px row is not a target on a tablet.
            onClick={() => window.open(`/item/${d.id}`, '_blank', 'noopener')}
            className="flex w-full min-h-[36px] items-baseline gap-1 text-left text-sm underline decoration-dotted"
          >
            <span className="truncate">{d.name}</span>
            <span className="truncate font-mono text-[10px] text-[var(--color-text-muted)]">
              {' · '}{[d.areaName, d.containerName].filter(Boolean).join(' › ')}
            </span>
          </button>
        ))}
        <span className="block font-mono text-[9px] uppercase tracking-[0.06em] text-[var(--color-text-muted)] mt-0.5">
          adding another is fine — this is a heads-up, not a block
        </span>
      </span>
      <button type="button" aria-label="Dismiss" onClick={onDismiss}
        className="min-w-[32px] min-h-[32px] flex items-center justify-center text-[var(--color-text-muted)]">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

/**
 * The "From the photo" review panel: everything the model offered beyond the
 * name, each field behind its own Keep — the consent gate the Vision type
 * describes. Extracted verbatim from the camera flow's step 2 so the desk
 * form (#230) can render the SAME surface: one component, both call sites,
 * and the styling and consent rules cannot fork.
 */
function VisionReview({ vision, draft, setDraft, onClose }: {
  vision: Vision;
  draft: Draft;
  setDraft: React.Dispatch<React.SetStateAction<Draft>>;
  onClose: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 border-2 border-[var(--color-text)] rounded-[var(--radius-sm)] p-3 flex-1 min-h-0 overflow-y-auto">
      <div className="flex items-center justify-between shrink-0">
        <span className="font-mono text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
          From the photo — {vision.confidence === 'high' ? 'read' : 'guessed'}
        </span>
        <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
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
  );
}

/**
 * Creating something at a desk.
 *
 * The three-step flow is a camera flow: photograph the thing, scan its barcode,
 * scan the bin's tag. Every one of those is a gesture you make holding a phone
 * in front of a shelf, and at a desk none of them are available — so following
 * the same three screens means pressing Skip twice to reach the one step that
 * still works.
 *
 * This is the same draft and the same commit, asked for the way a keyboard asks:
 * everything visible at once, name first and focused, nothing hidden behind a
 * step you cannot complete. The photo is optional and last, because at a desk it
 * usually does not exist.
 */
function ManualCreate({
  draft, setDraft, dest, onPickDest, recents, onChoosePhoto, dragging, setDragging,
  onDropFile, onSubmit, pending, onLookupBarcode, receiptCount,
  vision, reviewOpen, setReviewOpen, photoStatus, reviewOffered, onClearPhoto,
  dupeWarning, receiptsSlot, nameIsSuggested, setNameIsSuggested,
  catalogueName, onKeepCatalogueName,
  seedAreaId, seedPropertyId, onUseCamera,
}: {
  draft: Draft;
  setDraft: React.Dispatch<React.SetStateAction<Draft>>;
  dest: Destination | null;
  onPickDest: (d: Destination) => void;
  /** The remembered bins, newest first — the camera flow's step-3 chips. */
  recents: Destination[];
  onChoosePhoto: () => void;
  dragging: boolean;
  setDragging: (v: boolean) => void;
  onDropFile: (f: File) => void;
  onSubmit: () => void;
  pending: boolean;
  /** The page's reaction to a barcode (#230) — lookup + dupe check + draft
   *  and vision writes. This component owns only the FIELD's behaviour:
   *  when to fire, when not to fire twice, and where focus goes after.
   *  `fromNameField` marks the rescue path — a code a scanner typed into
   *  Name, which must not be read back as a hand-typed name. */
  onLookupBarcode: (
    code: string,
    opts?: { fromNameField?: boolean },
  ) => Promise<'hit' | 'miss' | 'failed'>;
  /** Ticks up when a commit appends its receipt — the submit is optimistic,
   *  so this is the only transition a completed submit is visible in here. */
  receiptCount: number;
  /** The camera flow's vision state, rendered here with the same component
   *  and the same unconfirmed-name styling — no second variant. */
  vision: Vision | null;
  reviewOpen: boolean;
  setReviewOpen: (v: boolean) => void;
  /** What the page says about a held photo — rendered on the photo panel here. */
  photoStatus: string;
  /** Whether the model offered anything beyond the name, i.e. worth reviewing. */
  reviewOffered: boolean;
  /** Remove the held photo, keeping the rest of the draft. */
  onClearPhoto: () => void;
  /** The duplicate warning, rendered below the fields rather than above them. */
  dupeWarning: React.ReactNode;
  /** The session log, rendered in this form's right column (#277). */
  receiptsSlot: React.ReactNode;
  nameIsSuggested: boolean;
  setNameIsSuggested: (v: boolean) => void;
  /** #266: a catalogue title found by a lookup that refused to overwrite a
   *  hand-typed name. Rendered as an offer under Name; null when there is
   *  nothing to offer. */
  catalogueName: string | null;
  onKeepCatalogueName: () => void;
  seedAreaId?: number;
  seedPropertyId?: number;
  /**
   * Present only for a tablet that has switched to "Type it instead" — lets
   * it switch back to the camera flow. Absent everywhere else (fine-pointer
   * desk), so this component's output is unchanged there.
   */
  onUseCamera?: () => void;
}) {
  const [picking, setPicking] = React.useState(false);
  /** A lookup in flight: the submit is disabled so the form cannot commit a
   *  draft the lookup is about to rewrite underneath it. */
  const [lookingUp, setLookingUp] = React.useState(false);
  /**
   * What is literally in the quantity box, mid-edit. `null` means "follow the
   * draft" — the state the field is in before it is touched, after a blur, and
   * after every commit, so a quantity Kept from the photo still shows up here.
   * See the field itself for why it cannot coerce per keystroke (#277).
   */
  const [qtyText, setQtyText] = React.useState<string | null>(null);
  const nameRef = React.useRef<HTMLInputElement>(null);
  const barcodeRef = React.useRef<HTMLInputElement>(null);
  /**
   * The last barcode a lookup actually ran for. A USB scanner is a keyboard
   * that types the code and sends Enter, and the field blurs a moment later
   * when focus moves on — Enter followed by blur must be ONE lookup, not two,
   * so both handlers funnel through lookupIfNew and this guard. A ref, not
   * state: the blur can land before React re-renders the Enter's setState.
   */
  const lastLookedUp = React.useRef<string | null>(null);
  /**
   * #264: did the item currently being built get its identity through the
   * BARCODE field?
   *
   * The two halves of #230 are each correct and each assume the other's user.
   * The post-commit focus return exists for a typist, whose next gesture is
   * typing a name; the barcode field's Enter lookup exists for a USB reader,
   * whose next gesture is pulling the trigger again. Sending a scanner
   * operator's caret to Name means the next scan TYPES the barcode into the
   * name field and its terminating Enter submits it — an item literally named
   * `098765432109`, with no catalogue lookup, no productId and no duplicate
   * check.
   *
   * So focus goes back to the field the finished item came FROM. A ref, not
   * state: it is written inside an async handler and read by the effect
   * below, both of which must see the value as of NOW.
   */
  const cameFromBarcode = React.useRef(false);
  React.useEffect(() => {
    // Mount, and again each time a submit completes (= its receipt appends;
    // the commit is optimistic so that is synchronous with the submit): the
    // next item starts where the last one started — Name for a typist,
    // the barcode field for a scanner (#264).
    const fromBarcode = cameFromBarcode.current;
    cameFromBarcode.current = false;
    (fromBarcode ? barcodeRef.current : nameRef.current)?.focus();
    // The next item's quantity is the draft's again (i.e. blank = 1), not the
    // digits left in the box by the last one.
    setQtyText(null);
    // New item, clean guard: the next unit of the SAME product re-scans the
    // same code, and the dedupe above must not swallow that lookup.
    lastLookedUp.current = null;
  }, [receiptCount]);

  /** Fire the lookup once per distinct value — see lastLookedUp. */
  async function lookupIfNew(raw: string, opts?: { fromNameField?: boolean }) {
    const code = raw.trim();
    if (!code || lookingUp || code === lastLookedUp.current) return;
    lastLookedUp.current = code;
    // This item was identified through the barcode field, so the NEXT one
    // starts there too — see cameFromBarcode. True for the rescue path as
    // well: a code that arrived in Name came off a trigger pull, and the
    // operator's next gesture is another one.
    cameFromBarcode.current = true;
    setLookingUp(true);
    const outcome = await onLookupBarcode(code, opts);
    setLookingUp(false);
    if (outcome === 'failed') {
      // Re-arm: pressing Enter again on the unchanged code is a retry, not
      // a duplicate.
      lastLookedUp.current = null;
    } else {
      // Both remaining outcomes land in Name: a miss to type the name the
      // catalogue didn't have, a hit to read what it did — and Enter there
      // submits, so scan → glance → Enter is the whole loop.
      nameRef.current?.focus();
    }
  }

  const ready = draft.name.trim().length > 0 && dest != null;

  /**
   * The submit's last check: is this "name" actually a barcode? (#264
   * follow-up.)
   *
   * #264 fixed where focus goes BETWEEN items. The first scan of a session
   * still starts with the caret in Name — that is the correct place for it to
   * start, and a typist would be wrong-footed by anything else — so a USB
   * reader's first trigger pull types the code there and its Enter submits
   * it. Guarding the submit instead of the focus covers that, plus the paste,
   * plus anyone who clicked into Name by hand.
   *
   * The code is moved into the field it belongs in and run through the SAME
   * lookup a scan into that field would have got, so the item still gets its
   * catalogue name, its productId and its duplicate check. Returns true when
   * it took the submit over.
   */
  function rescuedBarcodeInName(): boolean {
    const typed = draft.name.trim();
    // Only when the barcode field is empty: a code already sitting there
    // means these digits are something else (a model number, a serial), and
    // guessing at that point would be the same sin in the other direction.
    if (!BARE_BARCODE.test(typed) || (draft.barcode ?? '').trim()) return false;
    setDraft((d) => ({ ...d, name: '', barcode: typed }));
    // fromNameField: the lookup must not read those digits back out of the
    // draft as a hand-typed name and "protect" them under #266.
    void lookupIfNew(typed, { fromNameField: true });
    return true;
  }

  return (
    <div className="flex flex-col gap-3">
      {onUseCamera && (
        <div className="flex items-center justify-end">
          <Button variant="outline" size="sm" className="shrink-0" onClick={onUseCamera}>
            <Camera className="w-4 h-4" />
            Use camera
          </Button>
        </div>
      )}
    {/* The same review surface the camera flow shows on step 2, above the
        fields it feeds. A photo dropped on this form already ran identify;
        this is the display surface that used to be missing (#230). */}
    {reviewOpen && vision && (
      <VisionReview vision={vision} draft={draft} setDraft={setDraft}
        onClose={() => setReviewOpen(false)} />
    )}
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(260px,320px)] items-start gap-6">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (pending || lookingUp) return;
          // Before the ready gate, and before anything is written: a bare
          // code in Name is a mis-fielded scan whichever control fired this
          // submit — the button, or the reader's own Enter.
          if (rescuedBarcodeInName()) return;
          if (ready) onSubmit();
        }}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor="mc-name" className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
            What is it?
          </label>
          <Input
            id="mc-name"
            ref={nameRef}
            value={draft.name}
            maxLength={255}
            placeholder="Cordless drill"
            // Same unconfirmed styling as the camera flow's name field: a
            // model-suggested name must not look like one a person typed.
            className={cn(nameIsSuggested && 'border-dashed border-[var(--color-primary)]')}
            onChange={(e) => {
              // Editing it makes it theirs.
              setNameIsSuggested(false);
              setDraft((d) => ({ ...d, name: e.target.value }));
            }}
          />
          {/* #266: the catalogue's own title for the barcode that was just
              looked up, when it disagreed with a name a person typed. Shown
              rather than applied — the same Keep the vision panel uses, so
              nothing this page suggests arrives without being accepted. */}
          {catalogueName && (
            <div className="flex items-center gap-2 pt-0.5">
              <p className="min-w-0 flex-1 truncate text-xs text-[var(--color-text-secondary)]">
                <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
                  catalogue{' '}
                </span>
                {catalogueName}
              </p>
              <Button type="button" size="sm" variant="outline" className="shrink-0"
                onClick={onKeepCatalogueName}>
                Keep
              </Button>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="mc-desc" className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
            Description <span className="normal-case tracking-normal">— optional</span>
          </label>
          <Input
            id="mc-desc"
            value={draft.description ?? ''}
            placeholder="Anything you would want to search for later"
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value || undefined }))}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="mc-qty" className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
              Quantity
            </label>
            {/*
              The field holds a RAW STRING and coerces on the way out — the
              shape entity-form.tsx's quantityField already uses (#277).
              Coercing per keystroke made the one gesture most people use file
              the wrong number: `Math.max(1, Number(v) || 1)` resurrected the 1
              the moment you backspaced it away, so clearing the field and
              typing 2 filed the item with 12. Only the spinner and select-all
              survived that, and both are gestures people reach for second.
            */}
            <Input
              id="mc-qty" type="number" min={1} step={1} inputMode="numeric"
              value={qtyText ?? String(draft.quantity ?? 1)}
              onChange={(e) => {
                const raw = e.target.value;
                setQtyText(raw);
                // The draft takes a real quantity or nothing at all: an empty
                // (or half-typed) field means "unsaid", and commit() omits it
                // so the column's own default of 1 carries the item.
                const n = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
                setDraft((d) => ({ ...d, quantity: n >= 1 ? n : undefined }));
              }}
              // Leaving the field is the coercion point: whatever the draft
              // ended up holding is what the field now shows, so a blank one
              // reads back as the 1 it will be saved as.
              onBlur={() => setQtyText(null)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="mc-barcode" className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
              Barcode <span className="normal-case tracking-normal">— optional</span>
            </label>
            {/* Typed rather than scanned. A USB barcode reader is a keyboard
                that ends every code with Enter — so Enter here fires the
                SAME lookup + dupe check the camera flow runs, and must never
                submit the form (#230). Blur covers the hand-typed code that
                tabs on without pressing Enter; lookupIfNew keeps the pair
                from running twice for one unchanged value. */}
            <Input
              id="mc-barcode"
              ref={barcodeRef}
              value={draft.barcode ?? ''}
              placeholder="Type or scan"
              onChange={(e) => setDraft((d) => ({ ...d, barcode: e.target.value || undefined }))}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                void lookupIfNew(e.currentTarget.value);
              }}
              onBlur={(e) => {
                if (e.currentTarget.value.trim()) void lookupIfNew(e.currentTarget.value);
              }}
            />
          </div>
        </div>

        {/* The draft strip's one genuinely unique control, kept when the rest
            of the strip stopped rendering here (#277). Next to Quantity
            because it is the same kind of statement: how much of the thing is
            actually in the bin. */}
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
            What is in the bin?
          </span>
          <CompletenessPills
            className="mt-0"
            value={draft.completeness}
            onToggle={(value) => setDraft((d) => ({
              ...d,
              completeness: d.completeness === value ? undefined : value,
            }))}
          />
          {!draft.completeness && (
            <span className="font-mono text-[9px] uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
              the whole thing
            </span>
          )}
        </div>

        {/* WHERE is required, so it is stated rather than implied. */}
        <div className="flex flex-col gap-1.5">
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
            Where does it go?
          </span>
          {dest ? (
            <div className="flex items-center gap-2 rounded-[var(--radius-sm)] border-2 border-[var(--color-text)] px-3 py-2">
              <MapPin className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">{dest.name}</span>
              <Button type="button" variant="ghost" size="sm" onClick={() => setPicking(true)}>Change</Button>
            </div>
          ) : (
            <Button type="button" variant="outline" onClick={() => setPicking(true)}>
              <List className="h-4 w-4" /> Choose a bin
            </Button>
          )}

          {/* #277: the camera flow's recent-bin chips, on the surface that
              actually files fifty things across several bins. One click here
              replaces Change → area select → row click. Tapping a chip only
              pins the bin — the flow's version commits on tap because there
              the bin IS the last question; here the form still has a submit. */}
          {recents.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {recents.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => onPickDest(r)}
                  className={cn(
                    'font-mono text-[10px] uppercase tracking-[0.06em] rounded-full px-3 min-h-[32px] border',
                    dest?.id === r.id
                      ? 'border-[var(--color-primary)] text-[var(--color-primary)] font-bold'
                      : 'border-[var(--color-rule)] text-[var(--color-text)]',
                  )}
                >
                  {r.name}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 pt-1">
          {/* Disabled mid-lookup too: committing while the lookup is in
              flight would save a draft the answer is about to rewrite. */}
          <Button type="submit" disabled={!ready || pending || lookingUp} className="min-w-[160px]">
            <Check className="h-4 w-4" />
            {pending ? 'Saving…' : lookingUp ? 'Looking it up…' : 'Create item'}
          </Button>
          {/* Says WHICH requirement is missing rather than just sitting dead. */}
          {!ready && (
            <span className="whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
              {draft.name.trim() ? 'pick a bin first' : 'name it first'}
            </span>
          )}
        </div>

        {/* Below the fields, not above them (#277): a duplicate is a heads-up
            about the item you are typing, and nothing about it justifies
            moving the field under the caret 195px down the page. */}
        {dupeWarning}
      </form>

      {/* The photo is optional and last: at a desk there usually is not one. */}
      <div className="flex flex-col gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
          Photo — optional
        </span>
        {draft.photoUrl ? (
          <>
            <img src={draft.photoUrl} alt="" className="h-[220px] w-full rounded-[var(--radius-sm)] border border-[var(--color-rule)] object-cover" />
            {/* What the camera flow's draft strip says about a held photo,
                said here instead — this panel is the desk's view of it. */}
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 font-mono text-[9px] uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
                {photoStatus}
              </span>
              {/* Only the photo goes — the name, the barcode and anything
                  Kept stay. The strip's X threw the whole draft away. */}
              <Button type="button" size="sm" variant="ghost" className="shrink-0" onClick={onClearPhoto}>
                <X className="h-4 w-4" />
                Remove
              </Button>
            </div>
            {reviewOffered && (
              <button type="button" onClick={() => setReviewOpen(true)}
                className="text-left font-mono text-[9px] uppercase tracking-[0.06em] text-[var(--color-primary)] underline">
                review what it found
              </button>
            )}
          </>
        ) : (
          <button
            type="button"
            onClick={onChoosePhoto}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const f = e.dataTransfer.files?.[0];
              if (f) onDropFile(f);
            }}
            className={cn(
              'flex h-[220px] w-full flex-col items-center justify-center gap-2 rounded-[var(--radius-sm)] border-2 border-dashed',
              dragging ? 'border-[var(--color-primary)] bg-[var(--color-primary-bg)]' : 'border-[var(--color-rule)]',
            )}
          >
            <ImagePlus className="h-7 w-7 text-[var(--color-text-muted)]" />
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
              drop one here, or choose a file
            </span>
          </button>
        )}

        {/* The session log, in the 320px column it already owns (#277).
            Stacked under the form it fell below the fold at ~10 items — and a
            fifty-item session is exactly when the log IS the work product. */}
        {receiptsSlot}
      </div>

      {picking && (
        <DestinationPicker
          seedAreaId={seedAreaId}
          seedPropertyId={seedPropertyId}
          onPick={(bin) => {
            onPickDest({ id: bin.id, name: bin.name, areaId: bin.areaId });
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
    </div>
  );
}

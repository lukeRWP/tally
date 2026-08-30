import { useEffect, useRef, useState, useCallback, useId } from 'react';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';
import { Camera, CameraOff, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface CameraScannerProps {
  onBarcodeScanned: (code: string) => void;
  /**
   * Leave the scanner entirely. OPTIONAL, and omitting it is a real choice a
   * caller makes rather than an oversight: `Stop` pauses the decode loop and
   * is recoverable in one tap, while `Close` unmounts whatever hosts the
   * scanner — in capture that discards the held photo Blob, the typed name
   * and any Kept vision fields, with no confirm and no undo. Two identical
   * 32px controls 8px apart, one benign and one destructive, is the classic
   * coarse-pointer mis-tap (#268), so a caller on a finger-driven screen that
   * has another way out passes nothing here and the button is not rendered.
   */
  onClose?: () => void;
  isActive: boolean;
  /**
   * The action, drawn INSIDE the frame above the decode box. The instruction
   * belongs where the eye already is — on the viewfinder you are aiming.
   */
  label?: string;
  /**
   * Which symbologies to decode. Constraining this is not just an
   * optimisation — a scanner that can only read one kind of code cannot
   * mistake one job for another, and each frame is cheaper to decode.
   */
  formats?: Html5QrcodeSupportedFormats[];
}

const SUPPORTED_FORMATS = [
  Html5QrcodeSupportedFormats.QR_CODE,
  Html5QrcodeSupportedFormats.UPC_A,
  Html5QrcodeSupportedFormats.UPC_E,
  Html5QrcodeSupportedFormats.EAN_13,
  Html5QrcodeSupportedFormats.EAN_8,
  Html5QrcodeSupportedFormats.CODE_128,
  Html5QrcodeSupportedFormats.CODE_39,
];

export function CameraScanner({ onBarcodeScanned, onClose, isActive, formats, label }: CameraScannerProps) {
  const reactId = useId();
  const scannerId = useRef(`scanner-${reactId.replace(/:/g, '')}`).current;
  const scannerRef = useRef<Html5Qrcode | null>(null);
  /**
   * Start and stop are serialised through one promise chain, and `desired` is
   * the only source of truth for which one should win.
   *
   * The old `getState() === 2` guard could never fire during startup:
   * StateManagerImpl initialises to NOT_STARTED and only transitions inside
   * the `.then()` of `camera.render()`, i.e. after getUserMedia resolves. A
   * stop landing in that window skipped `stop()` on an instance whose ref had
   * already been nulled — leaving a live, still-decoding camera that nothing
   * could reach. On step 3 that rewrote the destination under an open picker.
   */
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const desired = useRef(isActive);
  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The DECODE box in CSS px — exactly the qrbox handed to the library.
   *
   * The brackets are drawn on THIS, not on the frame. html5-qrcode centres
   * qrRegion in the video (getShadedRegionBounds) and the video is centred in
   * the frame, so a box of these dimensions at frame-centre is precisely the
   * region that gets read. Brackets pinned to the frame's edges over-claimed
   * the readable area by 1.6-3.6x depending on frame height.
   */
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const lastScannedRef = useRef<string>('');
  const lastScannedTimeRef = useRef<number>(0);
  const callbackRef = useRef(onBarcodeScanned);
  callbackRef.current = onBarcodeScanned;

  const teardown = useCallback(async () => {
    const scanner = scannerRef.current;
    scannerRef.current = null;
    if (scanner) {
      // Unconditional. stop() throws synchronously when it was never running,
      // which is cheaper to catch than it is to predict.
      try { await scanner.stop(); } catch { /* was not running */ }
      try { scanner.clear(); } catch { /* ignore */ }
    }
    const el = document.getElementById(scannerId);
    if (el) el.replaceChildren();
    setBox(null);
    setIsScanning(false);
  }, [scannerId]);

  const bringUp = useCallback(async () => {
    if (!desired.current) return;
    await teardown();
    setError(null);

    // Let the DOM settle after teardown.
    await new Promise((r) => setTimeout(r, 100));
    if (!desired.current) return;

    const container = document.getElementById(scannerId);
    if (!container) return;
    container.replaceChildren();

    // Must be read from #scannerId: the library sizes the video from the same
    // clientWidth, so this is guaranteed to be the qrbox it actually uses.
    const width = container.clientWidth || 300;
    const w = Math.min(Math.floor(width * 0.8), 300);
    const h = Math.floor(w * 0.6);

    const scanner = new Html5Qrcode(scannerId, {
      formatsToSupport: formats ?? SUPPORTED_FORMATS,
      verbose: false,
    });
    scannerRef.current = scanner;

    try {
      await scanner.start(
        { facingMode: 'environment' },
        { fps: 15, qrbox: { width: w, height: h } },
        (text: string) => {
          if (!desired.current) return;
          const now = Date.now();
          if (text === lastScannedRef.current && now - lastScannedTimeRef.current < 2000) {
            // Refresh the timestamp while the same code stays in view, so a
            // continuously-visible code fires exactly once.
            lastScannedTimeRef.current = now;
            return;
          }
          lastScannedRef.current = text;
          lastScannedTimeRef.current = now;
          callbackRef.current(text);
        },
        () => {},
      );
    } catch (err) {
      scannerRef.current = null;
      try { scanner.clear(); } catch { /* ignore */ }
      setError(err instanceof Error ? err.message : 'Camera access denied');
      setIsScanning(false);
      return;
    }

    // The camera can finish negotiating long after the caller changed its mind
    // — an unbounded window on a first-run permission prompt.
    if (!desired.current) { await teardown(); return; }
    setBox({ w, h });
    setIsScanning(true);
  }, [scannerId, teardown, formats]);

  const enqueue = useCallback((fn: () => Promise<void>) => {
    chain.current = chain.current.then(fn, fn);
  }, []);

  useEffect(() => {
    desired.current = isActive;
    enqueue(isActive ? bringUp : teardown);
    return () => { desired.current = false; enqueue(teardown); };
    // Only react to isActive — bringUp/teardown read `desired`, not props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  return (
    // flex-1/min-h-0 make the frame absorb whatever height the page has left.
    // Both are inert in a non-flex parent, so this is safe for every caller.
    <div className="flex flex-col gap-2 flex-1 min-h-0">
      {/* The height, the centring and the clip MUST live on this outer div and
          never on #scannerId: the library forces #scannerId to
          position:relative and pins #qr-shaded-region to its inset:0 with
          border widths derived from the VIDEO's height. Constrain #scannerId
          and the transparent window collapses to nothing — a flat 48% slab. */}
      <div className="relative w-full flex-1 min-h-[220px] max-h-[420px] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-black flex items-center justify-center">
        <div id={scannerId} className="w-full shrink-0" />

        {box && isScanning && (
          <div
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none z-10"
            style={{ width: `${box.w}px`, height: `${box.h}px` }}
          >
            <div className="absolute top-0 left-0 w-6 h-6 border-t-[3px] border-l-[3px] border-[var(--color-primary)] rounded-tl-sm" />
            <div className="absolute top-0 right-0 w-6 h-6 border-t-[3px] border-r-[3px] border-[var(--color-primary)] rounded-tr-sm" />
            <div className="absolute bottom-0 left-0 w-6 h-6 border-b-[3px] border-l-[3px] border-[var(--color-primary)] rounded-bl-sm" />
            <div className="absolute bottom-0 right-0 w-6 h-6 border-b-[3px] border-r-[3px] border-[var(--color-primary)] rounded-br-sm" />
          </div>
        )}

        {label && (
          <div className="absolute top-2 left-10 right-10 flex justify-center pointer-events-none z-10">
            <span className="font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-white text-center leading-6 px-2 rounded-[var(--radius-sm)] bg-black/55 [text-shadow:0_1px_2px_rgba(0,0,0,0.9)]">
              {label}
            </span>
          </div>
        )}

        {!isScanning && !error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[var(--color-card)]">
            <Camera className="w-10 h-10 text-[var(--color-text-muted)]" />
            <p className="text-sm text-[var(--color-text-muted)]">Starting camera...</p>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[var(--color-card)] p-4">
            <CameraOff className="w-10 h-10 text-[var(--color-red)]" />
            <p className="text-sm text-[var(--color-text)] text-center line-clamp-3">{error}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => { desired.current = true; enqueue(bringUp); }}
            >
              <RefreshCw className="w-4 h-4" /> Try again
            </Button>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between shrink-0">
        <p className="text-xs text-[var(--color-text-muted)]">
          {isScanning ? 'Point camera at a barcode' : 'Camera inactive'}
        </p>
        <div className="flex gap-2">
          {isScanning ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => { desired.current = false; enqueue(teardown); }}
            >
              <CameraOff className="w-4 h-4" /> Stop
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => { desired.current = true; enqueue(bringUp); }}
            >
              <Camera className="w-4 h-4" /> Start
            </Button>
          )}
          {onClose && <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>}
        </div>
      </div>
    </div>
  );
}

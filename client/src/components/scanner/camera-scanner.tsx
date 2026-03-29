import { useEffect, useRef, useState, useCallback, useId } from 'react';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';
import { Camera, CameraOff, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface CameraScannerProps {
  onBarcodeScanned: (code: string) => void;
  onClose: () => void;
  isActive: boolean;
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

export function CameraScanner({ onBarcodeScanned, onClose, isActive }: CameraScannerProps) {
  const reactId = useId();
  const scannerId = useRef(`scanner-${reactId.replace(/:/g, '')}`).current;
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const initLock = useRef(false);
  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastScannedRef = useRef<string>('');
  const lastScannedTimeRef = useRef<number>(0);
  const callbackRef = useRef(onBarcodeScanned);
  callbackRef.current = onBarcodeScanned;

  const cleanup = useCallback(async () => {
    const scanner = scannerRef.current;
    scannerRef.current = null;
    if (scanner) {
      try {
        const state = scanner.getState();
        if (state === 2) await scanner.stop();
        scanner.clear();
      } catch { /* ignore */ }
    }
    const el = document.getElementById(scannerId);
    if (el) el.replaceChildren();
    setIsScanning(false);
  }, [scannerId]);

  const start = useCallback(async () => {
    // Prevent concurrent initialization
    if (initLock.current) return;
    initLock.current = true;

    try {
      await cleanup();
      setError(null);

      // Let the DOM settle after cleanup
      await new Promise((r) => setTimeout(r, 100));

      // Verify container exists and is empty
      const container = document.getElementById(scannerId);
      if (!container) { initLock.current = false; return; }
      container.replaceChildren();

      const scanner = new Html5Qrcode(scannerId, {
        formatsToSupport: SUPPORTED_FORMATS,
        verbose: false,
      });
      scannerRef.current = scanner;

      await scanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 250, height: 250 }, aspectRatio: 1.0 },
        (text: string) => {
          const now = Date.now();
          if (text === lastScannedRef.current && now - lastScannedTimeRef.current < 2000) return;
          lastScannedRef.current = text;
          lastScannedTimeRef.current = now;
          callbackRef.current(text);
        },
        () => {}
      );
      setIsScanning(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Camera access denied';
      setError(message);
      setIsScanning(false);
    } finally {
      initLock.current = false;
    }
  }, [scannerId, cleanup]);

  useEffect(() => {
    if (isActive) {
      start();
    } else {
      cleanup();
    }
    return () => { cleanup(); };
    // Only react to isActive changes — start/cleanup are stable refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  return (
    <div className="flex flex-col gap-4">
      <div
        className={cn(
          'relative w-full overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-black',
          'min-h-[300px]'
        )}
      >
        <div id={scannerId} className="w-full" />

        {!isScanning && !error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[var(--color-card)]">
            <Camera className="w-10 h-10 text-[var(--color-text-muted)]" />
            <p className="text-sm text-[var(--color-text-muted)]">Starting camera...</p>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[var(--color-card)] p-4">
            <CameraOff className="w-10 h-10 text-[var(--color-red)]" />
            <p className="text-sm text-[var(--color-text)] text-center">{error}</p>
            <Button variant="outline" size="sm" onClick={start}>
              <RefreshCw className="w-4 h-4" /> Try again
            </Button>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between">
        <p className="text-xs text-[var(--color-text-muted)]">
          {isScanning ? 'Point camera at a barcode' : 'Camera inactive'}
        </p>
        <div className="flex gap-2">
          {isScanning ? (
            <Button variant="outline" size="sm" onClick={cleanup}>
              <CameraOff className="w-4 h-4" /> Stop
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={start}>
              <Camera className="w-4 h-4" /> Start
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}

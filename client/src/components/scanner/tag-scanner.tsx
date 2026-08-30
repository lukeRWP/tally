import * as React from 'react';
import { Html5QrcodeSupportedFormats } from 'html5-qrcode';
import { CameraScanner } from './camera-scanner';
import { toast } from '@/components/ui/toast';
import { extractTlyCode } from '@/lib/tly';

/**
 * Reads a TALLY TAG — the label the app generates for an area or a bin and that
 * you print and stick on the thing.
 *
 * THE RULE IS "OUR SYMBOLOGIES IN, RETAIL SYMBOLOGIES OUT", not "QR only".
 *
 * What tally prints is what this must read. `labels.service.js` puts a QR on
 * every preset and, on the 4x6 contents manifest, a Code 128 of the same bare
 * TLY code beside it (`_drawBarcode(doc, header.qrCode, …)`) — precisely so a
 * manifest can be read with a linear scan instead of framing a QR. Leaving
 * CODE_128 out of this list meant tally's own scanner could not read tally's
 * own printed barcode, which is half of #109.
 *
 * The retail formats — UPC_A, UPC_E, EAN_13, EAN_8 — stay out, and that
 * exclusion is the real content of the original "QR only" note: a scanner that
 * cannot decode a UPC can never mistake a cereal box for a shelf. The two jobs
 * are genuinely different and genuinely separate — this one answers "which
 * place is this?", the product scanner answers "which product is this?" — and a
 * tally code is never a retail code, so nothing is lost by refusing them.
 *
 * Pinned by tag-scanner.formats.test.ts, so a later tidy-up cannot quietly
 * shrink it back.
 */

export const TAG_FORMATS = [
  Html5QrcodeSupportedFormats.QR_CODE,
  Html5QrcodeSupportedFormats.CODE_128,
];

export function TagScanner({
  onTag,
  onClose,
  isActive = true,
  label = 'Scan tote/area tag',
}: {
  onTag: (code: string) => void;
  /** Optional — see CameraScanner's own onClose (#268). */
  onClose?: () => void;
  isActive?: boolean;
  label?: string;
}) {
  const handle = React.useCallback((raw: string) => {
    // The two symbologies carry the code differently — the QR encodes
    // `${clientUrl}/s/${code}` so a phone's native camera opens the app, while
    // the manifest's Code 128 encodes the bare code — so the payload has to be
    // parsed rather than pattern-matched. extractTlyCode accepts both. See
    // lib/tly.
    const code = extractTlyCode(raw);
    if (!code) {
      // A code that is not ours — a wifi QR, a packing slip, someone's poster.
      toast('That code is not a tally tag');
      return;
    }
    onTag(code);
  }, [onTag]);

  return (
    <CameraScanner
      isActive={isActive}
      formats={TAG_FORMATS}
      label={label}
      onBarcodeScanned={handle}
      onClose={onClose}
    />
  );
}

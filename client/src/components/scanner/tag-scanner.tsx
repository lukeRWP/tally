import * as React from 'react';
import { Html5QrcodeSupportedFormats } from 'html5-qrcode';
import { CameraScanner } from './camera-scanner';
import { toast } from '@/components/ui/toast';

/**
 * Reads a TALLY TAG — the QR label the app generates for an area or a bin and
 * that you print and stick on the thing.
 *
 * QR only. Tally tags are QR codes, and a scanner that cannot decode a UPC can
 * never mistake a cereal box for a shelf. The two jobs are genuinely different
 * and now genuinely separate: this one answers "which place is this?", the
 * product scanner answers "which product is this?".
 */

const TLY_CODE_REGEX = /^TLY-[PACI]-[0-9A-Fa-f]{4,8}$/;

const TAG_FORMATS = [Html5QrcodeSupportedFormats.QR_CODE];

export function TagScanner({
  onTag,
  onClose,
  isActive = true,
  label = 'Scan tote/area tag',
}: {
  onTag: (code: string) => void;
  onClose: () => void;
  isActive?: boolean;
  label?: string;
}) {
  const handle = React.useCallback((raw: string) => {
    const code = raw.trim().toUpperCase();
    if (!TLY_CODE_REGEX.test(code)) {
      // A QR that is not ours — a wifi code, a packing slip, someone's poster.
      toast('That QR code is not a tally tag');
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

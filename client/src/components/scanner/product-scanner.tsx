import { Html5QrcodeSupportedFormats } from 'html5-qrcode';
import { CameraScanner } from './camera-scanner';

/**
 * Reads a PRODUCT BARCODE — the UPC/EAN printed on the thing by whoever made
 * it, used to look up what it is.
 *
 * 1D symbologies only, deliberately excluding QR. Tally's own tags are QR, so
 * a product scanner that cannot decode QR will never quietly swallow a bin
 * label while you are trying to name something — the failure that made one
 * shared scanner confusing in the first place.
 */

const PRODUCT_FORMATS = [
  Html5QrcodeSupportedFormats.UPC_A,
  Html5QrcodeSupportedFormats.UPC_E,
  Html5QrcodeSupportedFormats.EAN_13,
  Html5QrcodeSupportedFormats.EAN_8,
  Html5QrcodeSupportedFormats.CODE_128,
  Html5QrcodeSupportedFormats.CODE_39,
];

export function ProductScanner({
  onBarcode,
  onClose,
  isActive = true,
  label = 'Scan product barcode',
}: {
  onBarcode: (code: string) => void;
  onClose: () => void;
  isActive?: boolean;
  label?: string;
}) {
  return (
    <CameraScanner
      isActive={isActive}
      formats={PRODUCT_FORMATS}
      label={label}
      onBarcodeScanned={(code) => onBarcode(code.trim())}
      onClose={onClose}
    />
  );
}

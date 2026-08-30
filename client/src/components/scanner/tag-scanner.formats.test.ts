import { describe, it, expect } from 'vitest';
import { Html5QrcodeSupportedFormats } from 'html5-qrcode';
import { TAG_FORMATS } from './tag-scanner';

/**
 * WHICH SYMBOLOGIES THE TAG SCANNER ACCEPTS (#109).
 *
 * This list is not an optimisation, it is the product boundary between "which
 * place is this?" and "which product is this?", and it got the boundary wrong
 * in both directions' worth of consequence:
 *
 *  - CODE_128 was missing, and the 4x6 contents manifest prints a Code 128 of
 *    the bare TLY code (server `labels.service.js` → `_drawBarcode`). Tally's
 *    own scanner could not read tally's own printed barcode.
 *  - The retail formats must stay out. A scanner that cannot decode a UPC can
 *    never mistake a cereal box for a shelf, and no tally code is ever a retail
 *    code, so excluding them costs nothing and removes a whole class of
 *    mis-scan.
 *
 * Both halves are pinned here because the natural instinct of anyone tidying
 * this list later is to make it shorter ("we only print QR codes") or longer
 * ("just support everything the library does"). Both are wrong.
 */
describe('TagScanner formats', () => {
  it('decodes the symbologies tally itself prints', () => {
    expect(TAG_FORMATS).toContain(Html5QrcodeSupportedFormats.QR_CODE);
    expect(TAG_FORMATS).toContain(Html5QrcodeSupportedFormats.CODE_128);
  });

  it('refuses the retail symbologies, so a product can never be read as a place', () => {
    for (const retail of [
      Html5QrcodeSupportedFormats.UPC_A,
      Html5QrcodeSupportedFormats.UPC_E,
      Html5QrcodeSupportedFormats.EAN_13,
      Html5QrcodeSupportedFormats.EAN_8,
    ]) {
      expect(TAG_FORMATS).not.toContain(retail);
    }
  });

  it('is exactly those two — nothing has crept in', () => {
    expect([...TAG_FORMATS].sort()).toEqual(
      [Html5QrcodeSupportedFormats.QR_CODE, Html5QrcodeSupportedFormats.CODE_128].sort(),
    );
  });
});

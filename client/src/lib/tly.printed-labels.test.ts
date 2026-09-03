/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';
import fixtureRaw from './__fixtures__/printed-label-decodes.json?raw';
import { extractTlyCode } from './tly';

/**
 * THE LAST LINK OF #109: printed symbol -> decoder -> extractTlyCode -> entity.
 *
 * `server/test/labels.decode.test.js` rasterises the real label PDFs at the
 * printer's 203 dpi and reads the symbols back with a real ZXing decoder — the
 * same decoder `html5-qrcode` vendors, so it is the closest headless stand-in
 * for the phone. But it runs in node against CommonJS, and `extractTlyCode` is
 * client TypeScript, so it cannot finish the round trip itself.
 *
 * This test finishes it. The payloads below are not typed out by hand and not
 * re-matched by a second copy of the regex: they are exactly what came off the
 * rasterised bitmaps, carried across in a committed fixture that the server test
 * writes, and they go through the SAME function every scanner in this app calls.
 * If a printed QR ever stopped resolving to the entity it was generated for,
 * this is what notices.
 *
 * Reimplementing the pattern on the server side would have been easier and would
 * have proved nothing — the whole point is exercising the shipping function.
 *
 * Imported with `?raw` rather than as a JSON module so the fixture is validated
 * here, with a message that says how to fix it, instead of failing as an opaque
 * module-resolution error.
 */

/**
 * Every symbol the label printer produces, and which entity code it is for.
 *
 * Hard-coded on purpose. Reading the expected codes out of the fixture as well
 * would make this test agree with any file at all, including a corrupt or
 * truncated one — it would be checking the fixture against itself. These four
 * rows are the independent statement of what tally prints; the fixture supplies
 * only what the decoder actually saw.
 */
const EXPECTED = [
  { preset: 'small', format: 'QR_CODE', code: 'TLY-I-3A9F2C' },
  { preset: 'medium', format: 'QR_CODE', code: 'TLY-C-8B1E2D' },
  { preset: 'large', format: 'QR_CODE', code: 'TLY-C-1A2B3C' },
  { preset: 'large', format: 'CODE_128', code: 'TLY-C-1A2B3C' },
] as const;

const REGENERATE = 'Regenerate it with `cd server && npm test` (needs poppler-utils installed '
  + 'for pdftoppm) and commit client/src/lib/__fixtures__/printed-label-decodes.json.';

interface DecodedSymbol {
  preset: string;
  format: string;
  code: string;
  decoded: string;
}

interface Fixture {
  clientUrl: string;
  dpi: number;
  decoder: string;
  symbols: DecodedSymbol[];
}

/**
 * Parse the fixture, failing loudly on every way it could be useless.
 *
 * An empty or malformed fixture must not let this file pass with zero
 * assertions — that silent green is precisely what this whole exercise exists
 * to rule out.
 */
function loadFixture(): Fixture {
  if (!fixtureRaw.trim()) {
    throw new Error(`The decoded-label fixture is empty. ${REGENERATE}`);
  }
  let parsed: Fixture;
  try {
    parsed = JSON.parse(fixtureRaw) as Fixture;
  } catch (err) {
    throw new Error(`The decoded-label fixture is not valid JSON. ${REGENERATE} `
      + `(underlying error: ${(err as Error).message})`, { cause: err });
  }
  if (!Array.isArray(parsed.symbols) || parsed.symbols.length === 0) {
    throw new Error(`The decoded-label fixture carries no symbols. ${REGENERATE}`);
  }
  return parsed;
}

const fixture = loadFixture();

const find = (preset: string, format: string) =>
  fixture.symbols.find(s => s.preset === preset && s.format === format);

describe('the printed labels round-trip through the real extractTlyCode', () => {
  it('covers exactly the symbols tally prints — no more, no fewer', () => {
    // Catches a stale fixture that predates a preset gaining or losing a symbol,
    // which would otherwise leave a printed code silently unverified.
    const got = fixture.symbols.map(s => `${s.preset}/${s.format}`).sort();
    const want = EXPECTED.map(e => `${e.preset}/${e.format}`).sort();
    expect(got, `Fixture symbol coverage has drifted. ${REGENERATE}`).toEqual(want);
  });

  it.each(EXPECTED)('$preset $format resolves to $code', ({ preset, format, code }) => {
    const symbol = find(preset, format);
    expect(symbol, `No ${format} decode recorded for the ${preset} preset. ${REGENERATE}`)
      .toBeDefined();
    expect(symbol!.code, `The fixture's ${preset}/${format} row is for a different entity than `
      + `this test expects. ${REGENERATE}`).toBe(code);
    expect(symbol!.decoded, `The ${preset}/${format} payload is empty. ${REGENERATE}`)
      .toBeTruthy();

    // THE CLAIM. What the decoder read off the printed label, put through the
    // function every scanner in this app calls, is the code that label was
    // generated for.
    expect(extractTlyCode(symbol!.decoded)).toBe(code);
  });

  it('the QR payloads are deep links, so this exercises the /s/ branch', () => {
    // If the QRs ever encoded the bare code instead, extractTlyCode would still
    // return the right answer via its other branch and the tests above would
    // pass while proving something weaker. Pin which branch is under test.
    for (const { preset } of EXPECTED.filter(e => e.format === 'QR_CODE')) {
      const symbol = find(preset, 'QR_CODE')!;
      expect(symbol.decoded).toBe(`${fixture.clientUrl}/s/${symbol.code}`);
      expect(symbol.decoded).not.toBe(symbol.code);
    }
  });

  it('the Code 128 payload is the bare code a desk scanner types into the code field', () => {
    const symbol = find('large', 'CODE_128')!;
    expect(symbol.decoded).toBe(symbol.code);
  });

  it('was decoded off a real raster at the print resolution', () => {
    // Guards against someone "fixing" a failure by hand-writing the fixture:
    // these are the provenance fields the generator stamps, and 203 dpi is the
    // ITPP941 head the labels are designed for.
    expect(fixture.dpi, `The fixture was not produced at print resolution. ${REGENERATE}`)
      .toBe(203);
    expect(fixture.decoder, `The fixture records no decoder. ${REGENERATE}`).toBeTruthy();
    expect(fixture.clientUrl).toMatch(/^https?:\/\//);
  });
});

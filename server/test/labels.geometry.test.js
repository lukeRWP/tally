/**
 * DOT-EXACTNESS OF THE PRINTED SYMBOLS (#109).
 *
 * Two load-bearing claims live in labels.service.js and, until this file, had
 * never been checked by anything:
 *
 *   1. `generateQrImage` renders the QR so that every MODULE is a whole number
 *      of printer dots at 203 dpi (the ITPP941 head), and `_drawQr` places that
 *      bitmap so the whole-dot grid survives rasterisation. Both halves matter:
 *      until #326 only the first was true, and a dot-exact bitmap dropped at a
 *      fractional dot origin came back one dot over on both axes.
 *   2. `_drawBarcode` snaps every Code 128 module to a whole dot, "the same
 *      failure that killed the QR".
 *
 * Both are claims about what comes out of the RASTERISER, not about what the
 * renderer intended, so this file renders each preset's real PDF through the
 * real LabelsService entry points, rasterises it with poppler at exactly the
 * print resolution (`pdftoppm -r 203 -gray -png`), and measures the symbols in
 * the resulting bitmap.
 *
 * WHY BIT-FOR-BIT, AND WHY THAT IS NOT THE WHOLE STORY. Comparing the sampled
 * module grid against `QRCode.create(url).modules` is STRICTLY STRONGER
 * evidence *about geometry* than handing the image to a decoder. A QR carries
 * Reed-Solomon error correction, so a decoder happily returns the right string
 * from a symbol with a hundred wrong modules — a decode proves the symbol is
 * *recoverable*, not that it is *correct*, and would keep passing while the
 * geometry rotted. So nothing in this file may be replaced by a decode.
 *
 * The converse is also true, which is why `labels.decode.test.js` now sits
 * beside this file: a symbol can be geometrically perfect and still not read,
 * because decodability depends on things a module grid says nothing about — the
 * quiet zone a real detector needs, and whether the Code 128 check digit is
 * right. The two suites are complements, not alternatives. Keep both.
 *
 * WHAT THIS DOES NOT PROVE. It proves the bitmap the printer is handed is
 * geometrically exact. It says nothing about ink on paper: thermal bleed,
 * media, head temperature and darkness settings all sit downstream of here, and
 * only a physical scan-back (the operator half of #109) can speak to those.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');
const code128 = require('../src/modules/labels/code128');
const { collectPdf } = require('../src/utils/pdf');

// The rasterisation rig — rendering, poppler, PNG decoding, pixel measurement
// and the preset fixtures — is shared with labels.decode.test.js, which reads
// the same bitmaps back with a real decoder. See helpers/label-raster.js.
const {
  Labels, CLIENT_URL, dots, SKIP, rasterise, pixel, isDark, darkBox,
  findBarcodeInRow, renderOnePage, SMALL, MEDIUM, MANIFEST,
} = require('./helpers/label-raster');

// How far inside its own printer dot each edge of a placed QR must sit, in
// dots. This is the invariant `_drawQr` is built to satisfy, not a copy of its
// DOT_INSET constant — deliberately a floor rather than the value itself, so
// the bound keeps meaning something if that constant is retuned, while still
// failing loudly for the one "simplification" that would break the raster:
// snapping the origin to a whole dot and calling it done.
//
// The number to beat is pdfkit's coordinate rounding. It writes the image `cm`
// matrix in POINTS to 6 decimal places, so an edge can land up to 0.5e-6 pt =
// 1.4e-6 dots either side of where the renderer asked for it. 1e-4 dots clears
// that by 70x and is still a ten-thousandth of a printer dot, so no sane inset
// fails it.
const MIN_EDGE_MARGIN = 1e-4;

// Tolerance on the DRAWN extent being a whole number of dots. It has to absorb
// two deliberate, known effects: the 2 x DOT_INSET = 0.002 dots `_drawQr`
// shaves off, and the coordinate rounding above. It is not a geometric fudge —
// a genuinely fractional module pitch (the original bug: 155 dots of symbol
// stretched over dots(60) = 169) is out by 0.17 dots or more, 16x this bound,
// which the negative controls at the bottom of this file prove.
const EXTENT_TOL = 0.01;

/**
 * Verify one rendered QR against the canonical matrix for its URL.
 *
 * `img` is the page raster; `placement` is where the renderer put the QR image.
 */
function checkQr(img, placement, code, label) {
  const url = `${CLIENT_URL}/s/${code}`;
  const ref = QRCode.create(url).modules;
  const n = ref.size;
  // generateQrImage pads by exactly 1 module of quiet zone on every side.
  const MARGIN = 1;

  // ── Claim 1, as written: the drawn symbol is a whole number of printer dots,
  // and that number divides evenly by the module count. Read off the PDF, so it
  // is the geometry the rasteriser is actually given. EXTENT_TOL is PDF
  // coordinate precision plus `_drawQr`'s deliberate sub-dot inset, not a
  // geometric tolerance — see its definition.
  const drawnDots = dots(placement.wPt);
  const drawnDotsY = dots(placement.hPt);
  for (const [axis, measured] of [['wide', drawnDots], ['tall', drawnDotsY]]) {
    assert.ok(Math.abs(measured - Math.round(measured)) < EXTENT_TOL,
      `${label}: the QR is drawn ${measured} dots ${axis} — not a whole number of printer dots`);
  }
  const wholeDots = Math.round(drawnDots);
  assert.equal(Math.round(drawnDotsY), wholeDots, `${label}: the drawn QR is not square`);
  assert.equal(wholeDots % (n + MARGIN * 2), 0,
    `${label}: ${wholeDots} dots does not divide evenly into ${n + MARGIN * 2} module slots — `
    + 'the modules land on fractional dot boundaries');
  const dotsPerModule = wholeDots / (n + MARGIN * 2);
  // A 1-dot module is arithmetically "whole dots" and still unprintable: at
  // 203 dpi it is 0.125mm, below the ~0.33mm minimum module every QR reader
  // spec asks for, and thermal bleed closes it up entirely.
  assert.ok(dotsPerModule >= 2,
    `${label}: ${dotsPerModule} dot(s) per module is too fine for a 203 dpi head`);

  // ── Claim 1's OTHER half, and the whole of issue #326: the PLACEMENT.
  //
  // poppler maps an image onto the ENCLOSING whole-pixel box, floor(left) to
  // ceil(right). With right - left a whole number of dots, that box is the
  // bitmap's own size only while `left` sits strictly inside its dot and
  // `right` strictly inside its own. Land either edge ON an integer and the
  // coordinate rounding above decides — per axis, per run — whether the symbol
  // gains a dot; that is why the pre-fix `small` preset sat at y = 24.000002
  // dots, arithmetically aligned, and still took the +1.
  //
  // So this is deliberately NOT "the origin is a whole dot". It is "every edge
  // is far enough inside its dot that the rounding cannot reach the boundary",
  // which is the property the exact extents below actually rest on. Anyone who
  // later "simplifies" `_drawQr`'s inset back to a plain snap fails here, with
  // a message saying why, instead of quietly reprinting smeared symbols.
  const left = dots(placement.xPt);
  const top = dots(placement.yPt);
  for (const [axis, lo, len] of [['x', left, drawnDots], ['y', top, drawnDotsY]]) {
    const hi = lo + len;
    const inLo = lo - Math.floor(lo), inHi = Math.ceil(hi) - hi;
    assert.ok(inLo >= MIN_EDGE_MARGIN,
      `${label}: the QR's ${axis} origin is ${lo} dots — only ${inLo.toExponential(2)} dots inside its `
      + `printer dot, so coordinate rounding can cross the boundary and stretch the symbol `
      + `(needs >= ${MIN_EDGE_MARGIN})`);
    assert.ok(inHi >= MIN_EDGE_MARGIN,
      `${label}: the QR's far ${axis} edge is ${hi} dots — only ${inHi.toExponential(2)} dots inside its `
      + `printer dot (needs >= ${MIN_EDGE_MARGIN})`);
    assert.equal(Math.ceil(hi) - Math.floor(lo), wholeDots,
      `${label}: poppler maps the QR onto ${Math.ceil(hi) - Math.floor(lo)} dots on ${axis}, `
      + `not the bitmap's own ${wholeDots} — it will be resampled`);
  }

  // ── Locate the symbol in the raster, inside the image's own placement box.
  const box = darkBox(img,
    Math.floor(left) - 1, Math.floor(top) - 1,
    Math.ceil(left + drawnDots) + 1, Math.ceil(top + drawnDots) + 1);

  // ── Claim 1, as rasterised: the symbol occupies EXACTLY n x dotsPerModule
  // dots on both axes. No allowance, and there must never be one again — the
  // placement invariant above is what earns the "exactly". Before #326 every
  // preset measured one dot over on both axes (145 -> 146, 290 -> 291) and this
  // bound read `expected || expected + 1`; that slack is the bug, not a fudge
  // for one, so widening it back is a regression however tempting it looks.
  const expected = n * dotsPerModule;
  for (const [axis, measured] of [['width', box.w], ['height', box.h]]) {
    assert.equal(measured, expected,
      `${label}: symbol ${axis} is ${measured} dots, expected exactly ${expected} `
      + `(${n} modules x ${dotsPerModule} dots)`);
  }
  const pitch = box.w / n;
  assert.equal(Math.round(pitch), dotsPerModule,
    `${label}: measured module pitch ${pitch.toFixed(3)} dots is not ${dotsPerModule}`);

  // ── Claim 1's payload: every module reads the bit it is supposed to.
  const pitchY = box.h / n;
  const wrong = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const x = box.minX + Math.floor((c + 0.5) * pitch);
      const y = box.minY + Math.floor((r + 0.5) * pitchY);
      const dark = isDark(pixel(img, x, y));
      if (dark !== !!ref.get(r, c)) wrong.push(`(${r},${c})`);
    }
  }
  assert.deepEqual(wrong, [],
    `${label}: ${wrong.length} of ${n * n} modules disagree with the canonical matrix `
    + `for ${url} — first few: ${wrong.slice(0, 8).join(' ')}`);

  return { n, dotsPerModule, box };
}

test('small (2x1 item tag): the QR rasterises at 203 dpi to the canonical matrix, bit for bit', { skip: SKIP }, async () => {
  const pdf = await Labels.renderLabelPdf([SMALL], 'small');
  const { img, placement } = await renderOnePage(pdf, 'small');
  // The page itself must be whole dots, or nothing downstream means anything.
  assert.equal(img.w, dots(144), '2x1 label is 406 dots wide at 203 dpi');
  assert.equal(img.h, dots(72), '2x1 label is 203 dots tall at 203 dpi');
  const { dotsPerModule } = checkQr(img, placement, SMALL.qrCode, 'small');
  assert.equal(dotsPerModule, 5, 'the 2x1 tag prints its QR at 5 dots per module');
});

test('medium (3x3 bin tag): the QR rasterises at 203 dpi to the canonical matrix, bit for bit', { skip: SKIP }, async () => {
  const pdf = await Labels.renderLabelPdf([MEDIUM], 'medium');
  const { img, placement } = await renderOnePage(pdf, 'medium');
  assert.equal(img.w, dots(216), '3x3 label is 609 dots wide at 203 dpi');
  assert.equal(img.h, dots(216), '3x3 label is 609 dots tall at 203 dpi');
  const { dotsPerModule } = checkQr(img, placement, MEDIUM.qrCode, 'medium');
  assert.equal(dotsPerModule, 10, 'the 3x3 tag prints its QR at 10 dots per module');
});

test('large (4x6 manifest): the QR rasterises at 203 dpi to the canonical matrix, bit for bit', { skip: SKIP }, async () => {
  const pdf = await Labels.renderManifestPdf(MANIFEST, 'large');
  const { img, placement } = await renderOnePage(pdf, 'large');
  assert.equal(img.w, dots(288), '4x6 label is 812 dots wide at 203 dpi');
  assert.equal(img.h, dots(432), '4x6 label is 1218 dots tall at 203 dpi');
  const { dotsPerModule } = checkQr(img, placement, MANIFEST.header.qrCode, 'large');
  assert.equal(dotsPerModule, 5, 'the manifest header prints its QR at 5 dots per module');
});

test('large (4x6 manifest): every Code 128 bar and space is a whole number of printer dots', { skip: SKIP }, async () => {
  const code = MANIFEST.header.qrCode;
  const { modules } = code128.encode(code);
  const pdf = await Labels.renderManifestPdf(MANIFEST, 'large');
  const [img] = rasterise(pdf, 'large-bc');

  // Sweep every row: the barcode announces itself by decoding, so this needs no
  // knowledge of where _manifestLayout put it.
  const hits = [];
  for (let y = 0; y < img.h; y++) {
    const hit = findBarcodeInRow(img, y, modules);
    if (hit) hits.push({ y, ...hit });
  }
  assert.ok(hits.length > 0,
    `no raster row decodes as the Code 128 of ${code} — the bars are not whole dots wide`);

  // Exactly one symbol, at exactly one scale, and that scale is _drawBarcode's
  // documented 3 dots per module. No tolerance is warranted anywhere here: the
  // bars are vector fills, so poppler's own edge quantisation is consistent
  // across the whole symbol and every element lands on the same phase.
  const scales = new Set(hits.map(h => h.scale));
  assert.deepEqual([...scales], [3], `expected a constant 3 dots per module, saw ${[...scales]}`);

  // A true rectangle: the band is contiguous and every row in it is identical.
  const band = hits.map(h => h.y);
  assert.equal(band[band.length - 1] - band[0] + 1, band.length,
    'the decodable rows are not contiguous — the bars have ragged tops or bottoms');
  assert.ok(band.length >= 20,
    `the bars are only ${band.length} dots tall — too short for a hand scanner`);
  const firstStart = hits[0].first;
  assert.ok(hits.every(h => h.first === firstStart),
    'the symbol shifts horizontally between rows — the bars are not vertical');

  // Quiet zones: Code 128 needs 10 clear modules either side, and the manifest
  // centres the symbol between the location banner and the label edge.
  const { runs, first } = hits[0];
  const before = runs[first - 1];
  const after = runs[first + modules.length];
  assert.ok(before && !before.dark && before.len >= 10 * 3,
    `leading quiet zone is ${before ? before.len : 0} dots, needs ${10 * 3}`);
  assert.ok(after && !after.dark && after.len >= 10 * 3,
    `trailing quiet zone is ${after ? after.len : 0} dots, needs ${10 * 3}`);
});

test('the geometry check has teeth: a QR drawn at its nominal preset size fails it', { skip: SKIP }, async () => {
  // NEGATIVE CONTROL for the SIZING half. This is the pre-fix behaviour
  // `generateQrImage`'s comment describes: draw the QR bitmap at the preset's
  // nominal `qrPt` instead of at the whole-dot size the generator computed. 155
  // dots of symbol get stretched over dots(60) = 169, so the module pitch
  // becomes 5.45 dots and module edges land mid-dot. That is out by 0.17 dots
  // at the extent alone — 16x EXTENT_TOL — so the tolerances in checkQr are
  // nowhere near wide enough to hide it.
  const qr = await Labels.generateQrImage(SMALL.qrCode, 60);
  assert.notEqual(qr.sizePt, 60, 'the generator does not draw at the nominal size (that is the point)');

  const doc = new PDFDocument({ size: [144, 72], margin: 0 });
  const pdf = await collectPdf(doc, () => { doc.image(qr.buf, 6, 6, { width: 60 }); });
  const { img, placement } = await renderOnePage(pdf, 'control');

  assert.throws(
    () => checkQr(img, placement, SMALL.qrCode, 'nominal-size control'),
    /not a whole number of printer dots|does not divide evenly|symbol width|module pitch|disagree with the canonical matrix/,
    'a fractional module pitch must be rejected',
  );
});

test('the geometry check has teeth: a dot-exact QR at a fractional dot origin fails it', { skip: SKIP }, async () => {
  // NEGATIVE CONTROL for the PLACEMENT half (#326), and the one that keeps the
  // exact-extent assertion honest now that its +1 allowance is gone.
  //
  // Everything about the bitmap here is beyond reproach — it is the renderer's
  // own buffer, drawn at the renderer's own whole-dot size — so every check
  // that guards the BITMAP passes and only the origin is wrong. 6pt is 16.9167
  // dots, which is exactly what the presets did before #326. If the tightened
  // equality were slack, or if `_drawQr` were reduced to a plain doc.image(),
  // this test is what notices.
  const qr = await Labels.generateQrImage(SMALL.qrCode, 60);
  const doc = new PDFDocument({ size: [144, 72], margin: 0 });
  const pdf = await collectPdf(doc, () => { doc.image(qr.buf, 6, 6, { width: qr.sizePt }); });
  const { img, placement } = await renderOnePage(pdf, 'offset-control');

  // The bitmap really is dot-exact: whole dots, evenly divided into modules.
  const slots = QRCode.create(`${CLIENT_URL}/s/${SMALL.qrCode}`).modules.size + 2;
  const drawn = dots(placement.wPt);
  assert.ok(Math.abs(drawn - Math.round(drawn)) < EXTENT_TOL,
    `the control bitmap is drawn ${drawn} dots wide — the control is meant to be sizing-clean`);
  assert.equal(Math.round(drawn) % slots, 0,
    'the control bitmap does not divide evenly into module slots — the control is meant to be sizing-clean');

  assert.throws(
    () => checkQr(img, placement, SMALL.qrCode, 'fractional-origin control'),
    /inside its printer dot|poppler maps the QR onto|symbol (width|height) is/,
    'a dot-exact bitmap at a fractional dot origin must be rejected',
  );
});

test('every thermal QR is placed through _drawQr — the coverage above is complete', () => {
  // The QR is drawn in three places (both `_drawTag` branches and the manifest
  // header) and the placement fix only holds where it is applied, so pin that
  // none of them is a bare doc.image(). The Avery sheet's doc.image() is
  // deliberately outside this slice: it goes to a laser, where dot alignment is
  // moot and `generateQrBuffer` does not produce a dot-exact bitmap anyway.
  const src = fs.readFileSync(require.resolve('../src/modules/labels/labels.service'), 'utf8');
  const start = src.indexOf('_drawTag(doc, e, qr, P, presetKey)');
  const end = src.indexOf('async renderManifestBundle', start);
  assert.ok(start > 0 && end > start, 'could not locate the thermal renderers — this pin has rotted');
  const thermal = src.slice(start, end);

  assert.deepEqual([...thermal.matchAll(/doc\.image\(/g)].map(m => m.index), [],
    'a thermal preset places a QR with a bare doc.image() — it will be resampled onto an extra '
    + 'dot on both axes (#326). Place it with _drawQr.');
  assert.equal([...thermal.matchAll(/_drawQr\(/g)].length, 3,
    'expected three QR placements across the thermal presets (2x1, 3x3, manifest header) — '
    + 'if one was added or removed, extend or trim the rasterised checks above to match');
});

test('only the manifest draws a barcode — the coverage above is complete', () => {
  // Pins the fact the barcode coverage rests on. If a Code 128 is ever added to
  // the 2x1 or 3x3 tag, this fails and whoever added it has to extend the
  // rasterised check to that preset rather than shipping an unverified symbol.
  const src = fs.readFileSync(require.resolve('../src/modules/labels/labels.service'), 'utf8');
  const callSites = [...src.matchAll(/_drawBarcode\(/g)]
    .map(m => src.slice(0, m.index).split('\n').length)
    .filter(line => !/_drawBarcode\(doc, text/.test(src.split('\n')[line - 1])); // skip the definition
  assert.equal(callSites.length, 1, `expected one _drawBarcode call site, found ${callSites.length}`);

  // ...and it is inside _drawManifest, which only `large` reaches.
  const manifestStart = src.indexOf('_drawManifest(doc, manifest, presetKey, startNewPage)');
  const manifestEnd = src.indexOf('async renderManifestBundle', manifestStart);
  const callLine = callSites[0];
  const lineOffset = src.split('\n').slice(0, callLine - 1).join('\n').length;
  assert.ok(lineOffset > manifestStart && lineOffset < manifestEnd,
    'the _drawBarcode call moved out of _drawManifest — which presets carry a barcode has changed');
});

/**
 * DOT-EXACTNESS OF THE PRINTED SYMBOLS (#109).
 *
 * Two load-bearing claims live in labels.service.js and, until this file, had
 * never been checked by anything:
 *
 *   1. `generateQrImage` renders the QR so that every MODULE is a whole number
 *      of printer dots at 203 dpi (the ITPP941 head). Its comment says the
 *      first printed QR would not scan otherwise.
 *   2. `_drawBarcode` snaps every Code 128 module to a whole dot, "the same
 *      failure that killed the QR".
 *
 * Both are claims about what comes out of the RASTERISER, not about what the
 * renderer intended, so this file renders each preset's real PDF through the
 * real LabelsService entry points, rasterises it with poppler at exactly the
 * print resolution (`pdftoppm -r 203 -gray -png`), and measures the symbols in
 * the resulting bitmap.
 *
 * WHY BIT-FOR-BIT AND NOT A DECODE. Comparing the sampled module grid against
 * `QRCode.create(url).modules` is STRICTLY STRONGER evidence than handing the
 * image to a QR decoder. A QR carries Reed-Solomon error correction, so a
 * decoder happily returns the right string from a symbol with a hundred wrong
 * modules — a decode proves the symbol is *recoverable*, not that it is
 * *correct*, and would keep passing while the geometry rotted. Do not "upgrade"
 * this to a decode.
 *
 * WHAT THIS DOES NOT PROVE. It proves the bitmap the printer is handed is
 * geometrically exact. It says nothing about ink on paper: thermal bleed,
 * media, head temperature and darkness settings all sit downstream of here, and
 * only a physical scan-back (the operator half of #109) can speak to those.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync, execFileSync } = require('node:child_process');

const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');
const Labels = require('../src/modules/labels/labels.service');
const code128 = require('../src/modules/labels/code128');
const { collectPdf } = require('../src/utils/pdf');

const CLIENT_URL = 'https://tally.example';
const logger = { warn() {}, info() {}, error() {} };
Labels.init({ db: { query: async () => [] }, logger, config: { clientUrl: CLIENT_URL } });

// The ITPP941 head, and the resolution every number in this file is expressed
// in. 72 pt = 1 inch.
const DPI = 203;
const dots = (pt) => (pt / 72) * DPI;

// ── poppler ────────────────────────────────────────────────────────────────
// Skip LOUDLY rather than silently: a geometry test that quietly evaporates is
// worse than no test, because the next reader believes it ran.
const HAVE_POPPLER = !spawnSync('pdftoppm', ['-v']).error;
const SKIP = HAVE_POPPLER
  ? false
  : 'pdftoppm not found — install poppler-utils (apt: poppler-utils, brew: poppler). '
    + 'The label geometry is UNVERIFIED without it.';
if (!HAVE_POPPLER) {
  console.error('\n########################################################################');
  console.error('# labels.geometry.test.js SKIPPED: pdftoppm (poppler-utils) is missing. #');
  console.error('# The printed QR / Code 128 geometry was NOT verified in this run.      #');
  console.error('########################################################################\n');
}

/**
 * Rasterise a PDF at the print resolution and return one greyscale bitmap per
 * page as { w, h, data } with `data` one byte per pixel, 0 = black.
 */
function rasterise(pdf, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-label-'));
  try {
    const pdfPath = path.join(dir, `${name}.pdf`);
    fs.writeFileSync(pdfPath, pdf);
    execFileSync('pdftoppm', ['-r', String(DPI), '-gray', '-png', pdfPath, path.join(dir, name)]);
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.png'))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
      .map(f => decodePng(fs.readFileSync(path.join(dir, f))));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A PNG decoder just big enough for what pdftoppm writes: 8 bit, no interlace,
 * greyscale (colour type 0) or truecolour (type 2 — poppler 26 still writes RGB
 * for `-gray`, older builds write real greyscale, so both are handled and the
 * red channel is taken). Deliberately dependency-free: `npm audit --production`
 * gates every PR here, so a devDependency added for one test is a standing
 * liability, and PNG unfiltering is 30 lines.
 */
function decodePng(buf) {
  assert.equal(buf.subarray(0, 8).toString('latin1'), '\x89PNG\r\n\x1a\n', 'not a PNG');
  let pos = 8, w = 0, h = 0, depth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  assert.equal(depth, 8, 'expected an 8-bit PNG from pdftoppm');
  assert.equal(interlace, 0, 'expected a non-interlaced PNG from pdftoppm');
  assert.ok(colorType === 0 || colorType === 2, `unexpected PNG colour type ${colorType}`);

  const chan = colorType === 0 ? 1 : 3;
  const stride = w * chan;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(w * h);
  let p = 0;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    const line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= chan ? line[x - chan] : 0;
      const b = prev[x];
      const c = x >= chan ? prev[x - chan] : 0;
      let v = line[x];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v = (v + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c))) & 0xff;
      }
      line[x] = v;
    }
    for (let x = 0; x < w; x++) out[y * w + x] = line[x * chan];
    prev = line;
  }
  return { w, h, data: out };
}

const pixel = (img, x, y) => img.data[y * img.w + x];
// The head is 1-bit: a dot is burned or it is not. 50% is the only defensible
// place to put the line between them.
const isDark = (v) => v < 128;

/** Tightest box containing every dark pixel of a window. */
function darkBox(img, x0, y0, x1, y1) {
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = Math.max(0, y0); y < Math.min(img.h, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(img.w, x1); x++) {
      if (!isDark(pixel(img, x, y))) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  assert.ok(maxX >= 0, 'no dark pixels in the window — nothing was drawn there');
  return { minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Alternating dark/light run lengths along one raster row. */
function runsInRow(img, y) {
  const runs = [];
  let dark = isDark(pixel(img, 0, y));
  let len = 0;
  for (let x = 0; x < img.w; x++) {
    const d = isDark(pixel(img, x, y));
    if (d === dark) { len += 1; continue; }
    runs.push({ dark, len });
    dark = d;
    len = 1;
  }
  runs.push({ dark, len });
  return runs;
}

/**
 * Where the renderer actually put its raster images, read out of the PDF.
 *
 * pdfkit emits `w 0 0 -h x yBottom cm` immediately before `/Ix Do`, so this is
 * the renderer's own placement rather than a reimplementation of the layout
 * maths — which is the point: locating the symbol by re-deriving `_drawTag`'s
 * arithmetic here would only prove this file agrees with itself.
 *
 * pdfkit puts a `1 0 0 -1 0 H cm` flip at the top of every page, so its user
 * space already runs top-down like the raster; the `-h` in the image matrix is
 * that flip being undone for the bitmap, and `yBottom - h` is the top edge.
 */
function imagePlacements(pdf) {
  const src = pdf.toString('latin1');
  const found = [];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    const end = src.indexOf('endstream', start);
    if (end < 0) continue;
    let content;
    try { content = zlib.inflateSync(Buffer.from(src.slice(start, end), 'latin1')).toString('latin1'); }
    catch { continue; } // an embedded image, not a deflated content stream
    for (const cm of content.matchAll(/([\d.]+) 0 0 -([\d.]+) ([-\d.]+) ([-\d.]+) cm\s*\/\w+ Do/g)) {
      const wPt = +cm[1], hPt = +cm[2];
      found.push({ wPt, hPt, xPt: +cm[3], yPt: +cm[4] - hPt });
    }
  }
  return found;
}

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
  // is the geometry the rasteriser is actually given.
  //
  // The 1e-3 is PDF coordinate precision, not a geometric tolerance: pdfkit
  // writes the `cm` matrix to 6 decimal places, so a width of exactly 155 dots
  // round-trips as 154.9999987 dots. Nothing about the symbol is being fudged —
  // a genuinely fractional module count is out by 0.5 dots or more.
  const drawnDots = dots(placement.wPt);
  assert.ok(Math.abs(drawnDots - Math.round(drawnDots)) < 1e-3,
    `${label}: the QR is drawn ${drawnDots} dots wide — not a whole number of printer dots`);
  const wholeDots = Math.round(drawnDots);
  assert.equal(wholeDots % (n + MARGIN * 2), 0,
    `${label}: ${wholeDots} dots does not divide evenly into ${n + MARGIN * 2} module slots — `
    + 'the modules land on fractional dot boundaries');
  const dotsPerModule = wholeDots / (n + MARGIN * 2);
  // A 1-dot module is arithmetically "whole dots" and still unprintable: at
  // 203 dpi it is 0.125mm, below the ~0.33mm minimum module every QR reader
  // spec asks for, and thermal bleed closes it up entirely.
  assert.ok(dotsPerModule >= 2,
    `${label}: ${dotsPerModule} dot(s) per module is too fine for a 203 dpi head`);

  // ── Locate the symbol in the raster, inside the image's own placement box.
  const left = dots(placement.xPt);
  const top = dots(placement.yPt);
  const box = darkBox(img,
    Math.floor(left) - 1, Math.floor(top) - 1,
    Math.ceil(left + drawnDots) + 1, Math.ceil(top + drawnDots) + 1);

  // ── Claim 1, as rasterised: the symbol occupies n x dotsPerModule dots.
  //
  // THE +1 IS REAL AND IT IS A FINDING, NOT A FUDGE. poppler maps an image onto
  // the ENCLOSING whole-pixel box, so an image whose origin lands mid-dot is
  // stretched across exactly one extra dot (never more: the box is
  // ceil(right) - floor(left), and right - left is a whole number of dots here,
  // so the width is either n*dpm or n*dpm + 1). Every preset places its QR at a
  // whole POINT offset — 6pt on the 2x1, 46pt on the manifest, centred on the
  // 3x3 — and a whole point is not a whole dot at 203 dpi, so today every
  // preset takes the +1. Module CENTRES are unaffected, which is why the
  // symbols still read (asserted below, bit for bit); the outer edge gains one
  // antialiased dot.
  //
  // That is issue #326: the bitmap is dot-exact, its ORIGIN is not. When #326
  // lands, tighten this to an exact equality and delete the allowance. Until
  // then the bound stays at exactly 1, so a genuinely fractional module pitch —
  // the original bug, ~5.45 dots per module — still fails here by tens of dots,
  // which the negative-control test below proves.
  const expected = n * dotsPerModule;
  for (const [axis, measured] of [['width', box.w], ['height', box.h]]) {
    assert.ok(measured === expected || measured === expected + 1,
      `${label}: symbol ${axis} is ${measured} dots, expected ${expected} `
      + `(${n} modules x ${dotsPerModule} dots) or ${expected + 1} from whole-dot snapping`);
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

/**
 * Find a Code 128 symbol anywhere in a raster row and check every bar and space
 * against the canonical element widths.
 *
 * Self-locating on purpose: it searches the row's run lengths for the encoder's
 * own pattern at some constant scale, so it needs no layout constants and would
 * notice the symbol moving as readily as the symbol deforming.
 */
function findBarcodeInRow(img, y, expectedModules) {
  const runs = runsInRow(img, y);
  for (let i = 0; i + expectedModules.length <= runs.length; i++) {
    if (!runs[i].dark) continue;                       // a symbol starts with a bar
    const scale = runs[i].len / expectedModules[0];
    if (!Number.isInteger(scale) || scale < 1) continue;
    let ok = true;
    for (let j = 0; j < expectedModules.length; j++) {
      if (runs[i + j].dark !== (j % 2 === 0) || runs[i + j].len !== scale * expectedModules[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return { scale, first: i, runs };
  }
  return null;
}

// ── The three presets ──────────────────────────────────────────────────────
// Read from labels.service.js, not assumed: `small` (2x1 item tag) and `medium`
// (3x3 bin tag) carry a QR only; `large` (4x6 contents manifest) carries a QR
// AND a Code 128 of the same TLY code — `_drawBarcode`'s only call site is
// inside `_drawManifest`, which is pinned by its own test at the bottom of this
// file so the coverage claim cannot rot.

const SMALL = { id: 1, name: 'Cordless Drill', qrCode: 'TLY-I-3A9F2C', type: 'item', tags: [], parentZone: null, breadcrumb: 'Home > Garage > Bin 4' };
const MEDIUM = { id: 5, name: 'Holiday Decorations', qrCode: 'TLY-C-8B1E2D', type: 'container', tags: ['fragile'], parentZone: 'Garage', breadcrumb: 'Home' };
const MANIFEST = {
  header: { name: 'Camping Gear', qrCode: 'TLY-C-1A2B3C', type: 'container', tags: [], parentZone: 'Garage', breadcrumb: 'Home' },
  rows: [{ name: 'Tent', qty: 1 }, { name: 'Lantern', qty: 2 }],
};

/** Render a single-page label and hand back its raster plus the QR placement. */
async function renderOnePage(pdf, name) {
  const pages = rasterise(pdf, name);
  assert.equal(pages.length, 1, `${name}: expected a single-page fixture, got ${pages.length}`);
  const placements = imagePlacements(pdf);
  assert.equal(placements.length, 1, `${name}: expected exactly one placed image (the QR), got ${placements.length}`);
  return { img: pages[0], placement: placements[0] };
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
  // NEGATIVE CONTROL. This is the pre-fix behaviour `generateQrImage`'s comment
  // describes: draw the QR bitmap at the preset's nominal `qrPt` instead of at
  // the whole-dot size the generator computed. 155 dots of symbol get stretched
  // over dots(60) = 169, so the module pitch becomes 5.45 dots and module edges
  // land mid-dot. If the +1-dot allowance in checkQr were papering over
  // anything, this would sail through it.
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

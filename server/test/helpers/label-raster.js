/**
 * Shared rig for the two suites that measure PRINTED labels:
 *
 *   labels.geometry.test.js — is the bitmap geometrically exact?
 *   labels.decode.test.js   — does a real decoder read it back?
 *
 * Both render the real label PDFs through the real LabelsService entry points
 * and rasterise them with poppler at exactly the print resolution
 * (`pdftoppm -r 203 -gray -png`, the ITPP941 head). Everything below is the
 * machinery for getting from a PDF to measurable dots; the claims themselves
 * live in the two test files.
 *
 * This file lives under test/ but declares no tests. It is a module, not a
 * suite — node's runner will load it, find nothing to run, and move on.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync, execFileSync } = require('node:child_process');

const Labels = require('../../src/modules/labels/labels.service');

const CLIENT_URL = 'https://tally.example';
const logger = { warn() {}, info() {}, error() {} };
Labels.init({ db: { query: async () => [] }, logger, config: { clientUrl: CLIENT_URL } });

// The ITPP941 head, and the resolution every number in these suites is
// expressed in. 72 pt = 1 inch.
const DPI = 203;
const dots = (pt) => (pt / 72) * DPI;

// ── poppler ────────────────────────────────────────────────────────────────
// Skip LOUDLY rather than silently: a test that quietly evaporates is worse
// than no test, because the next reader believes it ran.
const HAVE_POPPLER = !spawnSync('pdftoppm', ['-v']).error;
const SKIP = HAVE_POPPLER
  ? false
  : 'pdftoppm not found — install poppler-utils (apt: poppler-utils, brew: poppler). '
    + 'The label geometry is UNVERIFIED without it.';
if (!HAVE_POPPLER) {
  console.error('\n########################################################################');
  console.error('# LABEL TESTS SKIPPED: pdftoppm (poppler-utils) is missing.             #');
  console.error('# The printed QR / Code 128 was NOT verified in this run — neither its  #');
  console.error('# geometry nor whether a decoder can read it.                           #');
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
 * gates every PR here, so this stays out of the shipped dependency tree.
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
 * Find a Code 128 symbol anywhere in a raster row and return its run structure.
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
// AND a Code 128 of the same TLY code.

const SMALL = { id: 1, name: 'Cordless Drill', qrCode: 'TLY-I-3A9F2C', type: 'item', tags: [], parentZone: null, breadcrumb: 'Home > Garage > Bin 4' };
const MEDIUM = { id: 5, name: 'Holiday Decorations', qrCode: 'TLY-C-8B1E2D', type: 'container', tags: ['fragile'], parentZone: 'Garage', breadcrumb: 'Home' };
const MANIFEST = {
  header: { name: 'Camping Gear', qrCode: 'TLY-C-1A2B3C', type: 'container', tags: [], parentZone: 'Garage', breadcrumb: 'Home' },
  rows: [{ name: 'Tent', qty: 1 }, { name: 'Lantern', qty: 2 }],
};

/** Render a single-page label and hand back its raster plus the QR placement. */
function renderOnePage(pdf, name) {
  const pages = rasterise(pdf, name);
  assert.equal(pages.length, 1, `${name}: expected a single-page fixture, got ${pages.length}`);
  const placements = imagePlacements(pdf);
  assert.equal(placements.length, 1, `${name}: expected exactly one placed image (the QR), got ${placements.length}`);
  return { img: pages[0], placement: placements[0] };
}

module.exports = {
  Labels,
  CLIENT_URL,
  DPI,
  dots,
  HAVE_POPPLER,
  SKIP,
  rasterise,
  decodePng,
  pixel,
  isDark,
  darkBox,
  runsInRow,
  imagePlacements,
  findBarcodeInRow,
  renderOnePage,
  SMALL,
  MEDIUM,
  MANIFEST,
};

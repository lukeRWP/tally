# Label Redesign Implementation Plan (Phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render tally labels as correctly-sized PDFs for the Munbyn ITPP941 (TSPL, 203 dpi) with three presets — Small (2×1 item tag), Medium (3×3 bin/location tag), Large (4×6 contents manifest) — sharing an inverted-title-bar + rotated location-banner look; drop the Zebra-only ZPL path, keep the Avery sheet.

**Architecture:** All label output is PDF via `pdfkit` (already a dependency). One geometry source of truth (`PRESETS`) drives the server renderer and, mirrored, the client preview. `small`/`medium` render one label-sized page per entity; `large` renders a paginated contents manifest for one container/area. The generate route dispatches on a new `preset` field. Membership scoping (the shipped IDOR fix) is preserved on every query.

**Tech Stack:** Node/Express (CommonJS), `pdfkit`, `qrcode`, Joi, `node:test` + fakeDb (no real DB — tally's convention). Client: React 18 + TS + Vite, TanStack Query.

## Global Constraints

- Printer target: **Munbyn ITPP941, TSPL, 203 dpi**. 72 pt = 1 in; 203 px = 1 in.
- Preset dimensions (exact): **small 2×1 in = 144×72 pt**; **medium 3×3 in = 216×216 pt**; **large 4×6 in = 288×432 pt**.
- **Every** `labels.service` query stays scoped by `USER_ID` via `property_members` (privacy invariant). `db.query()` returns rows directly (never `[rows]`).
- Labels render **black-on-white** (physical thermal reality). Title = white-on-black inverted bar; location banner = white-on-black, rotated 90°, on the **left** edge. Banner text = **parent zone**: container→its Area, area→its Property; item→no banner.
- **ZPL is removed**; the **Avery 30-up sheet** (`preset: 'sheet'`) is kept unchanged.
- `large` is valid only for `entityType` `container` or `area` (rejected for `item`). Large lists **direct** contents only (no nesting): a container lists its items (name + quantity); an area lists its direct containers (name + item-count).
- Response is always `application/pdf` attachment.
- Conventions: route prefixes `_x_`/`_y_`/`_u_`/`_p_`/`_d_`; envelope `{success,data,message}`; UPPER_SNAKE DB cols, camelCase API.

---

## File Structure

**Server (modify):**
- `server/src/modules/labels/labels.schema.js` — `generateLabels` gains `preset`; enforces large-requires-container/area.
- `server/src/modules/labels/labels.service.js` — add `PRESETS`, `_invertedTitle`, `_verticalBanner`, `_drawTag`, `renderLabelPdf`, `manifestPageCount`, `getManifest`, `renderManifestPdf`; extend `getEntityData` with `parentZone`; **remove** `generateZpl`. Keep `generatePdf` (Avery), `generateQrBuffer`, `resolveCode`.
- `server/src/modules/labels/labels.routes.js` — generate handler dispatches on `preset`; ZPL branch removed.
- `server/test/labels.test.js` — extend with schema, `getEntityData` parent-zone, renderer structure, `getManifest` scoping, pagination tests.

**Client (modify):**
- `client/src/hooks/use-labels.ts` — `preset` param; always-PDF (ZPL branch removed).
- `client/src/components/labels/label-print-dialog.tsx` — preset selector; default by type; `large` only for a single container/area; ZPL UI removed.
- `client/src/components/labels/label-preview.tsx` — to-scale preview per preset (inverted title, banner, QR).

---

## Task 1: Schema — `preset` field + large-requires-container/area

**Files:**
- Modify: `server/src/modules/labels/labels.schema.js`
- Test: `server/test/labels.test.js`

**Interfaces:**
- Produces: `generateLabels` Joi object accepting `{ entityType, entityIds, preset }` where `preset ∈ {small,medium,large,sheet}` (default `small`), and rejecting `preset:'large'` with `entityType:'item'`.

- [ ] **Step 1: Write the failing tests** — append to `server/test/labels.test.js`:

```js
const schema = require('../src/modules/labels/labels.schema');

test('generateLabels accepts a preset and defaults to small', () => {
  const ok = schema.generateLabels.validate({ entityType: 'item', entityIds: [1] });
  assert.equal(ok.error, undefined);
  assert.equal(ok.value.preset, 'small');
  assert.equal(schema.generateLabels.validate({ entityType: 'container', entityIds: [1], preset: 'medium' }).error, undefined);
});

test('generateLabels rejects an unknown preset', () => {
  assert.ok(schema.generateLabels.validate({ entityType: 'item', entityIds: [1], preset: 'giant' }).error);
});

test('generateLabels rejects large for items (container/area only)', () => {
  assert.ok(schema.generateLabels.validate({ entityType: 'item', entityIds: [1], preset: 'large' }).error);
  assert.equal(schema.generateLabels.validate({ entityType: 'container', entityIds: [1], preset: 'large' }).error, undefined);
  assert.equal(schema.generateLabels.validate({ entityType: 'area', entityIds: [1], preset: 'large' }).error, undefined);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && node --test test/labels.test.js`
Expected: FAIL (preset not accepted / default missing).

- [ ] **Step 3: Implement** — replace `server/src/modules/labels/labels.schema.js` with:

```js
const Joi = require('joi');

const generateLabels = Joi.object({
  entityType: Joi.string().valid('item', 'container', 'area').required(),
  entityIds: Joi.array().items(Joi.number().integer()).min(1).max(100).required(),
  preset: Joi.string().valid('small', 'medium', 'large', 'sheet').default('small'),
}).custom((value, helpers) => {
  // Large is a contents manifest — only meaningful for a container or area.
  if (value.preset === 'large' && value.entityType === 'item') {
    return helpers.message('preset "large" is only valid for containers or areas');
  }
  return value;
}, 'large-requires-container-or-area');

const resolveCode = Joi.object({
  code: Joi.string().pattern(/^TLY-[PACI]-[0-9A-Fa-f]{4,8}$/).required(),
});

module.exports = { generateLabels, resolveCode };
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && node --test test/labels.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/labels/labels.schema.js server/test/labels.test.js
git commit -m "feat(labels): preset param + large-requires-container/area"
```

---

## Task 2: `PRESETS` geometry + `getEntityData` parent zone

**Files:**
- Modify: `server/src/modules/labels/labels.service.js`
- Test: `server/test/labels.test.js`

**Interfaces:**
- Produces:
  - `PRESETS` — not exported, module-internal constant used by later tasks: `PRESETS[key] = { widthPt, heightPt, qrPt, banner, title, code, row, rowGap }`.
  - `getEntityData(type, ids, userId)` → each row now `{ id, name, qrCode, parentZone, breadcrumb }`. For **item**: `parentZone: null`, `breadcrumb: 'Property > Area > Container'`. For **container**: `parentZone: AREA_NAME`, `breadcrumb: PROPERTY_NAME`. For **area**: `parentZone: PROPERTY_NAME`, `breadcrumb: ''`.

- [ ] **Step 1: Write the failing test** — append to `server/test/labels.test.js`:

```js
const Labels = require('../src/modules/labels/labels.service');
function fakeDb(handler) { return { query: async (sql, params) => handler(sql, params) }; }
const logger = { warn() {}, info() {}, error() {} };
const config = { clientUrl: 'https://tally.example' };

test('getEntityData exposes parentZone per type (Area for container, Property for area)', async () => {
  Labels.init({ db: fakeDb((sql) => {
    if (/FROM TALLY\.containers c/i.test(sql)) return [{ ID: 5, NAME: 'Camping Gear', QR_CODE: 'TLY-C-1', AREA_NAME: 'Garage', PROPERTY_NAME: 'Home' }];
    return [];
  }), logger, config });
  const [c] = await Labels.getEntityData('container', [5], 42);
  assert.equal(c.parentZone, 'Garage');   // banner
  assert.equal(c.breadcrumb, 'Home');     // header remainder

  Labels.init({ db: fakeDb((sql) => {
    if (/FROM TALLY\.areas a/i.test(sql)) return [{ ID: 3, NAME: 'Garage', QR_CODE: 'TLY-A-1', PROPERTY_NAME: 'Home' }];
    return [];
  }), logger, config });
  const [a] = await Labels.getEntityData('area', [3], 42);
  assert.equal(a.parentZone, 'Home');
  assert.equal(a.breadcrumb, '');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && node --test test/labels.test.js`
Expected: FAIL (`parentZone` undefined).

- [ ] **Step 3: Implement** — in `server/src/modules/labels/labels.service.js`, add the `PRESETS` constant right after the `require` lines (top of file, before `let _db`):

```js
// Geometry for the thermal single-label + manifest presets. 72 pt = 1 inch.
// `banner` is the left location-banner strip width in pt (0 = no banner).
const PRESETS = {
  small:  { widthPt: 144, heightPt: 72,  qrPt: 60,  banner: 0,  title: 11, code: 8 },
  medium: { widthPt: 216, heightPt: 216, qrPt: 118, banner: 26, title: 15, code: 10 },
  large:  { widthPt: 288, heightPt: 432, qrPt: 54,  banner: 22, title: 13, code: 8, row: 11, rowGap: 3 },
};
```

Then change the three `return rows.map(...)` blocks in `getEntityData` so each row includes `parentZone`. Replace the **item** map with:

```js
      return rows.map(row => ({
        id: row.ID, name: row.NAME, qrCode: row.QR_CODE,
        parentZone: null,
        breadcrumb: [row.PROPERTY_NAME, row.AREA_NAME, row.CONTAINER_NAME].filter(Boolean).join(' > '),
      }));
```

Replace the **container** map with:

```js
      return rows.map(row => ({
        id: row.ID, name: row.NAME, qrCode: row.QR_CODE,
        parentZone: row.AREA_NAME || null,
        breadcrumb: row.PROPERTY_NAME || '',
      }));
```

Replace the **area** map with:

```js
      return rows.map(row => ({
        id: row.ID, name: row.NAME, qrCode: row.QR_CODE,
        parentZone: row.PROPERTY_NAME || null,
        breadcrumb: '',
      }));
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && node --test test/labels.test.js`
Expected: PASS. (The existing security tests in this file still pass — the SQL is unchanged, only the returned object shape gained `parentZone`.)

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/labels/labels.service.js server/test/labels.test.js
git commit -m "feat(labels): PRESETS geometry + parentZone in getEntityData"
```

---

## Task 3: Single-label renderer (`small` / `medium`)

**Files:**
- Modify: `server/src/modules/labels/labels.service.js`
- Test: `server/test/labels.test.js`

**Interfaces:**
- Consumes: `PRESETS`, `generateQrBuffer`, entities from `getEntityData` (`{name, qrCode, parentZone, breadcrumb}`).
- Produces: `async renderLabelPdf(entities, presetKey)` → a PDF `Buffer` with **one page per entity** at the preset's dimensions. Plus internal helpers `_invertedTitle`, `_verticalBanner`, `_drawTag`.

- [ ] **Step 1: Write the failing test** — append:

```js
function pdfPageCount(buf) { return (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length; }

test('renderLabelPdf makes one page per entity and is a PDF', async () => {
  Labels.init({ db: fakeDb(() => []), logger, config });
  const entities = [
    { id: 1, name: 'Cordless Drill', qrCode: 'TLY-I-3A9F2C', parentZone: null, breadcrumb: 'Home > Garage > Bin 4' },
    { id: 2, name: 'Circular Saw', qrCode: 'TLY-I-7B2E1D', parentZone: null, breadcrumb: 'Home > Garage > Bin 4' },
  ];
  const buf = await Labels.renderLabelPdf(entities, 'small');
  assert.ok(Buffer.isBuffer(buf) && buf.slice(0, 4).toString() === '%PDF');
  assert.equal(pdfPageCount(buf), 2);

  const med = await Labels.renderLabelPdf(
    [{ id: 5, name: 'Holiday Decorations', qrCode: 'TLY-C-8B1E2D', parentZone: 'Garage', breadcrumb: 'Home' }], 'medium');
  assert.ok(med.slice(0, 4).toString() === '%PDF');
  assert.equal(pdfPageCount(med), 1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && node --test test/labels.test.js`
Expected: FAIL (`renderLabelPdf` not a function).

- [ ] **Step 3: Implement** — add these methods to the `LabelsService` object (place after `generateQrBuffer`):

```js
  // ── Thermal single-label rendering ───────────────────────────────────────

  _invertedTitle(doc, text, x, y, w, fontSize, align = 'left') {
    const padX = 5, padY = 3, lineH = fontSize * 1.15, boxH = lineH + padY * 2;
    doc.save().roundedRect(x, y, w, boxH, 2).fill('#000000').restore();
    doc.fontSize(fontSize).font('Helvetica-Bold').fillColor('#ffffff')
      .text(String(text).toUpperCase(), x + padX, y + padY,
        { width: w - padX * 2, height: lineH, align, lineBreak: false, ellipsis: true });
    doc.fillColor('#000000');
    return boxH;
  },

  _verticalBanner(doc, text, H, bannerW, fontSize) {
    doc.save().rect(0, 0, bannerW, H).fill('#000000').restore();
    doc.save();
    doc.rotate(-90, { origin: [bannerW / 2, H / 2] });
    // After rotating -90° about the banner centre, a normal horizontal text box
    // of width H (the label height) reads bottom-to-top down the strip.
    doc.fontSize(fontSize).font('Helvetica-Bold').fillColor('#ffffff')
      .text(String(text).toUpperCase(), bannerW / 2 - H / 2, H / 2 - fontSize / 2 - 1,
        { width: H, align: 'center', lineBreak: false, ellipsis: true, characterSpacing: 1 });
    doc.restore();
    doc.fillColor('#000000');
  },

  _drawTag(doc, e, qrBuf, P, presetKey) {
    const W = P.widthPt, H = P.heightPt, pad = 6;
    const bannerW = (P.banner && e.parentZone) ? P.banner : 0;
    if (bannerW) LabelsService._verticalBanner(doc, e.parentZone, H, bannerW, Math.min(P.title, 12));
    const cx = bannerW, cw = W - bannerW;

    if (presetKey === 'small') {
      const qr = Math.min(P.qrPt, H - pad * 2);
      doc.image(qrBuf, cx + pad, (H - qr) / 2, { width: qr });
      const tx = cx + pad + qr + pad, tw = W - tx - pad;
      LabelsService._invertedTitle(doc, e.name, tx, pad + 2, tw, P.title);
      doc.fontSize(P.code).font('Courier').fillColor('#000000')
        .text(String(e.qrCode).toUpperCase(), tx, H - pad - P.code - 1, { width: tw, lineBreak: false, ellipsis: true });
    } else { // medium
      LabelsService._invertedTitle(doc, e.name, cx + pad, pad, cw - pad * 2, P.title, 'center');
      const qr = P.qrPt, qrX = cx + (cw - qr) / 2, qrY = pad + P.title + 16;
      doc.image(qrBuf, qrX, qrY, { width: qr });
      const fy = H - pad - P.code - 3;
      doc.save().moveTo(cx + pad, fy - 5).lineTo(W - pad, fy - 5).lineWidth(1).strokeColor('#000000').stroke().restore();
      doc.fontSize(P.code).font('Courier').fillColor('#000000')
        .text(String(e.qrCode).toUpperCase(), cx + pad, fy, { width: cw - pad * 2, lineBreak: false, ellipsis: true });
    }
    doc.fillColor('#000000');
  },

  async renderLabelPdf(entities, presetKey) {
    const P = PRESETS[presetKey];
    const qrBuffers = await Promise.all(entities.map(e => LabelsService.generateQrBuffer(e.qrCode, P.qrPt * 3)));
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: [P.widthPt, P.heightPt], margin: 0 });
      const bufs = [];
      doc.on('data', b => bufs.push(b));
      doc.on('end', () => resolve(Buffer.concat(bufs)));
      doc.on('error', reject);
      entities.forEach((e, i) => {
        if (i > 0) doc.addPage({ size: [P.widthPt, P.heightPt], margin: 0 });
        LabelsService._drawTag(doc, e, qrBuffers[i], P, presetKey);
      });
      doc.end();
    });
  },
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && node --test test/labels.test.js`
Expected: PASS.

- [ ] **Step 5: Visual self-check (manual, no automated assert)**

Render a sample to disk and eyeball it against the approved mockup (inverted title bar, banner on the left for medium, QR placement):
```bash
cd server && node -e "const L=require('./src/modules/labels/labels.service'); L.init({db:{query:async()=>[]},logger:console,config:{clientUrl:'http://x'}}); L.renderLabelPdf([{name:'Holiday Decorations',qrCode:'TLY-C-8B1E2D',parentZone:'Garage',breadcrumb:'Home'}],'medium').then(b=>require('fs').writeFileSync('/tmp/medium.pdf',b));"
```
Open `/tmp/medium.pdf`. If spacing is off, adjust the offsets in `_drawTag` (this is layout tuning, not a logic change).

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/labels/labels.service.js server/test/labels.test.js
git commit -m "feat(labels): thermal single-label renderer (small/medium)"
```

---

## Task 4: Contents manifest (`large`) — data + renderer

**Files:**
- Modify: `server/src/modules/labels/labels.service.js`
- Test: `server/test/labels.test.js`

**Interfaces:**
- Consumes: `PRESETS`, `getEntityData`, `_verticalBanner`, `_invertedTitle`, `generateQrBuffer`.
- Produces:
  - `manifestPageCount(rowCount, presetKey)` → number of 4×6 pages (pure, testable).
  - `async getManifest(entityType, id, userId)` → `{ header, rows }` or `null`. `header` = the `getEntityData` object; `rows` = `[{ name, qty }]` — a **container**'s direct items (`qty` = item quantity) or an **area**'s direct containers (`qty` = # items in that container). Membership-scoped.
  - `async renderManifestBundle(manifests, presetKey)` → a single PDF `Buffer` with each manifest's paginated pages concatenated. `async renderManifestPdf(manifest, presetKey)` is a thin wrapper = `renderManifestBundle([manifest], presetKey)`. Task 5's route calls `renderManifestBundle` directly.

- [ ] **Step 1: Write the failing tests** — append:

```js
test('manifestPageCount paginates by the large preset row capacity', () => {
  const n1 = Labels.manifestPageCount(1, 'large');
  const many = Labels.manifestPageCount(500, 'large');
  assert.equal(n1, 1);
  assert.ok(many > 1, 'a long list spans multiple pages');
  assert.equal(Labels.manifestPageCount(0, 'large'), 1, 'empty manifest is still one page');
});

test('getManifest is membership-scoped and returns name+qty rows for a container', async () => {
  let itemSql = '';
  Labels.init({ db: fakeDb((sql, params) => {
    if (/FROM TALLY\.containers c/i.test(sql) && /property_members/i.test(sql) && /IN \(/i.test(sql))
      return [{ ID: 5, NAME: 'Camping Gear', QR_CODE: 'TLY-C-1', AREA_NAME: 'Garage', PROPERTY_NAME: 'Home' }]; // getEntityData header
    if (/FROM TALLY\.items i/i.test(sql)) { itemSql = sql; return [{ name: 'Tent', qty: 1 }, { name: 'Lantern', qty: 2 }]; }
    return [];
  }), logger, config });
  const m = await Labels.getManifest('container', 5, 42);
  assert.equal(m.header.name, 'Camping Gear');
  assert.deepEqual(m.rows, [{ name: 'Tent', qty: 1 }, { name: 'Lantern', qty: 2 }]);
  assert.match(itemSql, /property_members/i, 'the manifest item query is membership-scoped');
  assert.match(itemSql, /pm\.USER_ID = \?/i);
});

test('getManifest returns null for an entity the caller does not own', async () => {
  Labels.init({ db: fakeDb(() => []), logger, config }); // getEntityData yields no header
  assert.equal(await Labels.getManifest('container', 999, 42), null);
});

test('renderManifestPdf produces a PDF (paginated by row count)', async () => {
  Labels.init({ db: fakeDb(() => []), logger, config });
  const rows = Array.from({ length: 60 }, (_, i) => ({ name: `Item ${i + 1}`, qty: (i % 3) + 1 }));
  const buf = await Labels.renderManifestPdf(
    { header: { name: 'Camping Gear', qrCode: 'TLY-C-1', parentZone: 'Garage', breadcrumb: 'Home' }, rows }, 'large');
  assert.ok(buf.slice(0, 4).toString() === '%PDF');
  assert.equal(pdfPageCount(buf), Labels.manifestPageCount(60, 'large'));
});

test('renderManifestBundle concatenates several manifests into one PDF', async () => {
  Labels.init({ db: fakeDb(() => []), logger, config });
  const mk = (n, count) => ({ header: { name: n, qrCode: 'TLY-C-1', parentZone: 'Garage', breadcrumb: 'Home' },
    rows: Array.from({ length: count }, (_, i) => ({ name: `x${i}`, qty: 1 })) });
  const buf = await Labels.renderManifestBundle([mk('A', 3), mk('B', 3)], 'large');
  assert.ok(buf.slice(0, 4).toString() === '%PDF');
  // Two single-page manifests → two pages total (no blank leading page).
  assert.equal(pdfPageCount(buf), Labels.manifestPageCount(3, 'large') * 2);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && node --test test/labels.test.js`
Expected: FAIL (`manifestPageCount` / `getManifest` not functions).

- [ ] **Step 3: Implement** — add to `LabelsService` (after `renderLabelPdf`):

```js
  // ── Contents manifest (large) ─────────────────────────────────────────────

  // Layout constants shared by the pagination math and the renderer.
  _manifestLayout(P) {
    const pad = 10, headerH = 66, colHdrH = 14, footerH = 18;
    const rowH = P.row + P.rowGap;
    const listTop = pad + headerH + colHdrH;
    const listBottom = P.heightPt - pad - footerH;
    const rowsPerPage = Math.max(1, Math.floor((listBottom - listTop) / rowH));
    return { pad, headerH, colHdrH, footerH, rowH, listTop, rowsPerPage };
  },

  manifestPageCount(rowCount, presetKey) {
    const { rowsPerPage } = LabelsService._manifestLayout(PRESETS[presetKey]);
    return Math.max(1, Math.ceil((rowCount || 0) / rowsPerPage));
  },

  async getManifest(entityType, id, userId) {
    const [header] = await LabelsService.getEntityData(entityType, [id], userId);
    if (!header) return null; // not found OR not the caller's — route 404s

    let rows;
    if (entityType === 'container') {
      rows = await _db.query(
        `SELECT i.NAME AS name, i.QUANTITY AS qty
         FROM TALLY.items i
         JOIN TALLY.containers c ON i.CONTAINER_ID = c.ID
         JOIN TALLY.areas a ON c.AREA_ID = a.ID
         JOIN TALLY.property_members pm ON pm.PROPERTY_ID = a.PROPERTY_ID AND pm.USER_ID = ?
         WHERE i.CONTAINER_ID = ? AND i.DELETED_AT IS NULL
         ORDER BY i.NAME`,
        [userId, id]
      );
    } else { // area → its direct containers, qty = # items inside each
      rows = await _db.query(
        `SELECT c.NAME AS name,
                (SELECT COUNT(*) FROM TALLY.items i2 WHERE i2.CONTAINER_ID = c.ID AND i2.DELETED_AT IS NULL) AS qty
         FROM TALLY.containers c
         JOIN TALLY.areas a ON c.AREA_ID = a.ID
         JOIN TALLY.property_members pm ON pm.PROPERTY_ID = a.PROPERTY_ID AND pm.USER_ID = ?
         WHERE c.AREA_ID = ? AND c.DELETED_AT IS NULL
         ORDER BY c.NAME`,
        [userId, id]
      );
    }
    return { header, rows: rows.map(r => ({ name: r.name, qty: Number(r.qty) })) };
  },

  // One drawing routine for a single manifest — draws its own paginated pages
  // into an existing doc, calling startNewPage() at the top of each page. Both
  // the single-manifest and multi-manifest entry points go through this (DRY).
  async _drawManifest(doc, manifest, presetKey, startNewPage) {
    const P = PRESETS[presetKey];
    const W = P.widthPt, H = P.heightPt;
    const { header, rows } = manifest;
    const L = LabelsService._manifestLayout(P);
    const pageCount = LabelsService.manifestPageCount(rows.length, presetKey);
    const qrBuf = await LabelsService.generateQrBuffer(header.qrCode, P.qrPt * 3);
    const bannerW = header.parentZone ? P.banner : 0;

    for (let pg = 0; pg < pageCount; pg++) {
      startNewPage();
      if (bannerW) LabelsService._verticalBanner(doc, header.parentZone, H, bannerW, 13);
      const cx = bannerW;

      // Header: QR + inverted title + breadcrumb + code, bottom-bordered.
      doc.image(qrBuf, cx + L.pad, L.pad, { width: P.qrPt });
      const hx = cx + L.pad + P.qrPt + 8, hw = W - hx - L.pad;
      LabelsService._invertedTitle(doc, header.name, hx, L.pad, hw, P.title);
      doc.fontSize(8).font('Helvetica').fillColor('#333333')
        .text(header.breadcrumb || '', hx, L.pad + 24, { width: hw, lineBreak: false, ellipsis: true });
      doc.fontSize(7).font('Courier').fillColor('#666666')
        .text(String(header.qrCode).toUpperCase(), hx, L.pad + 36, { width: hw, lineBreak: false });
      doc.save().moveTo(cx + L.pad, L.pad + L.headerH).lineTo(W - L.pad, L.pad + L.headerH)
        .lineWidth(1.5).strokeColor('#000000').stroke().restore();

      // Column header.
      doc.fontSize(7).font('Courier').fillColor('#666666')
        .text('CONTENTS', cx + L.pad, L.pad + L.headerH + 3, { width: 120, lineBreak: false });
      doc.text('QTY', W - L.pad - 34, L.pad + L.headerH + 3, { width: 34, align: 'right' });

      // Rows for this page.
      const start = pg * L.rowsPerPage, end = Math.min(start + L.rowsPerPage, rows.length);
      let ry = L.listTop;
      for (let r = start; r < end; r++) {
        if ((r - start) % 2 === 1)
          doc.save().rect(cx + L.pad, ry - 1, W - cx - L.pad * 2, L.rowH).fill('#f0f0f0').restore();
        doc.fontSize(P.row).font('Helvetica').fillColor('#000000')
          .text(rows[r].name, cx + L.pad + 2, ry, { width: W - cx - L.pad * 2 - 38, lineBreak: false, ellipsis: true });
        doc.font('Courier').fillColor('#000000')
          .text(String(rows[r].qty), W - L.pad - 34, ry, { width: 30, align: 'right' });
        ry += L.rowH;
      }

      // Footer: total count + page x of n.
      const fy = H - L.pad - L.footerH + 5;
      doc.save().moveTo(cx + L.pad, fy - 5).lineTo(W - L.pad, fy - 5).lineWidth(1).strokeColor('#000000').stroke().restore();
      doc.fontSize(8).font('Courier').fillColor('#333333')
        .text(`${rows.length} item${rows.length === 1 ? '' : 's'}`, cx + L.pad, fy, { width: 120, lineBreak: false });
      doc.text(`Page ${pg + 1} of ${pageCount}`, W - L.pad - 100, fy, { width: 100, align: 'right' });
    }
  },

  // Render one or more manifests into a single PDF (each manifest's own pages,
  // concatenated). startNewPage() suppresses the first addPage so pdfkit's
  // implicit first page is reused.
  async renderManifestBundle(manifests, presetKey) {
    const P = PRESETS[presetKey];
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: [P.widthPt, P.heightPt], margin: 0 });
      const bufs = [];
      doc.on('data', b => bufs.push(b));
      doc.on('end', () => resolve(Buffer.concat(bufs)));
      doc.on('error', reject);
      let first = true;
      const startNewPage = () => { if (!first) doc.addPage({ size: [P.widthPt, P.heightPt], margin: 0 }); first = false; };
      (async () => {
        for (const m of manifests) await LabelsService._drawManifest(doc, m, presetKey, startNewPage);
        doc.end();
      })().catch(reject);
    });
  },

  async renderManifestPdf(manifest, presetKey) {
    return LabelsService.renderManifestBundle([manifest], presetKey);
  },
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && node --test test/labels.test.js`
Expected: PASS.

- [ ] **Step 5: Visual self-check (manual)**

```bash
cd server && node -e "const L=require('./src/modules/labels/labels.service'); L.init({db:{query:async()=>[]},logger:console,config:{clientUrl:'http://x'}}); const rows=Array.from({length:14},(_,i)=>({name:'Item '+(i+1),qty:(i%3)+1})); L.renderManifestPdf({header:{name:'Camping Gear',qrCode:'TLY-C-1',parentZone:'Garage',breadcrumb:'Home'},rows},'large').then(b=>require('fs').writeFileSync('/tmp/manifest.pdf',b));"
```
Open `/tmp/manifest.pdf`; verify header (title bar + QR), banner, item rows, footer. Tune offsets if needed.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/labels/labels.service.js server/test/labels.test.js
git commit -m "feat(labels): contents manifest (large) — getManifest + paginated renderer"
```

---

## Task 5: Route dispatch on `preset`; remove ZPL

**Files:**
- Modify: `server/src/modules/labels/labels.routes.js`
- Modify: `server/src/modules/labels/labels.service.js` (delete `generateZpl`)
- Test: `server/test/labels.test.js`

**Interfaces:**
- Consumes: `getEntityData`, `renderLabelPdf`, `getManifest`, `renderManifestBundle`, `generatePdf`.
- Produces: `POST /api/labels/_y_/generate` returns a PDF for every preset. `large` → 404 if the entity isn't found/owned.

- [ ] **Step 1: Write the failing test** — append (guards that ZPL is gone):

```js
test('generateZpl is removed from the service', () => {
  assert.equal(typeof Labels.generateZpl, 'undefined');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && node --test test/labels.test.js`
Expected: FAIL (`generateZpl` still a function).

- [ ] **Step 3: Implement** — replace the generate handler in `server/src/modules/labels/labels.routes.js` (the `app.post('/api/labels/_y_/generate', …)` block) with:

```js
  app.post(
    '/api/labels/_y_/generate',
    app.locals.requireAuth,
    validate(generateLabels, 'body'),
    async (req, res) => {
      const { entityType, entityIds, preset } = req.body;

      const sendPdf = (buf) => {
        res.set('Content-Type', 'application/pdf');
        res.set('Content-Disposition', 'attachment; filename="tally-labels.pdf"');
        res.send(buf);
      };

      // Large = one contents manifest per selected container/area.
      if (preset === 'large') {
        const manifests = [];
        for (const id of entityIds) {
          const m = await LabelsService.getManifest(entityType, id, req.user.id);
          if (m) manifests.push(m);
        }
        if (manifests.length === 0) return error(res, 'No entities found for the given IDs', 404);
        return sendPdf(await LabelsService.renderManifestBundle(manifests, 'large'));
      }

      const entities = await LabelsService.getEntityData(entityType, entityIds, req.user.id);
      if (entities.length === 0) return error(res, 'No entities found for the given IDs', 404);

      if (preset === 'sheet') {
        const labelTypeMap = { item: 'asset', container: 'bin', area: 'location' };
        return sendPdf(await LabelsService.generatePdf(entities, labelTypeMap[entityType] || 'asset'));
      }

      // small / medium
      return sendPdf(await LabelsService.renderLabelPdf(entities, preset));
    }
  );
```

`renderManifestBundle` already exists from Task 4 (the route calls it directly), so no new service render code is needed here.

Then **delete** the `generateZpl` method from `labels.service.js` (the whole `generateZpl(entities) { … }` block and its `// ── ZPL … ──` comment). Confirm nothing else references it: `grep -rn "generateZpl\|generateZpl\|'zpl'\|\"zpl\"" server/src` should return no hits after the route change.

- [ ] **Step 4: Run to verify it passes + no regressions**

Run: `cd server && node --test test/labels.test.js`
Then the full suite: `cd server && node --test`
Expected: all PASS (label tests + the rest). `pdfPageCount` for a single manifest still equals `manifestPageCount(n)`.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/labels/labels.routes.js server/src/modules/labels/labels.service.js server/test/labels.test.js
git commit -m "feat(labels): route dispatch on preset; remove ZPL"
```

---

## Task 6: Client — preset selector, preview, hook

**Files:**
- Modify: `client/src/hooks/use-labels.ts`
- Modify: `client/src/components/labels/label-print-dialog.tsx`
- Modify: `client/src/components/labels/label-preview.tsx`

**Interfaces:**
- Consumes: `POST /api/labels/_y_/generate` with `{ entityType, entityIds, preset }` → PDF blob.

- [ ] **Step 1: Update the hook** — replace `client/src/hooks/use-labels.ts` with (always-PDF, `preset` param):

```ts
import { useMutation } from '@tanstack/react-query';
import { getCsrfToken } from '@/lib/api';

export type LabelPreset = 'small' | 'medium' | 'large' | 'sheet';

export function useGenerateLabels() {
  return useMutation({
    mutationFn: async ({ entityType, entityIds, preset }:
      { entityType: string; entityIds: number[]; preset: LabelPreset }) => {
      // Raw fetch (not the `api` client) to handle the binary PDF blob; attach
      // CSRF the same way api.request() does.
      const csrf = getCsrfToken();
      const res = await fetch('/api/labels/_y_/generate', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
        body: JSON.stringify({ entityType, entityIds, preset }),
      });
      if (!res.ok) {
        let msg = 'Failed to generate labels';
        try { msg = (await res.json()).message || msg; } catch { /* non-JSON */ }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'tally-labels.pdf';
      a.click();
      URL.revokeObjectURL(url);
    },
  });
}

export function useQrImageUrl(code: string) {
  return `/api/labels/_x_/qr/${code}`;
}
```

- [ ] **Step 2: Update the preview** — replace `client/src/components/labels/label-preview.tsx` so it reflects the preset (inverted title bar; banner for medium/large; manifest hint for large):

```tsx
import type { LabelPreset } from '@/hooks/use-labels';

interface LabelPreviewProps {
  entity: { name: string; qrCode: string; type: string; breadcrumb?: string; parentZone?: string | null };
  qrImageUrl: string;
  preset: LabelPreset;
}

// Aspect ratios mirror the server PRESETS (2:1, 1:1, 2:3). Rendered small for the dialog.
const RATIO: Record<LabelPreset, { w: number; h: number }> = {
  small: { w: 220, h: 110 }, medium: { w: 200, h: 200 }, large: { w: 160, h: 240 }, sheet: { w: 200, h: 120 },
};

export function LabelPreview({ entity, qrImageUrl, preset }: LabelPreviewProps) {
  const dims = RATIO[preset];
  const banner = (preset === 'medium' || preset === 'large') && entity.parentZone ? entity.parentZone : null;
  return (
    <div className="mx-auto bg-white text-black rounded-[3px] border border-[var(--color-border)] overflow-hidden flex shadow-sm"
      style={{ width: dims.w, height: dims.h }}>
      {banner && (
        <div className="bg-black text-white flex items-center justify-center" style={{ width: 22 }}>
          <span className="font-bold uppercase tracking-wider" style={{ transform: 'rotate(-90deg)', whiteSpace: 'nowrap', fontSize: 11 }}>{banner}</span>
        </div>
      )}
      <div className="flex-1 min-w-0 p-2 flex flex-col gap-1.5">
        <span className="bg-black text-white font-extrabold rounded-[3px] px-1.5 py-1 leading-tight truncate"
          style={{ fontSize: preset === 'small' ? 11 : 13 }}>{entity.name}</span>
        <div className="flex-1 flex items-center justify-center">
          <img src={qrImageUrl} alt={`QR for ${entity.name}`}
            style={{ width: preset === 'large' ? 44 : 72, height: preset === 'large' ? 44 : 72 }} className="bg-white" />
        </div>
        <span className="font-mono text-black leading-tight truncate" style={{ fontSize: 9 }}>{entity.qrCode}</span>
        {preset === 'large' && <span className="text-black leading-tight" style={{ fontSize: 9 }}>+ contents list…</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Update the dialog** — in `client/src/components/labels/label-print-dialog.tsx`: import `LabelPreset`; replace the `format` state + the Format button group + the ZPL output block; pass `preset` to the preview and the mutation. Replace the component body's state and the two format-related blocks:

Replace the state/effects:
```tsx
  const [preset, setPreset] = React.useState<LabelPreset>(entityType === 'item' ? 'small' : 'medium');
  const generateLabels = useGenerateLabels();
  React.useEffect(() => { if (!isOpen) generateLabels.reset(); }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps
```

Replace `handleGenerate`:
```tsx
  function handleGenerate() {
    if (entities.length === 0) return;
    generateLabels.mutate(
      { entityType, entityIds: entities.map((e) => e.id), preset },
      { onSuccess: () => toast('PDF downloaded'),
        onError: (err) => toast(err instanceof Error ? err.message : 'Failed to generate labels') },
    );
  }
```

Replace the Preview usage and the Format selector block (delete the ZPL output block entirely):
```tsx
          {firstEntity && (
            <div>
              <p className="text-xs text-[var(--color-text-muted)] mb-2">Preview</p>
              <LabelPreview entity={firstEntity} qrImageUrl={qrImageUrl} preset={preset} />
              {entities.length > 1 && preset !== 'large' && (
                <p className="text-[10px] text-[var(--color-text-muted)] mt-1">+ {entities.length - 1} more</p>
              )}
            </div>
          )}

          <div>
            <p className="text-xs text-[var(--color-text-muted)] mb-2">Size</p>
            <div className="grid grid-cols-2 gap-2">
              <Button variant={preset === 'small' ? 'default' : 'outline'} size="sm" onClick={() => setPreset('small')}>Small · 2×1</Button>
              <Button variant={preset === 'medium' ? 'default' : 'outline'} size="sm" onClick={() => setPreset('medium')}>Medium · 3×3</Button>
              {entityType !== 'item' && entities.length === 1 && (
                <Button variant={preset === 'large' ? 'default' : 'outline'} size="sm" onClick={() => setPreset('large')}>Large · 4×6 list</Button>
              )}
              <Button variant={preset === 'sheet' ? 'default' : 'outline'} size="sm" onClick={() => setPreset('sheet')}>Avery sheet</Button>
            </div>
          </div>
```

Remove now-unused imports (`Copy`) and the `zplOutput` state / `handleCopyZpl` / the ZPL `<textarea>` block. Keep `Download`, `Printer`, `Button`, `LabelPreview`, `useGenerateLabels`, `useQrImageUrl`, `toast`, `LabelPreset`.

> Guard: `large` is only offered when a **single non-item** entity is selected (a manifest is per-container/area). If `preset` was `large` and the selection changes to items/multi, reset to a valid default before generating — add: `React.useEffect(() => { if (preset === 'large' && (entityType === 'item' || entities.length !== 1)) setPreset(entityType === 'item' ? 'small' : 'medium'); }, [entityType, entities.length]); // eslint-disable-line`

- [ ] **Step 4: Gate — typecheck, lint, build**

Run: `cd client && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/eslint src/hooks/use-labels.ts src/components/labels/label-print-dialog.tsx src/components/labels/label-preview.tsx && npm run build`
Expected: tsc clean; ESLint 0 errors; build succeeds. Fix any caller of `LabelPreview`/`useGenerateLabels` whose props changed (search: `grep -rn "LabelPreview\|useGenerateLabels\|LabelPrintDialog" client/src`).

- [ ] **Step 5: Manual check**

Run the app; open the print dialog from an item (Small/Medium/Avery offered, Large hidden), a container (Large offered), and an area. Generate each → a correctly-sized PDF downloads; preview reflects the preset (inverted title, banner, QR). Confirm the ZPL option is gone.

- [ ] **Step 6: Commit**

```bash
git add client/src/hooks/use-labels.ts client/src/components/labels/label-print-dialog.tsx client/src/components/labels/label-preview.tsx
git commit -m "feat(labels): preset selector + to-scale preview; drop ZPL UI"
```

---

## Self-Review

**Spec coverage:**
- Render as PDF at stock size via pdfkit → Tasks 3, 4. ✓
- Small/Medium/Large presets + exact dimensions → Task 2 `PRESETS`, Tasks 3–4 renderers. ✓
- Inverted title bar + rotated left location banner (parent zone) → `_invertedTitle`/`_verticalBanner` (Task 3), used in 3+4; `parentZone` (Task 2). ✓
- Large = container/area contents (direct); container→items name+qty, area→containers name+count; pagination → Task 4. ✓
- `preset` API param; `large` rejects item; PDF always; ZPL removed; Avery kept → Tasks 1, 5. ✓
- Membership scoping preserved → getEntityData unchanged SQL (Task 2), getManifest scoped (Task 4). ✓
- Client preset selector (default by type, large only for single container/area), preview, download → Task 6. ✓

**Placeholder scan:** No TBD/TODO. The Task-5 refactor note (extract `_drawManifest`) includes the concrete before/after and states the Task-4 body moves verbatim — the drawing code exists in Task 4; not a placeholder.

**Type consistency:** `getEntityData` row shape `{id,name,qrCode,parentZone,breadcrumb}` is produced in Task 2 and consumed in Tasks 3–4. `renderLabelPdf(entities, presetKey)`, `getManifest(entityType,id,userId)→{header,rows}`, `manifestPageCount(rowCount,presetKey)`, `renderManifestPdf(manifest,presetKey)`, `renderManifestBundle(manifests,presetKey)` names are consistent across tasks. Client `LabelPreset` type + `{entityType,entityIds,preset}` body match the server Joi. `LabelPreview` new `preset` prop is threaded from the dialog.

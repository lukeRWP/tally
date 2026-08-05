const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');
const { parseCode } = require('../../utils/qr');
const code128 = require('./code128');

// Geometry for the thermal single-label + manifest presets. 72 pt = 1 inch.
// `banner` is the left location-banner strip width in pt (0 = no banner) and
// `bannerFont` its type size. This table is the single source of geometry
// truth — renderers must not hard-code sizes.
const PRESETS = {
  small:  { widthPt: 144, heightPt: 72,  qrPt: 60,  banner: 0,  bannerFont: 0,  title: 11, code: 8 },
  medium: { widthPt: 216, heightPt: 216, qrPt: 118, banner: 38, bannerFont: 20, bannerTrack: 6, title: 15, code: 10 },
  // qrPt MUST stay below _manifestLayout's headerH (72): the QR is drawn from
  // the top pad downward, so anything taller punches through the header rule
  // and collides with the CONTENTS row — it did, at 72pt. 60 leaves 12pt of
  // clearance while still printing larger than the original 54pt.
  large:  { widthPt: 288, heightPt: 432, qrPt: 60,  banner: 36, bannerFont: 21, bannerTrack: 7, title: 13, code: 8, row: 11, rowGap: 3 },
};

let _db = null;
let _logger = null;
let _baseUrl = null;

const LabelsService = {
  // ── Initialization ─────────────────────────────────────────────────────────

  init({ db, logger, config }) {
    _db = db;
    _logger = logger;
    _baseUrl = config.clientUrl;
  },

  // ── QR Code Generation ──────────────────────────────────────────────────────

  // 203 dpi is the ITPP941 head. Sizing a QR to an exact whole number of
  // printer dots means one image pixel maps to one dot, so module edges land
  // on dot boundaries instead of being resampled into greys that dither.
  _qrDots(pt) { return Math.round((pt / 72) * 203); },

  async generateQrBuffer(code, size = 200) {
    const url = `${_baseUrl}/s/${code}`;
    return QRCode.toBuffer(url, { width: size, margin: 1 });
  },

  // ── Thermal single-label rendering ───────────────────────────────────────

  _invertedTitle(doc, text, x, y, w, fontSize, align = 'left') {
    const padX = 5, padY = 4;
    doc.fontSize(fontSize).font('Helvetica-Bold');
    // Measure rather than assume: currentLineHeight() reflects the actual font
    // metrics, so the bar hugs the type at any size.
    const lineH = doc.currentLineHeight();
    const boxH = lineH + padY * 2;
    doc.save().roundedRect(x, y, w, boxH, 2).fill('#000000').restore();
    // The line box reserves descender room these all-caps strings never use, so
    // centring the box alone leaves the caps riding high. Nudge down by a
    // fraction of the size to centre what the eye actually sees.
    const capNudge = fontSize * 0.08;
    doc.fillColor('#ffffff')
      .text(String(text).toUpperCase(), x + padX, y + (boxH - lineH) / 2 + capNudge,
        { width: w - padX * 2, height: lineH, align, lineBreak: false, ellipsis: true });
    doc.fillColor('#000000');
    return boxH;
  },

  // White-on-black knockout text loses weight to thermal bleed: the head burns
  // marginally wider than the nominal dot, so black creeps into the letterforms
  // and thin strokes close up. Banner type is therefore set larger and more
  // widely tracked than would look right on screen — it prints back to normal.
  _verticalBanner(doc, text, H, bannerW, fontSize, track = 1) {
    doc.save().rect(0, 0, bannerW, H).fill('#000000').restore();
    doc.save();
    doc.rotate(-90, { origin: [bannerW / 2, H / 2] });
    // After rotating -90° about the banner centre, a normal horizontal text box
    // of width H (the label height) reads bottom-to-top down the strip.
    doc.fontSize(fontSize).font('Helvetica-Bold');
    // In the rotated frame this y controls position ACROSS the strip's width,
    // so centring the measured line box centres the type in the black bar.
    const lineH = doc.currentLineHeight();
    doc.fillColor('#ffffff')
      .text(String(text).toUpperCase(), bannerW / 2 - H / 2,
        H / 2 - lineH / 2 + fontSize * 0.08,
        { width: H, align: 'center', lineBreak: false, ellipsis: true, characterSpacing: track });
    doc.restore();
    doc.fillColor('#000000');
  },

  _drawTag(doc, e, qrBuf, P, presetKey) {
    const W = P.widthPt, H = P.heightPt, pad = 6;
    const bannerW = (P.banner && e.parentZone) ? P.banner : 0;
    if (bannerW) LabelsService._verticalBanner(doc, e.parentZone, H, bannerW, P.bannerFont, P.bannerTrack);
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
      // Footer: TLY code on the left, entity type on the right. The code's box
      // stops short of typeW so a long code can never run under the type.
      const fy = H - pad - P.code - 3, typeW = 60;
      doc.save().moveTo(cx + pad, fy - 5).lineTo(W - pad, fy - 5).lineWidth(1).strokeColor('#000000').stroke().restore();
      doc.fontSize(P.code).font('Courier').fillColor('#000000')
        .text(String(e.qrCode).toUpperCase(), cx + pad, fy, { width: cw - pad * 2 - typeW, lineBreak: false, ellipsis: true });
      if (e.type) {
        doc.fontSize(P.code - 1).font('Courier-Bold').fillColor('#000000')
          .text(String(e.type).toUpperCase(), W - pad - typeW, fy, { width: typeW, align: 'right', lineBreak: false, ellipsis: true });
      }
    }
  },

  async renderLabelPdf(entities, presetKey) {
    const P = PRESETS[presetKey];
    const qrBuffers = await Promise.all(entities.map(e => LabelsService.generateQrBuffer(e.qrCode, LabelsService._qrDots(P.qrPt))));
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

  // ── Contents manifest (large) ─────────────────────────────────────────────

  // Draw a Code 128 barcode, snapping every module to a whole printer dot.
  // At 203 dpi a bar edge that lands mid-dot gets resampled into a ragged
  // width and the symbol stops scanning — the same failure that killed the QR.
  // Returns the drawn width in points.
  _barcodeWidthPt(text, dotsPerModule = 3) {
    const { modules } = code128.encode(text);
    return modules.reduce((a, b) => a + b, 0) * (dotsPerModule / 203) * 72;
  },

  _drawBarcode(doc, text, x, y, heightPt, dotsPerModule = 3) {
    const { modules } = code128.encode(text);
    const modulePt = (dotsPerModule / 203) * 72;   // exact whole dots
    let cx = x;
    modules.forEach((w, i) => {
      const wPt = w * modulePt;
      if (i % 2 === 0) doc.save().rect(cx, y, wPt, heightPt).fill('#000000').restore();  // even = bar
      cx += wPt;
    });
    return cx - x;
  },

  // Layout constants shared by the pagination math and the renderer.
  _manifestLayout(P) {
    // barcodeH covers the Code 128 strip above the footer rule.
    const pad = 10, headerH = 72, colHdrH = 14, footerH = 18, barcodeH = 34;
    const rowH = P.row + P.rowGap;
    const listTop = pad + headerH + colHdrH;
    const listBottom = P.heightPt - pad - footerH - barcodeH;
    const rowsPerPage = Math.max(1, Math.floor((listBottom - listTop) / rowH));
    return { pad, headerH, colHdrH, footerH, barcodeH, rowH, listTop, rowsPerPage };
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
    const qrBuf = await LabelsService.generateQrBuffer(header.qrCode, LabelsService._qrDots(P.qrPt));
    const bannerW = header.parentZone ? P.banner : 0;

    for (let pg = 0; pg < pageCount; pg++) {
      startNewPage();
      if (bannerW) LabelsService._verticalBanner(doc, header.parentZone, H, bannerW, P.bannerFont, P.bannerTrack);
      const cx = bannerW;

      // Header: QR + inverted title + breadcrumb + code, bottom-bordered.
      doc.image(qrBuf, cx + L.pad, L.pad, { width: P.qrPt });
      const hx = cx + L.pad + P.qrPt + 8, hw = W - hx - L.pad;
      // Centered, matching the medium tag's title treatment.
      LabelsService._invertedTitle(doc, header.name, hx, L.pad, hw, P.title, 'center');
      // Pure black, never grey: the head is 1-bit, so a grey fill is dithered
      // into stipple that reads as washed-out at these sizes. Bold + a size up
      // also survives thermal bleed better than a hairline face.
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#000000')
        .text(header.breadcrumb || '', hx, L.pad + 24, { width: hw, lineBreak: false, ellipsis: true });
      doc.fontSize(8).font('Courier-Bold').fillColor('#000000')
        .text(String(header.qrCode).toUpperCase(), hx, L.pad + 37, { width: hw, lineBreak: false });
      doc.save().moveTo(cx + L.pad, L.pad + L.headerH).lineTo(W - L.pad, L.pad + L.headerH)
        .lineWidth(1.5).strokeColor('#000000').stroke().restore();

      // Column header.
      doc.fontSize(8).font('Courier-Bold').fillColor('#000000')
        .text('CONTENTS', cx + L.pad, L.pad + L.headerH + 3, { width: 120, lineBreak: false });
      doc.text('QTY', W - L.pad - 34, L.pad + L.headerH + 3, { width: 34, align: 'right' });

      // Rows for this page.
      const start = pg * L.rowsPerPage, end = Math.min(start + L.rowsPerPage, rows.length);
      let ry = L.listTop;
      for (let r = start; r < end; r++) {
        // No zebra shading: a light grey cannot exist on a 1-bit head — it
        // dithers into stipple that stripes the list and fights the text.
        // Row rhythm comes from leading alone.
        // `height` is what actually clamps these to one line: pdfkit only wraps
        // when a `width` is given, and it only honours `ellipsis` once a
        // `height` bounds the box — `lineBreak: false` alone does not stop a
        // long name or a 5+ digit qty from spilling onto a second line and
        // overlapping the next row's shading.
        doc.fontSize(P.row).font('Helvetica').fillColor('#000000')
          .text(rows[r].name, cx + L.pad + 2, ry, { width: W - cx - L.pad * 2 - 38, height: P.row, lineBreak: false, ellipsis: true });
        doc.font('Courier').fillColor('#000000')
          .text(String(rows[r].qty), W - L.pad - 34, ry, { width: 30, height: P.row, align: 'right', lineBreak: false, ellipsis: true });
        ry += L.rowH;
      }

      // Code 128 of the TLY code, for laser scanners and faster in-app scanning
      // than framing a QR. Centred above the footer with its quiet zones intact.
      const bcY = H - L.pad - L.footerH - L.barcodeH + 4;
      const bcW = LabelsService._barcodeWidthPt(header.qrCode);
      const bcX = cx + (W - cx - bcW) / 2;
      LabelsService._drawBarcode(doc, header.qrCode, bcX, bcY, L.barcodeH - 12);
      doc.fontSize(7).font('Courier-Bold').fillColor('#000000')
        .text(String(header.qrCode).toUpperCase(), cx, bcY + L.barcodeH - 11,
          { width: W - cx, align: 'center', lineBreak: false });

      // Footer: total count + page x of n.
      const fy = H - L.pad - L.footerH + 5;
      doc.save().moveTo(cx + L.pad, fy - 5).lineTo(W - L.pad, fy - 5).lineWidth(1).strokeColor('#000000').stroke().restore();
      doc.fontSize(8).font('Courier-Bold').fillColor('#000000')
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

  // ── Code Resolution ─────────────────────────────────────────────────────────

  async resolveCode(code, userId) {
    const parsed = parseCode(code);
    if (!parsed) return { type: null, id: null, name: null, exists: false };

    const { type } = parsed;

    // Membership-scoped: a user may only resolve a code to an entity in a
    // property they belong to. An unknown OR unauthorized code returns
    // exists:false — it never leaks another household's entity name/id.
    const queries = {
      property:
        `SELECT p.ID, p.NAME FROM TALLY.properties p
         JOIN TALLY.property_members pm ON pm.PROPERTY_ID = p.ID AND pm.USER_ID = ?
         WHERE p.QR_CODE = ?`,
      area:
        `SELECT a.ID, a.NAME FROM TALLY.areas a
         JOIN TALLY.property_members pm ON pm.PROPERTY_ID = a.PROPERTY_ID AND pm.USER_ID = ?
         WHERE a.QR_CODE = ?`,
      container:
        `SELECT c.ID, c.NAME FROM TALLY.containers c
         JOIN TALLY.areas a ON c.AREA_ID = a.ID
         JOIN TALLY.property_members pm ON pm.PROPERTY_ID = a.PROPERTY_ID AND pm.USER_ID = ?
         WHERE c.QR_CODE = ?`,
      item:
        `SELECT i.ID, i.NAME FROM TALLY.items i
         JOIN TALLY.containers c ON i.CONTAINER_ID = c.ID
         JOIN TALLY.areas a ON c.AREA_ID = a.ID
         JOIN TALLY.property_members pm ON pm.PROPERTY_ID = a.PROPERTY_ID AND pm.USER_ID = ?
         WHERE i.QR_CODE = ?`,
    };

    const sql = queries[type];
    if (!sql) return { type, id: null, name: null, exists: false };

    const rows = await _db.query(sql, [userId, code]);

    if (rows.length > 0) {
      return { type, id: rows[0].ID, name: rows[0].NAME, exists: true };
    }

    return { type, id: null, name: null, exists: false };
  },

  // ── Entity Data Fetching ────────────────────────────────────────────────────

  async getEntityData(type, ids, userId) {
    if (!ids || ids.length === 0) return [];

    // Membership-scoped: every branch INNER-JOINs property_members so only
    // entities in a property the caller belongs to are returned. The route's
    // `entities.length === 0 → 404` then naturally hides out-of-scope IDs.
    // (Inner joins on the container→area→property chain are safe: a valid
    // item/container/area always has that chain via NOT NULL FKs.)
    const placeholders = ids.map(() => '?').join(', ');

    if (type === 'item') {
      const rows = await _db.query(
        `SELECT
           i.ID, i.NAME, i.QR_CODE,
           c.NAME AS CONTAINER_NAME,
           a.NAME AS AREA_NAME,
           p.NAME AS PROPERTY_NAME
         FROM TALLY.items i
         JOIN TALLY.containers c ON i.CONTAINER_ID = c.ID
         JOIN TALLY.areas a ON c.AREA_ID = a.ID
         JOIN TALLY.properties p ON a.PROPERTY_ID = p.ID
         JOIN TALLY.property_members pm ON pm.PROPERTY_ID = p.ID AND pm.USER_ID = ?
         WHERE i.ID IN (${placeholders}) AND i.DELETED_AT IS NULL`,
        [userId, ...ids]
      );
      return rows.map(row => ({
        id: row.ID, name: row.NAME, qrCode: row.QR_CODE, type: 'item',
        parentZone: null,
        breadcrumb: [row.PROPERTY_NAME, row.AREA_NAME, row.CONTAINER_NAME].filter(Boolean).join(' > '),
      }));
    }

    if (type === 'container') {
      const rows = await _db.query(
        `SELECT
           c.ID, c.NAME, c.QR_CODE,
           a.NAME AS AREA_NAME,
           p.NAME AS PROPERTY_NAME
         FROM TALLY.containers c
         JOIN TALLY.areas a ON c.AREA_ID = a.ID
         JOIN TALLY.properties p ON a.PROPERTY_ID = p.ID
         JOIN TALLY.property_members pm ON pm.PROPERTY_ID = p.ID AND pm.USER_ID = ?
         WHERE c.ID IN (${placeholders}) AND c.DELETED_AT IS NULL`,
        [userId, ...ids]
      );
      return rows.map(row => ({
        id: row.ID, name: row.NAME, qrCode: row.QR_CODE, type: 'container',
        parentZone: row.AREA_NAME || null,
        breadcrumb: row.PROPERTY_NAME || '',
      }));
    }

    if (type === 'area') {
      const rows = await _db.query(
        `SELECT
           a.ID, a.NAME, a.QR_CODE,
           p.NAME AS PROPERTY_NAME
         FROM TALLY.areas a
         JOIN TALLY.properties p ON a.PROPERTY_ID = p.ID
         JOIN TALLY.property_members pm ON pm.PROPERTY_ID = p.ID AND pm.USER_ID = ?
         WHERE a.ID IN (${placeholders}) AND a.DELETED_AT IS NULL`,
        [userId, ...ids]
      );
      return rows.map(row => ({
        id: row.ID, name: row.NAME, qrCode: row.QR_CODE, type: 'area',
        parentZone: row.PROPERTY_NAME || null,
        breadcrumb: '',
      }));
    }

    return [];
  },

  // ── PDF Label Generation ────────────────────────────────────────────────────

  // The thermal presets split an entity's location path in two: `parentZone`
  // is the zone printed in the rotated banner and `breadcrumb` is whatever sits
  // above it. The Avery sheet has no banner, so it recombines them back into
  // the single full path it printed before that split
  // (item → "Property > Area > Container", container → "Property > Area",
  // area → "Property").
  _fullLocation(entity) {
    return [entity.breadcrumb, entity.parentZone].filter(Boolean).join(' > ');
  },

  async generatePdf(entities, labelType) {
    // Label dimensions in points (1 inch = 72 points)
    const layouts = {
      asset:    { cols: 3, rows: 10, labelW: 189, labelH: 72,  qrSize: 56,  fs: { name: 9, code: 7, bc: 6 } },
      bin:      { cols: 2, rows: 4,  labelW: 270, labelH: 180, qrSize: 130, fs: { name: 16, code: 10, bc: 9 } },
      location: { cols: 2, rows: 4,  labelW: 270, labelH: 180, qrSize: 130, fs: { name: 16, code: 10, bc: 9 } },
    };

    const layout = layouts[labelType] || layouts.bin;
    const { cols, rows, labelW, labelH, qrSize, fs } = layout;
    const labelsPerPage = cols * rows;
    const pageW = 612;
    const pageH = 792;
    const marginX = (pageW - cols * labelW) / 2;
    const marginY = (pageH - rows * labelH) / 2;
    const pad = 10;

    const qrBuffers = await Promise.all(
      entities.map(e => LabelsService.generateQrBuffer(e.qrCode, qrSize * 2))
    );

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'LETTER', margin: 0 });
      const buffers = [];
      doc.on('data', buf => buffers.push(buf));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);

      for (let i = 0; i < entities.length; i++) {
        const entity = entities[i];
        const pageIndex = Math.floor(i / labelsPerPage);
        const posOnPage = i % labelsPerPage;

        if (posOnPage === 0 && pageIndex > 0) doc.addPage();

        const col = posOnPage % cols;
        const row = Math.floor(posOnPage / cols);
        const x = marginX + col * labelW;
        const y = marginY + row * labelH;

        const lx = x + 2;
        const ly = y + 2;
        const lw = labelW - 4;
        const lh = labelH - 4;
        const bandH = labelType === 'asset' ? 8 : 14;
        const stripeW = labelType === 'asset' ? 8 : 14;

        // ── Top white chevron band (above the black area) ──
        doc.save();
        for (let sx = -stripeW; sx < lw + stripeW; sx += stripeW * 2) {
          doc.moveTo(lx + sx, ly)
            .lineTo(lx + sx + stripeW, ly + bandH)
            .lineTo(lx + sx + stripeW * 2, ly)
            .closePath();
        }
        doc.clip().rect(lx, ly, lw, bandH).fill('#ffffff').restore();
        // Draw the V shapes on top
        doc.save().rect(lx, ly, lw, bandH).clip();
        for (let sx = -stripeW; sx < lw + stripeW * 2; sx += stripeW * 2) {
          doc.moveTo(lx + sx, ly)
            .lineTo(lx + sx + stripeW, ly + bandH)
            .lineTo(lx + sx + stripeW * 2, ly)
            .lineWidth(1.5).strokeColor('#cccccc').stroke();
        }
        doc.restore();

        // ── Black content area ──
        doc.save().rect(lx, ly + bandH, lw, lh - bandH * 2).fill('#1a1a1a').restore();

        // ── Bottom white chevron band (below the black area) ──
        const byy = ly + lh - bandH;
        doc.save();
        for (let sx = -stripeW; sx < lw + stripeW; sx += stripeW * 2) {
          doc.moveTo(lx + sx, byy + bandH)
            .lineTo(lx + sx + stripeW, byy)
            .lineTo(lx + sx + stripeW * 2, byy + bandH)
            .closePath();
        }
        doc.clip().rect(lx, byy, lw, bandH).fill('#ffffff').restore();
        doc.save().rect(lx, byy, lw, bandH).clip();
        for (let sx = -stripeW; sx < lw + stripeW * 2; sx += stripeW * 2) {
          doc.moveTo(lx + sx, byy + bandH)
            .lineTo(lx + sx + stripeW, byy)
            .lineTo(lx + sx + stripeW * 2, byy + bandH)
            .lineWidth(1.5).strokeColor('#cccccc').stroke();
        }
        doc.restore();

        // ── Outer border ──
        doc.save().rect(lx, ly, lw, lh).lineWidth(0.5).strokeColor('#999999').stroke().restore();

        // ── QR code with white pad ──
        const contentY = ly + bandH + 4;
        const contentH = lh - bandH * 2 - 8;
        const qrX = lx + pad;
        const qrActual = Math.min(qrSize, contentH);
        const qrY = contentY + (contentH - qrActual) / 2;
        doc.save().rect(qrX - 4, qrY - 4, qrActual + 8, qrActual + 8).fill('#ffffff').restore();
        doc.image(qrBuffers[i], qrX, qrY, { width: qrActual });

        // ── Text — white on black ──
        const textX = qrX + qrActual + pad;
        const textW = lw - qrActual - pad * 3;
        const textCenterY = contentY + contentH / 2;

        // Name
        const nameH = fs.name * (labelType === 'asset' ? 1.2 : 2.4);
        doc.fontSize(fs.name).font('Helvetica-Bold').fillColor('#ffffff')
          .text(entity.name.toUpperCase(), textX, textCenterY - nameH - 2, {
            width: textW, lineBreak: true, height: nameH, ellipsis: true,
          });

        // Code — monospace
        doc.fontSize(fs.code).font('Courier').fillColor('#aaaaaa')
          .text(entity.qrCode.toUpperCase(), textX, textCenterY + 4, {
            width: textW, lineBreak: false, ellipsis: true,
          });

        // Location — the full path, recombined from breadcrumb + parentZone.
        const loc = LabelsService._fullLocation(entity);
        if (loc) {
          doc.fontSize(fs.bc).font('Helvetica').fillColor('#888888')
            .text(loc.toUpperCase(), textX, textCenterY + 4 + fs.code * 1.8, {
              width: textW, lineBreak: false, ellipsis: true,
            });
        }

        doc.fillColor('#000000');
      }

      doc.end();
    });
  },
};

module.exports = LabelsService;

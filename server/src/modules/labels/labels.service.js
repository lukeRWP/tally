const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');
const { parseCode } = require('../../utils/qr');

// Geometry for the thermal single-label + manifest presets. 72 pt = 1 inch.
// `banner` is the left location-banner strip width in pt (0 = no banner).
const PRESETS = {
  small:  { widthPt: 144, heightPt: 72,  qrPt: 60,  banner: 0,  title: 11, code: 8 },
  medium: { widthPt: 216, heightPt: 216, qrPt: 118, banner: 26, title: 15, code: 10 },
  large:  { widthPt: 288, heightPt: 432, qrPt: 54,  banner: 22, title: 13, code: 8, row: 11, rowGap: 3 },
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

  async generateQrBuffer(code, size = 200) {
    const url = `${_baseUrl}/s/${code}`;
    return QRCode.toBuffer(url, { width: size, margin: 1 });
  },

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
        id: row.ID, name: row.NAME, qrCode: row.QR_CODE,
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
        id: row.ID, name: row.NAME, qrCode: row.QR_CODE,
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
        id: row.ID, name: row.NAME, qrCode: row.QR_CODE,
        parentZone: row.PROPERTY_NAME || null,
        breadcrumb: '',
      }));
    }

    return [];
  },

  // ── PDF Label Generation ────────────────────────────────────────────────────

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

        // Breadcrumb
        if (entity.breadcrumb) {
          doc.fontSize(fs.bc).font('Helvetica').fillColor('#888888')
            .text(entity.breadcrumb.toUpperCase(), textX, textCenterY + 4 + fs.code * 1.8, {
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

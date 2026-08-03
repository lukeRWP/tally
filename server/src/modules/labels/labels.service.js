const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');
const { parseCode } = require('../../utils/qr');

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
        id: row.ID,
        name: row.NAME,
        qrCode: row.QR_CODE,
        breadcrumb: [row.PROPERTY_NAME, row.AREA_NAME, row.CONTAINER_NAME]
          .filter(Boolean)
          .join(' > '),
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
        id: row.ID,
        name: row.NAME,
        qrCode: row.QR_CODE,
        breadcrumb: [row.PROPERTY_NAME, row.AREA_NAME]
          .filter(Boolean)
          .join(' > '),
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
        id: row.ID,
        name: row.NAME,
        qrCode: row.QR_CODE,
        breadcrumb: row.PROPERTY_NAME || '',
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

  // ── ZPL Thermal Printer Output ──────────────────────────────────────────────

  generateZpl(entities) {
    if (!Array.isArray(entities)) {
      entities = [entities];
    }

    // Sanitize text for ZPL: strip ^ and ~ which are ZPL command prefixes
    const zplSafe = (str) => String(str || '').replace(/[\^~]/g, '');

    return entities
      .map(entity => {
        return [
          '^XA',
          `^FO50,50^BQN,2,5^FDMA,${_baseUrl}/s/${entity.qrCode}^FS`,
          `^CF0,30^FO200,60^FD${zplSafe(entity.name)}^FS`,
          `^CF0,20^FO200,100^FD${zplSafe(entity.qrCode)}^FS`,
          '^XZ',
        ].join('\n');
      })
      .join('\n');
  },
};

module.exports = LabelsService;

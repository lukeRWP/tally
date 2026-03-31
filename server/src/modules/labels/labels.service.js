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

  async resolveCode(code) {
    const parsed = parseCode(code);
    if (!parsed) return { type: null, id: null, name: null, exists: false };

    const { type } = parsed;

    const tableMap = {
      property: 'TALLY.properties',
      area: 'TALLY.areas',
      container: 'TALLY.containers',
      item: 'TALLY.items',
    };

    const table = tableMap[type];
    if (!table) return { type, id: null, name: null, exists: false };

    const rows = await _db.query(
      `SELECT ID, NAME FROM ${table} WHERE QR_CODE = ?`,
      [code]
    );

    if (rows.length > 0) {
      return { type, id: rows[0].ID, name: rows[0].NAME, exists: true };
    }

    return { type, id: null, name: null, exists: false };
  },

  // ── Entity Data Fetching ────────────────────────────────────────────────────

  async getEntityData(type, ids) {
    if (!ids || ids.length === 0) return [];

    const placeholders = ids.map(() => '?').join(', ');

    if (type === 'item') {
      const rows = await _db.query(
        `SELECT
           i.ID, i.NAME, i.QR_CODE,
           c.NAME AS CONTAINER_NAME,
           a.NAME AS AREA_NAME,
           p.NAME AS PROPERTY_NAME
         FROM TALLY.items i
         LEFT JOIN TALLY.containers c ON i.CONTAINER_ID = c.ID
         LEFT JOIN TALLY.areas a ON c.AREA_ID = a.ID
         LEFT JOIN TALLY.properties p ON a.PROPERTY_ID = p.ID
         WHERE i.ID IN (${placeholders}) AND i.DELETED_AT IS NULL`,
        ids
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
         LEFT JOIN TALLY.areas a ON c.AREA_ID = a.ID
         LEFT JOIN TALLY.properties p ON a.PROPERTY_ID = p.ID
         WHERE c.ID IN (${placeholders}) AND c.DELETED_AT IS NULL`,
        ids
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
         LEFT JOIN TALLY.properties p ON a.PROPERTY_ID = p.ID
         WHERE a.ID IN (${placeholders}) AND a.DELETED_AT IS NULL`,
        ids
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

        // Black background with white text for high contrast
        doc.save()
          .rect(x + 2, y + 2, labelW - 4, labelH - 4)
          .fill('#1a1a1a');

        // White border
        doc.rect(x + 2, y + 2, labelW - 4, labelH - 4)
          .lineWidth(1).strokeColor('#333333').stroke()
          .restore();

        // QR code — white background behind QR for scanability
        const qrX = x + pad;
        const qrY = y + (labelH - qrSize) / 2;
        doc.save()
          .rect(qrX - 4, qrY - 4, qrSize + 8, qrSize + 8)
          .fill('#ffffff')
          .restore();
        doc.image(qrBuffers[i], qrX, qrY, { width: qrSize });

        // Text block — white on black
        const textX = x + pad + qrSize + pad;
        const textW = labelW - qrSize - pad * 3;
        const centerY = y + (labelH / 2);

        // Name — bold, white, uppercase
        const nameH = fs.name * (labelType === 'asset' ? 1.2 : 2.4);
        doc.fontSize(fs.name).font('Helvetica-Bold').fillColor('#ffffff')
          .text(entity.name.toUpperCase(), textX, centerY - nameH - 2, {
            width: textW, lineBreak: true, height: nameH, ellipsis: true,
          });

        // QR code string — monospace, light gray, uppercase
        doc.fontSize(fs.code).font('Courier').fillColor('#aaaaaa')
          .text(entity.qrCode.toUpperCase(), textX, centerY + 4, {
            width: textW, lineBreak: false, ellipsis: true,
          });

        // Breadcrumb — lighter, uppercase
        if (entity.breadcrumb) {
          doc.fontSize(fs.bc).font('Helvetica').fillColor('#888888')
            .text(entity.breadcrumb.toUpperCase(), textX, centerY + 4 + fs.code * 1.8, {
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

    return entities
      .map(entity => {
        return [
          '^XA',
          `^FO50,50^BQN,2,5^FDMA,${_baseUrl}/s/${entity.qrCode}^FS`,
          `^CF0,30^FO200,60^FD${entity.name}^FS`,
          `^CF0,20^FO200,100^FD${entity.qrCode}^FS`,
          '^XZ',
        ].join('\n');
      })
      .join('\n');
  },
};

module.exports = LabelsService;

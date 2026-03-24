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
    // Letter size: 612 x 792 points (8.5" x 11")
    const layouts = {
      asset: { cols: 3, rows: 10, labelW: 144, labelH: 72 },   // 2" x 1"
      bin: { cols: 2, rows: 5, labelW: 216, labelH: 144 },      // 3" x 2"
      location: { cols: 2, rows: 5, labelW: 216, labelH: 144 }, // 3" x 2"
    };

    const layout = layouts[labelType] || layouts.asset;
    const { cols, rows, labelW, labelH } = layout;
    const labelsPerPage = cols * rows;

    // Center the grid on the page
    const pageW = 612;
    const pageH = 792;
    const marginX = (pageW - cols * labelW) / 2;
    const marginY = (pageH - rows * labelH) / 2;

    // QR size relative to label height
    const qrSize = labelType === 'asset' ? 50 : 90;
    const qrPadding = 6;

    return new Promise(async (resolve, reject) => {
      try {
        const doc = new PDFDocument({ size: 'LETTER', margin: 0 });
        const buffers = [];
        doc.on('data', buf => buffers.push(buf));
        doc.on('end', () => resolve(Buffer.concat(buffers)));
        doc.on('error', reject);

        for (let i = 0; i < entities.length; i++) {
          const entity = entities[i];
          const pageIndex = Math.floor(i / labelsPerPage);
          const posOnPage = i % labelsPerPage;

          // Add new page if needed (not for the first entity)
          if (posOnPage === 0 && pageIndex > 0) {
            doc.addPage();
          }

          const col = posOnPage % cols;
          const row = Math.floor(posOnPage / cols);

          const x = marginX + col * labelW;
          const y = marginY + row * labelH;

          // Generate QR buffer for this entity
          const qrBuffer = await LabelsService.generateQrBuffer(entity.qrCode, qrSize * 2);

          // Draw QR code
          doc.image(qrBuffer, x + qrPadding, y + (labelH - qrSize) / 2, { width: qrSize });

          // Text area starts after QR code
          const textX = x + qrPadding + qrSize + 6;
          const textW = labelW - qrSize - qrPadding * 2 - 6;

          if (labelType === 'asset') {
            // Compact layout for small labels
            doc.fontSize(8).font('Helvetica-Bold')
              .text(entity.name, textX, y + 10, { width: textW, ellipsis: true, lineBreak: false });
            doc.fontSize(6).font('Helvetica')
              .text(entity.qrCode, textX, y + 22, { width: textW, ellipsis: true, lineBreak: false });
            if (entity.breadcrumb) {
              doc.fontSize(5).font('Helvetica')
                .text(entity.breadcrumb, textX, y + 32, { width: textW, ellipsis: true, lineBreak: false });
            }
          } else {
            // Larger layout for bin/location labels
            doc.fontSize(12).font('Helvetica-Bold')
              .text(entity.name, textX, y + 20, { width: textW, ellipsis: true, lineBreak: false });
            doc.fontSize(9).font('Helvetica')
              .text(entity.qrCode, textX, y + 40, { width: textW, ellipsis: true, lineBreak: false });
            if (entity.breadcrumb) {
              doc.fontSize(8).font('Helvetica')
                .text(entity.breadcrumb, textX, y + 56, { width: textW, ellipsis: true, lineBreak: false });
            }
          }
        }

        doc.end();
      } catch (err) {
        reject(err);
      }
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

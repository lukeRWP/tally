const PDFDocument = require('pdfkit');
const { createObjectCsvStringifier } = require('csv-writer');
const storage = require('../../infrastructure/storage');

let _db = null;
let _logger = null;
let _config = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

// Neutralize CSV/formula injection: a cell beginning with = + - @ tab or CR can be
// executed as a formula by Excel/Sheets. Prefix any such value with a single quote.
function _csvSafeValue(value) {
  if (typeof value !== 'string') return value;
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function _sanitizeCsvRecord(record) {
  const safe = {};
  for (const [key, val] of Object.entries(record)) safe[key] = _csvSafeValue(val);
  return safe;
}

function _calcDepreciatedValue(purchasePrice, depreciationRate, purchaseDate) {
  if (!purchasePrice || !depreciationRate) return purchasePrice || 0;
  const now = new Date();
  const purchased = new Date(purchaseDate);
  const years = (now - purchased) / (365.25 * 24 * 60 * 60 * 1000);
  if (years <= 0) return purchasePrice;
  return parseFloat((purchasePrice * Math.pow(1 - depreciationRate, years)).toFixed(2));
}

function _fmtCurrency(val) {
  if (val == null) return '-';
  return `$${Number(val).toFixed(2)}`;
}

function _fmtDate(d) {
  if (!d) return '-';
  return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

// ── Service ──────────────────────────────────────────────────────────────────

const ReportsService = {
  init({ db, logger, config }) {
    _db = db;
    _logger = logger;
    _config = config;
  },

  // ── Insurance Summary ────────────────────────────────────────────────────

  async insuranceSummary(propertyId) {
    const rows = await _db.query(
      `SELECT
         i.ID AS ITEM_ID,
         i.NAME AS ITEM_NAME,
         i.PURCHASE_PRICE,
         i.CURRENT_VALUE,
         i.DEPRECIATION_ENABLED,
         i.DEPRECIATION_RATE AS ITEM_DEPRECIATION_RATE,
         i.CONDITION,
         i.CREATED_AT AS ITEM_CREATED_AT,
         p.NAME AS PRODUCT_NAME,
         p.BRAND AS PRODUCT_BRAND,
         p.DEPRECIATION_RATE AS PRODUCT_DEPRECIATION_RATE,
         c.NAME AS CONTAINER_NAME,
         a.NAME AS AREA_NAME,
         cs_latest.PHOTO_KEY AS LATEST_PHOTO_KEY,
         cs_latest.CONDITION AS LATEST_CONDITION,
         id_purchase.DATE_VALUE AS PURCHASE_DATE
       FROM TALLY.items i
       JOIN TALLY.containers c ON c.ID = i.CONTAINER_ID
       JOIN TALLY.areas a ON a.ID = c.AREA_ID
       LEFT JOIN TALLY.products p ON p.ID = i.PRODUCT_ID
       LEFT JOIN (
         SELECT cs1.ITEM_ID, cs1.PHOTO_KEY, cs1.CONDITION
         FROM TALLY.condition_snapshots cs1
         INNER JOIN (
           SELECT ITEM_ID, MAX(CREATED_AT) AS MAX_CREATED
           FROM TALLY.condition_snapshots
           GROUP BY ITEM_ID
         ) cs2 ON cs1.ITEM_ID = cs2.ITEM_ID AND cs1.CREATED_AT = cs2.MAX_CREATED
       ) cs_latest ON cs_latest.ITEM_ID = i.ID
       LEFT JOIN TALLY.item_dates id_purchase ON id_purchase.ITEM_ID = i.ID AND id_purchase.DATE_TYPE = 'purchase'
       WHERE a.PROPERTY_ID = ?
         AND i.STATUS = 'active'
         AND i.DELETED_AT IS NULL
         AND c.DELETED_AT IS NULL
         AND a.DELETED_AT IS NULL
       ORDER BY a.NAME, c.NAME, i.NAME`,
      [propertyId]
    );

    const items = [];
    for (const row of rows) {
      const depRate = row.ITEM_DEPRECIATION_RATE || row.PRODUCT_DEPRECIATION_RATE || 0;
      const purchaseDate = row.PURCHASE_DATE || row.ITEM_CREATED_AT;
      const purchasePrice = row.PURCHASE_PRICE ? parseFloat(row.PURCHASE_PRICE) : null;

      let currentValue = purchasePrice;
      if (row.DEPRECIATION_ENABLED && purchasePrice && depRate) {
        currentValue = _calcDepreciatedValue(purchasePrice, parseFloat(depRate), purchaseDate);
      } else if (row.CURRENT_VALUE != null) {
        currentValue = parseFloat(row.CURRENT_VALUE);
      }

      // (Removed a per-item presigned-URL call here — neither the PDF nor the
      // CSV output ever read the resulting photoUrl, so it was pure dead work:
      // one sequential S3 sign per row on every insurance report.)

      items.push({
        itemId: row.ITEM_ID,
        itemName: row.ITEM_NAME,
        productName: row.PRODUCT_NAME || null,
        brand: row.PRODUCT_BRAND || null,
        purchasePrice,
        currentValue,
        condition: row.LATEST_CONDITION || row.CONDITION || null,
        areaName: row.AREA_NAME,
        containerName: row.CONTAINER_NAME,
      });
    }

    return items;
  },

  // ── Total Value ──────────────────────────────────────────────────────────

  async totalValue(propertyId, { groupBy = 'property' } = {}) {
    let sql;
    const params = [propertyId];

    if (groupBy === 'area') {
      sql = `SELECT
               a.NAME AS GROUP_NAME,
               i.PURCHASE_PRICE,
               i.CURRENT_VALUE,
               i.DEPRECIATION_ENABLED,
               i.DEPRECIATION_RATE AS ITEM_DEP_RATE,
               p.DEPRECIATION_RATE AS PRODUCT_DEP_RATE,
               i.CREATED_AT AS ITEM_CREATED_AT,
               id_purchase.DATE_VALUE AS PURCHASE_DATE
             FROM TALLY.items i
             JOIN TALLY.containers c ON c.ID = i.CONTAINER_ID
             JOIN TALLY.areas a ON a.ID = c.AREA_ID
             LEFT JOIN TALLY.products p ON p.ID = i.PRODUCT_ID
             LEFT JOIN TALLY.item_dates id_purchase ON id_purchase.ITEM_ID = i.ID AND id_purchase.DATE_TYPE = 'purchase'
             WHERE a.PROPERTY_ID = ?
               AND i.STATUS = 'active'
               AND i.DELETED_AT IS NULL
               AND c.DELETED_AT IS NULL
               AND a.DELETED_AT IS NULL`;
    } else if (groupBy === 'tag') {
      sql = `SELECT
               t.NAME AS GROUP_NAME,
               i.PURCHASE_PRICE,
               i.CURRENT_VALUE,
               i.DEPRECIATION_ENABLED,
               i.DEPRECIATION_RATE AS ITEM_DEP_RATE,
               p.DEPRECIATION_RATE AS PRODUCT_DEP_RATE,
               i.CREATED_AT AS ITEM_CREATED_AT,
               id_purchase.DATE_VALUE AS PURCHASE_DATE
             FROM TALLY.items i
             JOIN TALLY.containers c ON c.ID = i.CONTAINER_ID
             JOIN TALLY.areas a ON a.ID = c.AREA_ID
             LEFT JOIN TALLY.products p ON p.ID = i.PRODUCT_ID
             LEFT JOIN TALLY.item_dates id_purchase ON id_purchase.ITEM_ID = i.ID AND id_purchase.DATE_TYPE = 'purchase'
             JOIN TALLY.entity_tags et ON et.ENTITY_ID = i.ID AND et.ENTITY_TYPE = 'item'
             JOIN TALLY.tags t ON t.ID = et.TAG_ID
             WHERE a.PROPERTY_ID = ?
               AND i.STATUS = 'active'
               AND i.DELETED_AT IS NULL
               AND c.DELETED_AT IS NULL
               AND a.DELETED_AT IS NULL`;
    } else {
      // groupBy === 'property' (single total)
      sql = `SELECT
               'Total' AS GROUP_NAME,
               i.PURCHASE_PRICE,
               i.CURRENT_VALUE,
               i.DEPRECIATION_ENABLED,
               i.DEPRECIATION_RATE AS ITEM_DEP_RATE,
               p.DEPRECIATION_RATE AS PRODUCT_DEP_RATE,
               i.CREATED_AT AS ITEM_CREATED_AT,
               id_purchase.DATE_VALUE AS PURCHASE_DATE
             FROM TALLY.items i
             JOIN TALLY.containers c ON c.ID = i.CONTAINER_ID
             JOIN TALLY.areas a ON a.ID = c.AREA_ID
             LEFT JOIN TALLY.products p ON p.ID = i.PRODUCT_ID
             LEFT JOIN TALLY.item_dates id_purchase ON id_purchase.ITEM_ID = i.ID AND id_purchase.DATE_TYPE = 'purchase'
             WHERE a.PROPERTY_ID = ?
               AND i.STATUS = 'active'
               AND i.DELETED_AT IS NULL
               AND c.DELETED_AT IS NULL
               AND a.DELETED_AT IS NULL`;
    }

    const rows = await _db.query(sql, params);

    // Aggregate in JS to compute depreciated values
    const groups = {};
    for (const row of rows) {
      const group = row.GROUP_NAME || 'Untagged';
      if (!groups[group]) {
        groups[group] = { group, purchaseTotal: 0, currentTotal: 0, itemCount: 0 };
      }

      const purchasePrice = row.PURCHASE_PRICE ? parseFloat(row.PURCHASE_PRICE) : 0;
      groups[group].purchaseTotal += purchasePrice;
      groups[group].itemCount += 1;

      if (row.DEPRECIATION_ENABLED && purchasePrice) {
        const depRate = parseFloat(row.ITEM_DEP_RATE || row.PRODUCT_DEP_RATE || 0);
        const purchaseDate = row.PURCHASE_DATE || row.ITEM_CREATED_AT;
        groups[group].currentTotal += _calcDepreciatedValue(purchasePrice, depRate, purchaseDate);
      } else if (row.CURRENT_VALUE != null) {
        groups[group].currentTotal += parseFloat(row.CURRENT_VALUE);
      } else {
        groups[group].currentTotal += purchasePrice;
      }
    }

    return Object.values(groups).map(g => ({
      group: g.group,
      purchaseTotal: parseFloat(g.purchaseTotal.toFixed(2)),
      currentTotal: parseFloat(g.currentTotal.toFixed(2)),
      itemCount: g.itemCount,
    }));
  },

  // ── Items by Location ────────────────────────────────────────────────────

  async itemsByLocation(propertyId) {
    // Get areas
    const areas = await _db.query(
      `SELECT ID, NAME
       FROM TALLY.areas
       WHERE PROPERTY_ID = ? AND DELETED_AT IS NULL
       ORDER BY NAME`,
      [propertyId]
    );

    const result = [];

    for (const area of areas) {
      // Get top-level containers for this area (no parent)
      const topContainers = await _db.query(
        `SELECT ID, NAME, PARENT_CONTAINER_ID
         FROM TALLY.containers
         WHERE AREA_ID = ? AND PARENT_CONTAINER_ID IS NULL AND DELETED_AT IS NULL
         ORDER BY NAME`,
        [area.ID]
      );

      const containerTree = [];
      for (const tc of topContainers) {
        containerTree.push(await ReportsService._buildContainerTree(tc, area.ID));
      }

      result.push({
        areaId: area.ID,
        areaName: area.NAME,
        containers: containerTree,
      });
    }

    return result;
  },

  async _buildContainerTree(container, areaId) {
    // Get items in this container
    const items = await _db.query(
      `SELECT ID, NAME, PURCHASE_PRICE, CONDITION, STATUS
       FROM TALLY.items
       WHERE CONTAINER_ID = ? AND DELETED_AT IS NULL
       ORDER BY NAME`,
      [container.ID]
    );

    // Get child containers
    const children = await _db.query(
      `SELECT ID, NAME, PARENT_CONTAINER_ID
       FROM TALLY.containers
       WHERE PARENT_CONTAINER_ID = ? AND AREA_ID = ? AND DELETED_AT IS NULL
       ORDER BY NAME`,
      [container.ID, areaId]
    );

    const childTrees = [];
    for (const child of children) {
      childTrees.push(await ReportsService._buildContainerTree(child, areaId));
    }

    return {
      containerId: container.ID,
      containerName: container.NAME,
      items: items.map(i => ({
        itemId: i.ID,
        itemName: i.NAME,
        purchasePrice: i.PURCHASE_PRICE ? parseFloat(i.PURCHASE_PRICE) : null,
        condition: i.CONDITION || null,
        status: i.STATUS,
      })),
      children: childTrees,
    };
  },

  // ── Lending Report ───────────────────────────────────────────────────────

  async lendingReport(propertyId) {
    const rows = await _db.query(
      `SELECT
         il.ID AS LENDING_ID,
         il.LENT_TO,
         il.LENT_AT,
         il.DUE_AT,
         il.NOTES,
         i.ID AS ITEM_ID,
         i.NAME AS ITEM_NAME,
         c.NAME AS CONTAINER_NAME,
         a.NAME AS AREA_NAME
       FROM TALLY.item_lending il
       JOIN TALLY.items i ON i.ID = il.ITEM_ID
       JOIN TALLY.containers c ON c.ID = i.CONTAINER_ID
       JOIN TALLY.areas a ON a.ID = c.AREA_ID
       WHERE a.PROPERTY_ID = ?
         AND il.RETURNED_AT IS NULL
         AND i.DELETED_AT IS NULL
       ORDER BY il.LENT_AT DESC`,
      [propertyId]
    );

    const now = new Date();
    return rows.map(row => ({
      lendingId: row.LENDING_ID,
      itemId: row.ITEM_ID,
      itemName: row.ITEM_NAME,
      containerName: row.CONTAINER_NAME,
      areaName: row.AREA_NAME,
      lentTo: row.LENT_TO,
      lentAt: row.LENT_AT,
      dueAt: row.DUE_AT || null,
      notes: row.NOTES || null,
      overdue: row.DUE_AT ? new Date(row.DUE_AT) < now : false,
    }));
  },

  // ── Activity Log ─────────────────────────────────────────────────────────

  async activityLog(propertyId, { limit = 500, offset = 0, startDate, endDate } = {}) {
    const where = ['cl.PROPERTY_ID = ?'];
    const params = [propertyId];

    if (startDate) {
      where.push('cl.CREATED_AT >= ?');
      params.push(startDate);
    }
    if (endDate) {
      where.push('cl.CREATED_AT <= ?');
      params.push(endDate);
    }

    params.push(limit, offset);

    const rows = await _db.query(
      `SELECT cl.*, u.DISPLAY_NAME
       FROM TALLY.change_log cl
       JOIN TALLY.users u ON cl.USER_ID = u.ID
       WHERE ${where.join(' AND ')}
       ORDER BY cl.CREATED_AT DESC
       LIMIT ? OFFSET ?`,
      params
    );

    return rows.map(row => {
      let changes = row.CHANGES;
      if (typeof changes === 'string') {
        try { changes = JSON.parse(changes); } catch { changes = {}; }
      }
      return {
        id: row.ID,
        userId: row.USER_ID,
        displayName: row.DISPLAY_NAME || null,
        entityType: row.ENTITY_TYPE,
        entityId: row.ENTITY_ID,
        action: row.ACTION,
        changes,
        createdAt: row.CREATED_AT,
      };
    });
  },

  // ── Tag Report ───────────────────────────────────────────────────────────

  async tagReport(propertyId, tagIds) {
    if (!tagIds || tagIds.length === 0) {
      // Return all tagged items grouped by tag
      const rows = await _db.query(
        `SELECT
           t.ID AS TAG_ID,
           t.NAME AS TAG_NAME,
           t.COLOR AS TAG_COLOR,
           i.ID AS ITEM_ID,
           i.NAME AS ITEM_NAME,
           i.PURCHASE_PRICE,
           i.CONDITION,
           c.NAME AS CONTAINER_NAME,
           a.NAME AS AREA_NAME
         FROM TALLY.tags t
         JOIN TALLY.entity_tags et ON et.TAG_ID = t.ID AND et.ENTITY_TYPE = 'item'
         JOIN TALLY.items i ON i.ID = et.ENTITY_ID
         JOIN TALLY.containers c ON c.ID = i.CONTAINER_ID
         JOIN TALLY.areas a ON a.ID = c.AREA_ID
         WHERE t.PROPERTY_ID = ?
           AND i.DELETED_AT IS NULL
           AND c.DELETED_AT IS NULL
           AND a.DELETED_AT IS NULL
         ORDER BY t.NAME, i.NAME`,
        [propertyId]
      );

      return ReportsService._groupByTag(rows);
    }

    const placeholders = tagIds.map(() => '?').join(', ');
    const rows = await _db.query(
      `SELECT
         t.ID AS TAG_ID,
         t.NAME AS TAG_NAME,
         t.COLOR AS TAG_COLOR,
         i.ID AS ITEM_ID,
         i.NAME AS ITEM_NAME,
         i.PURCHASE_PRICE,
         i.CONDITION,
         c.NAME AS CONTAINER_NAME,
         a.NAME AS AREA_NAME
       FROM TALLY.tags t
       JOIN TALLY.entity_tags et ON et.TAG_ID = t.ID AND et.ENTITY_TYPE = 'item'
       JOIN TALLY.items i ON i.ID = et.ENTITY_ID
       JOIN TALLY.containers c ON c.ID = i.CONTAINER_ID
       JOIN TALLY.areas a ON a.ID = c.AREA_ID
       WHERE t.PROPERTY_ID = ?
         AND t.ID IN (${placeholders})
         AND i.DELETED_AT IS NULL
         AND c.DELETED_AT IS NULL
         AND a.DELETED_AT IS NULL
       ORDER BY t.NAME, i.NAME`,
      [propertyId, ...tagIds]
    );

    return ReportsService._groupByTag(rows);
  },

  _groupByTag(rows) {
    const tagMap = {};
    for (const row of rows) {
      if (!tagMap[row.TAG_ID]) {
        tagMap[row.TAG_ID] = {
          tagId: row.TAG_ID,
          tagName: row.TAG_NAME,
          tagColor: row.TAG_COLOR,
          items: [],
        };
      }
      tagMap[row.TAG_ID].items.push({
        itemId: row.ITEM_ID,
        itemName: row.ITEM_NAME,
        purchasePrice: row.PURCHASE_PRICE ? parseFloat(row.PURCHASE_PRICE) : null,
        condition: row.CONDITION || null,
        containerName: row.CONTAINER_NAME,
        areaName: row.AREA_NAME,
      });
    }
    return Object.values(tagMap);
  },

  // ── Data Dispatcher ───────────────────────────────────────────────────────

  async _fetchReportData(reportType, propertyId, opts = {}) {
    switch (reportType) {
      case 'insurance':
        return ReportsService.insuranceSummary(propertyId);
      case 'total_value':
        return ReportsService.totalValue(propertyId, { groupBy: opts.groupBy });
      case 'items_by_location':
        return ReportsService.itemsByLocation(propertyId);
      case 'lending':
        return ReportsService.lendingReport(propertyId);
      case 'activity_log':
        return ReportsService.activityLog(propertyId, {
          limit: opts.limit,
          offset: opts.offset,
          startDate: opts.startDate,
          endDate: opts.endDate,
        });
      case 'tag':
        return ReportsService.tagReport(propertyId, opts.tagIds);
      default:
        throw new Error(`Unknown report type: ${reportType}`);
    }
  },

  // ── PDF Generation ───────────────────────────────────────────────────────

  async generatePdf(reportType, data) {
    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
        const buffers = [];
        doc.on('data', buf => buffers.push(buf));
        doc.on('end', () => resolve(Buffer.concat(buffers)));
        doc.on('error', reject);

        const reportNames = {
          insurance: 'Insurance Summary',
          total_value: 'Total Value',
          items_by_location: 'Items by Location',
          lending: 'Lending',
          activity_log: 'Activity Log',
          tag: 'Tag Report',
        };

        // Title
        doc.fontSize(20).font('Helvetica-Bold')
          .text(`Tally — ${reportNames[reportType] || 'Report'}`, { align: 'center' });
        doc.fontSize(10).font('Helvetica')
          .text(_fmtDate(new Date()), { align: 'center' });
        doc.moveDown(1.5);

        switch (reportType) {
          case 'insurance':
            ReportsService._renderInsurancePdf(doc, data);
            break;
          case 'total_value':
            ReportsService._renderTotalValuePdf(doc, data);
            break;
          case 'items_by_location':
            ReportsService._renderLocationPdf(doc, data);
            break;
          case 'lending':
            ReportsService._renderLendingPdf(doc, data);
            break;
          case 'activity_log':
            ReportsService._renderActivityPdf(doc, data);
            break;
          case 'tag':
            ReportsService._renderTagPdf(doc, data);
            break;
          default:
            doc.text('Unknown report type.');
        }

        doc.end();
      } catch (err) {
        reject(err);
      }
    });
  },

  _renderInsurancePdf(doc, items) {
    // Column headers
    const cols = [
      { label: 'Item', x: 50, w: 130 },
      { label: 'Brand', x: 180, w: 80 },
      { label: 'Purchase Price', x: 260, w: 85 },
      { label: 'Current Value', x: 345, w: 85 },
      { label: 'Condition', x: 430, w: 70 },
      { label: 'Location', x: 500, w: 70 },
    ];

    doc.fontSize(8).font('Helvetica-Bold');
    for (const col of cols) {
      doc.text(col.label, col.x, doc.y, { width: col.w, continued: false });
    }

    // Reset y to after header row
    const headerY = doc.y;
    doc.moveTo(50, headerY).lineTo(562, headerY).stroke();
    doc.moveDown(0.3);

    doc.font('Helvetica').fontSize(7);
    for (const item of items) {
      if (doc.y > 720) {
        doc.addPage();
        doc.y = 50;
      }
      const rowY = doc.y;
      doc.text(item.itemName || '-', cols[0].x, rowY, { width: cols[0].w, lineBreak: false, ellipsis: true });
      doc.text(item.brand || '-', cols[1].x, rowY, { width: cols[1].w, lineBreak: false, ellipsis: true });
      doc.text(_fmtCurrency(item.purchasePrice), cols[2].x, rowY, { width: cols[2].w, lineBreak: false });
      doc.text(_fmtCurrency(item.currentValue), cols[3].x, rowY, { width: cols[3].w, lineBreak: false });
      doc.text(item.condition || '-', cols[4].x, rowY, { width: cols[4].w, lineBreak: false });
      doc.text(`${item.areaName || ''} > ${item.containerName || ''}`, cols[5].x, rowY, { width: cols[5].w, lineBreak: false, ellipsis: true });
      doc.moveDown(0.5);
    }

    // Summary
    doc.moveDown(1);
    const totalPurchase = items.reduce((s, i) => s + (i.purchasePrice || 0), 0);
    const totalCurrent = items.reduce((s, i) => s + (i.currentValue || 0), 0);
    doc.font('Helvetica-Bold').fontSize(9);
    doc.text(`Total Items: ${items.length}    |    Purchase Total: ${_fmtCurrency(totalPurchase)}    |    Current Total: ${_fmtCurrency(totalCurrent)}`);
  },

  _renderTotalValuePdf(doc, groups) {
    const cols = [
      { label: 'Group', x: 50, w: 200 },
      { label: 'Items', x: 250, w: 60 },
      { label: 'Purchase Total', x: 310, w: 110 },
      { label: 'Current Total', x: 420, w: 110 },
    ];

    doc.fontSize(9).font('Helvetica-Bold');
    const headerY = doc.y;
    for (const col of cols) {
      doc.text(col.label, col.x, headerY, { width: col.w, continued: false });
    }
    doc.moveTo(50, doc.y).lineTo(562, doc.y).stroke();
    doc.moveDown(0.3);

    doc.font('Helvetica').fontSize(8);
    for (const g of groups) {
      const rowY = doc.y;
      doc.text(g.group, cols[0].x, rowY, { width: cols[0].w, lineBreak: false, ellipsis: true });
      doc.text(String(g.itemCount), cols[1].x, rowY, { width: cols[1].w, lineBreak: false });
      doc.text(_fmtCurrency(g.purchaseTotal), cols[2].x, rowY, { width: cols[2].w, lineBreak: false });
      doc.text(_fmtCurrency(g.currentTotal), cols[3].x, rowY, { width: cols[3].w, lineBreak: false });
      doc.moveDown(0.5);
    }
  },

  _renderLocationPdf(doc, areas) {
    doc.fontSize(9).font('Helvetica');

    for (const area of areas) {
      if (doc.y > 700) doc.addPage();

      doc.font('Helvetica-Bold').fontSize(12)
        .text(area.areaName, 50);
      doc.moveDown(0.3);

      for (const container of area.containers) {
        ReportsService._renderContainerPdf(doc, container, 1);
      }
      doc.moveDown(0.5);
    }
  },

  _renderContainerPdf(doc, container, depth) {
    if (doc.y > 720) doc.addPage();

    const indent = 50 + depth * 20;
    doc.font('Helvetica-Bold').fontSize(10)
      .text(`${container.containerName}`, indent);
    doc.moveDown(0.2);

    doc.font('Helvetica').fontSize(8);
    for (const item of container.items) {
      if (doc.y > 730) doc.addPage();
      doc.text(`- ${item.itemName}${item.purchasePrice ? '  (' + _fmtCurrency(item.purchasePrice) + ')' : ''}`, indent + 15);
    }

    for (const child of container.children) {
      ReportsService._renderContainerPdf(doc, child, depth + 1);
    }
  },

  _renderLendingPdf(doc, loans) {
    const cols = [
      { label: 'Item', x: 50, w: 120 },
      { label: 'Lent To', x: 170, w: 100 },
      { label: 'Date', x: 270, w: 80 },
      { label: 'Due', x: 350, w: 80 },
      { label: 'Overdue?', x: 430, w: 60 },
      { label: 'Location', x: 490, w: 72 },
    ];

    doc.fontSize(9).font('Helvetica-Bold');
    const headerY = doc.y;
    for (const col of cols) {
      doc.text(col.label, col.x, headerY, { width: col.w, continued: false });
    }
    doc.moveTo(50, doc.y).lineTo(562, doc.y).stroke();
    doc.moveDown(0.3);

    doc.font('Helvetica').fontSize(7);
    for (const loan of loans) {
      if (doc.y > 720) doc.addPage();
      const rowY = doc.y;
      doc.text(loan.itemName || '-', cols[0].x, rowY, { width: cols[0].w, lineBreak: false, ellipsis: true });
      doc.text(loan.lentTo || '-', cols[1].x, rowY, { width: cols[1].w, lineBreak: false, ellipsis: true });
      doc.text(_fmtDate(loan.lentAt), cols[2].x, rowY, { width: cols[2].w, lineBreak: false });
      doc.text(loan.dueAt ? _fmtDate(loan.dueAt) : '-', cols[3].x, rowY, { width: cols[3].w, lineBreak: false });
      doc.text(loan.overdue ? 'YES' : 'No', cols[4].x, rowY, { width: cols[4].w, lineBreak: false });
      doc.text(`${loan.areaName || ''} > ${loan.containerName || ''}`, cols[5].x, rowY, { width: cols[5].w, lineBreak: false, ellipsis: true });
      doc.moveDown(0.5);
    }

    if (loans.length === 0) {
      doc.text('No items currently lent out.', 50);
    }
  },

  _renderActivityPdf(doc, entries) {
    const cols = [
      { label: 'Date', x: 50, w: 100 },
      { label: 'User', x: 150, w: 110 },
      { label: 'Action', x: 260, w: 70 },
      { label: 'Entity Type', x: 330, w: 80 },
      { label: 'Entity ID', x: 410, w: 60 },
    ];

    doc.fontSize(9).font('Helvetica-Bold');
    const headerY = doc.y;
    for (const col of cols) {
      doc.text(col.label, col.x, headerY, { width: col.w, continued: false });
    }
    doc.moveTo(50, doc.y).lineTo(562, doc.y).stroke();
    doc.moveDown(0.3);

    doc.font('Helvetica').fontSize(7);
    for (const entry of entries) {
      if (doc.y > 720) doc.addPage();
      const rowY = doc.y;
      doc.text(_fmtDate(entry.createdAt), cols[0].x, rowY, { width: cols[0].w, lineBreak: false });
      doc.text(entry.displayName || '-', cols[1].x, rowY, { width: cols[1].w, lineBreak: false, ellipsis: true });
      doc.text(entry.action || '-', cols[2].x, rowY, { width: cols[2].w, lineBreak: false });
      doc.text(entry.entityType || '-', cols[3].x, rowY, { width: cols[3].w, lineBreak: false });
      doc.text(String(entry.entityId || '-'), cols[4].x, rowY, { width: cols[4].w, lineBreak: false });
      doc.moveDown(0.5);
    }
  },

  _renderTagPdf(doc, tagGroups) {
    for (const group of tagGroups) {
      if (doc.y > 700) doc.addPage();

      doc.font('Helvetica-Bold').fontSize(12)
        .text(`Tag: ${group.tagName}`, 50);
      doc.moveDown(0.3);

      doc.font('Helvetica').fontSize(8);
      for (const item of group.items) {
        if (doc.y > 730) doc.addPage();
        const price = item.purchasePrice ? `  (${_fmtCurrency(item.purchasePrice)})` : '';
        doc.text(`- ${item.itemName}${price}  |  ${item.areaName} > ${item.containerName}`, 70);
      }
      doc.moveDown(0.8);
    }

    if (tagGroups.length === 0) {
      doc.text('No tagged items found.', 50);
    }
  },

  // ── CSV Generation ───────────────────────────────────────────────────────

  generateCsv(reportType, data) {
    let stringifier;
    let records;

    switch (reportType) {
      case 'insurance':
        stringifier = createObjectCsvStringifier({
          header: [
            { id: 'itemName', title: 'Item' },
            { id: 'brand', title: 'Brand' },
            { id: 'productName', title: 'Product' },
            { id: 'purchasePrice', title: 'Purchase Price' },
            { id: 'currentValue', title: 'Current Value' },
            { id: 'condition', title: 'Condition' },
            { id: 'areaName', title: 'Area' },
            { id: 'containerName', title: 'Container' },
          ],
        });
        records = data.map(i => ({
          ...i,
          purchasePrice: i.purchasePrice != null ? i.purchasePrice : '',
          currentValue: i.currentValue != null ? i.currentValue : '',
          condition: i.condition || '',
          brand: i.brand || '',
          productName: i.productName || '',
        }));
        break;

      case 'total_value':
        stringifier = createObjectCsvStringifier({
          header: [
            { id: 'group', title: 'Group' },
            { id: 'itemCount', title: 'Item Count' },
            { id: 'purchaseTotal', title: 'Purchase Total' },
            { id: 'currentTotal', title: 'Current Total' },
          ],
        });
        records = data;
        break;

      case 'items_by_location':
        stringifier = createObjectCsvStringifier({
          header: [
            { id: 'area', title: 'Area' },
            { id: 'container', title: 'Container' },
            { id: 'itemName', title: 'Item' },
            { id: 'purchasePrice', title: 'Purchase Price' },
            { id: 'condition', title: 'Condition' },
            { id: 'status', title: 'Status' },
          ],
        });
        records = [];
        for (const area of data) {
          ReportsService._flattenContainersCsv(records, area.areaName, area.containers, '');
        }
        break;

      case 'lending':
        stringifier = createObjectCsvStringifier({
          header: [
            { id: 'itemName', title: 'Item' },
            { id: 'lentTo', title: 'Lent To' },
            { id: 'lentAt', title: 'Lent Date' },
            { id: 'dueAt', title: 'Due Date' },
            { id: 'overdue', title: 'Overdue' },
            { id: 'areaName', title: 'Area' },
            { id: 'containerName', title: 'Container' },
          ],
        });
        records = data.map(l => ({
          ...l,
          lentAt: l.lentAt ? _fmtDate(l.lentAt) : '',
          dueAt: l.dueAt ? _fmtDate(l.dueAt) : '',
          overdue: l.overdue ? 'Yes' : 'No',
        }));
        break;

      case 'activity_log':
        stringifier = createObjectCsvStringifier({
          header: [
            { id: 'createdAt', title: 'Date' },
            { id: 'displayName', title: 'User' },
            { id: 'action', title: 'Action' },
            { id: 'entityType', title: 'Entity Type' },
            { id: 'entityId', title: 'Entity ID' },
          ],
        });
        records = data.map(e => ({
          ...e,
          createdAt: e.createdAt ? _fmtDate(e.createdAt) : '',
          displayName: e.displayName || '',
        }));
        break;

      case 'tag':
        stringifier = createObjectCsvStringifier({
          header: [
            { id: 'tagName', title: 'Tag' },
            { id: 'itemName', title: 'Item' },
            { id: 'purchasePrice', title: 'Purchase Price' },
            { id: 'condition', title: 'Condition' },
            { id: 'areaName', title: 'Area' },
            { id: 'containerName', title: 'Container' },
          ],
        });
        records = [];
        for (const group of data) {
          for (const item of group.items) {
            records.push({
              tagName: group.tagName,
              itemName: item.itemName,
              purchasePrice: item.purchasePrice != null ? item.purchasePrice : '',
              condition: item.condition || '',
              areaName: item.areaName,
              containerName: item.containerName,
            });
          }
        }
        break;

      default:
        return '';
    }

    const safeRecords = records.map(_sanitizeCsvRecord);
    return stringifier.getHeaderString() + stringifier.stringifyRecords(safeRecords);
  },

  _flattenContainersCsv(records, areaName, containers, parentPath) {
    for (const container of containers) {
      const path = parentPath ? `${parentPath} > ${container.containerName}` : container.containerName;
      for (const item of container.items) {
        records.push({
          area: areaName,
          container: path,
          itemName: item.itemName,
          purchasePrice: item.purchasePrice != null ? item.purchasePrice : '',
          condition: item.condition || '',
          status: item.status || '',
        });
      }
      if (container.children && container.children.length > 0) {
        ReportsService._flattenContainersCsv(records, areaName, container.children, path);
      }
    }
  },
};

module.exports = ReportsService;

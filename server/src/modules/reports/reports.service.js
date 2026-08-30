const PDFDocument = require('pdfkit');
const { createObjectCsvStringifier } = require('csv-writer');
const { collectPdf } = require('../../utils/pdf');
const storage = require('../../infrastructure/storage');

let _db = null;
let _logger = null;
let _config = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

// Suffix printed after a value in the insurance PDF to show where it came from.
// 'declared' is deliberately unmarked: it is the expected case, and marking the
// norm would bury the exceptions. Indexed by valueBasis, including null (an item
// with no price at all), so a missing key can never print "undefined".
const BASIS_MARK = Object.freeze({
  declared: '',
  estimated: ' e',
  depreciated: ' d',
  purchase: ' p',
  null: '',
});

// What prints in the Current Value column when the thing itself is not here.
const PARTIAL_LABEL = Object.freeze({
  box_only: '— box only',
  accessories_only: '— spares only',
});

// Imported rather than re-listed: the enum lives with the Joi schema that
// validates it, so a value added there cannot be silently counted here.
const { PARTIAL } = require('../inventory/items.schema');
const _isPartial = (item) => PARTIAL.includes(item.completeness);

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

/** Money, to the cent — every total in a report is accumulated then rounded once. */
function _round2(n) {
  return parseFloat(n.toFixed(2));
}

function _fmtCurrency(val) {
  if (val == null) return '—';
  // Grouped, because these are read as money on a claim form: "$22,590.00" is
  // a number you can check at a glance and "$22590.00" is one you have to count
  // digits on. PDF-only — every CSV column emits the raw number, so a
  // spreadsheet still gets something it can sum.
  return `$${Number(val).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function _fmtDate(d) {
  if (!d) return '-';
  return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * The total-value payload as the renderers want it: `{ groups, totals,
 * overlapping }`.
 *
 * `totalValue()` returns exactly that. A bare array of groups is still accepted
 * — it is what the shape was before #310, and an empty array is what every
 * "renders with no rows" test passes — and is read as non-overlapping, its
 * totals summed from the groups. A document must never be the thing that throws.
 */
function _totalValueView(data) {
  const groups = Array.isArray(data) ? data : (data && Array.isArray(data.groups) ? data.groups : []);
  const summed = groups.reduce((acc, g) => ({
    groupCount: groups.length,
    itemCount: acc.itemCount + (g.itemCount || 0),
    purchaseTotal: acc.purchaseTotal + (g.purchaseTotal || 0),
    currentTotal: acc.currentTotal + (g.currentTotal || 0),
    excludedCount: acc.excludedCount + (g.excludedCount || 0),
  }), { groupCount: groups.length, itemCount: 0, purchaseTotal: 0, currentTotal: 0, excludedCount: 0 });

  const totals = (!Array.isArray(data) && data && data.totals) ? { ...summed, ...data.totals } : summed;
  return { groups, totals, overlapping: !Array.isArray(data) && !!(data && data.overlapping) };
}

// ── PDF layout ───────────────────────────────────────────────────────────────
//
// Shared chrome for the six report renderers, so they read as one family rather
// than six documents that happen to come from the same app.

const INK = '#111214';
const MUTED = '#5c5f64';
const ZEBRA = '#f4f4f5';
const HAIR = '#c9cbcf';

const M = 50;                        // page margin
const PAGE_W = 612, PAGE_H = 792;    // US Letter, portrait
const W = PAGE_W - M * 2;            // 512pt of usable width
const RIGHT = M + W;
const FOOTER_Y = PAGE_H - M - 16;
/** Rows stop here so the page footer always has room of its own. */
const BODY_BOTTOM = FOOTER_Y - 10;

/** Matches reports.schema's limit — printed on the page when it bites. */
const ACTIVITY_CAP = 500;

const REPORT_NAMES = Object.freeze({
  insurance: 'Insurance Summary',
  total_value: 'Total Value',
  items_by_location: 'Items by Location',
  lending: 'Lending',
  activity_log: 'Activity Log',
  tag: 'Tag Report',
});

/** The inverted title bar — the same device as the app and the printed labels. */
function _titleBar(doc, title) {
  const h = 24, y = doc.y;
  doc.save().rect(M, y, W, h).fill(INK).restore();
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(13)
    .text(String(title).toUpperCase(), M + 8, y + 7,
      { width: W - 16, height: doc.currentLineHeight(), characterSpacing: 1.1, lineBreak: false, ellipsis: true });
  doc.fillColor(INK);
  doc.y = y + h;
}

/** Property and date, closed by the heavy rule the body hangs from. */
function _metaLine(doc, left, right) {
  const y = doc.y + 5;
  doc.font('Courier').fontSize(7).fillColor(MUTED)
    .text(String(left || '').toUpperCase(), M, y, { width: W * 0.66, height: doc.currentLineHeight(), lineBreak: false, ellipsis: true })
    .text(String(right || '').toUpperCase(), M, y, { width: W, height: doc.currentLineHeight(), align: 'right', lineBreak: false });
  const ruleY = y + 10;
  doc.save().moveTo(M, ruleY).lineTo(RIGHT, ruleY).lineWidth(1.5).strokeColor(INK).stroke().restore();
  doc.fillColor(INK);
  doc.y = ruleY;
}

/**
 * The black summary band: the two to four numbers the report exists to produce,
 * directly under the header. Every total used to live at the bottom, after the
 * rows — the last place anyone looks on a nine-page document.
 */
function _band(doc, entries) {
  const list = entries.filter(Boolean);
  if (!list.length) return;
  const h = 30, y = doc.y + 7;
  doc.save().rect(M, y, W, h).fill(INK).restore();
  const cell = W / list.length;
  list.forEach((e, i) => {
    const x = M + i * cell + 7, w = cell - 11;
    doc.font('Courier').fontSize(5.6).fillColor('#B9BCC2')
      .text(String(e.k).toUpperCase(), x, y + 6,
        { width: w, height: doc.currentLineHeight(), characterSpacing: 0.7, lineBreak: false, ellipsis: true });
    doc.font('Courier-Bold').fontSize(10.5).fillColor('#FFFFFF')
      .text(String(e.v), x, y + 15, { width: w, height: doc.currentLineHeight(), lineBreak: false, ellipsis: true });
  });
  doc.fillColor(INK);
  doc.y = y + h;
}

/** Mono uppercase column heads over a hairline. Re-run after every addPage. */
function _colHeads(doc, cols) {
  const y = doc.y + 9;
  doc.font('Courier').fontSize(5.8).fillColor(MUTED);
  for (const c of cols) {
    doc.text(String(c.label).toUpperCase(), c.x, y,
      { width: c.w, height: doc.currentLineHeight(), align: c.align || 'left', characterSpacing: 0.7, lineBreak: false });
  }
  const ruleY = y + 8;
  doc.save().moveTo(M, ruleY).lineTo(RIGHT, ruleY).lineWidth(0.7).strokeColor(HAIR).stroke().restore();
  doc.fillColor(INK);
  doc.y = ruleY + 2;
}

/**
 * Break to a new page when `need` points will not fit, redrawing whatever
 * chrome the body needs. A table whose headers appear only on page one stops
 * being a table on page two.
 */
function _ensureRoom(doc, need, redraw) {
  if (doc.y + need <= BODY_BOTTOM) return false;
  doc.addPage();
  doc.y = M;
  if (redraw) redraw();
  return true;
}

/** Paint a row's zebra stripe and return the y its cells draw at. */
function _rowTop(doc, h, zebra) {
  const y = doc.y;
  if (zebra) doc.save().rect(M, y, W, h).fill(ZEBRA).restore();
  doc.fillColor(INK);
  return y;
}

/** Close a row with its hairline and advance. */
function _rowEnd(doc, y, h) {
  const ruleY = y + h;
  doc.save().moveTo(M, ruleY).lineTo(RIGHT, ruleY).lineWidth(0.3).strokeColor('#e6e7ea').stroke().restore();
  doc.fillColor(INK);
  doc.y = ruleY;
}

/** A small outlined (or solid) pill. Returns the width it drew. */
function _pill(doc, text, x, y, { solid = false, size = 5.6 } = {}) {
  const label = String(text).toUpperCase();
  doc.font('Helvetica-Bold').fontSize(size);
  const padX = 3.2, w = doc.widthOfString(label) + padX * 2, h = size + 4.5;
  doc.save().roundedRect(x, y, w, h, h / 2).lineWidth(0.7);
  if (solid) doc.fill(INK); else doc.strokeColor(INK).stroke();
  doc.restore();
  doc.fillColor(solid ? '#FFFFFF' : INK)
    .text(label, x + padX, y + 2.6, { width: w - padX * 2, height: doc.currentLineHeight(), lineBreak: false });
  doc.fillColor(INK);
  return w;
}

/**
 * A right-aligned figure in Courier.
 *
 * Money and counts have to line up on the decimal to be comparable down a
 * column, and proportional Helvetica — what every report used — cannot do that.
 */
function _num(doc, text, col, y, { bold = false, muted = false, size = 7 } = {}) {
  doc.font(bold ? 'Courier-Bold' : 'Courier').fontSize(size)
    .fillColor(muted ? MUTED : INK)
    .text(String(text), col.x, y, { width: col.w, height: doc.currentLineHeight(), align: 'right', lineBreak: false });
  doc.fillColor(INK);
}

/** An empty report says so in its own voice rather than printing a bare page. */
function _empty(doc, message) {
  doc.font('Helvetica-Oblique').fontSize(9).fillColor(MUTED)
    .text(message, M, doc.y + 16, { width: W });
  doc.fillColor(INK);
  return 'NOTHING TO REPORT';
}

/** "1 ITEM" / "2 ITEMS" — the count is a fact on the page, not a template. */
function _plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 'S'}`;
}

/** Items in a container subtree, at any depth. */
function _countItems(containers) {
  return (containers || []).reduce(
    (s, c) => s + (c.items || []).length + _countItems(c.children), 0);
}

/** Containers in a subtree, at any depth. */
function _countContainers(containers) {
  return (containers || []).reduce((s, c) => s + 1 + _countContainers(c.children), 0);
}

/**
 * Page x of y, stamped once the body is laid out.
 *
 * Requires bufferPages: the count is not known until the last row is drawn, and
 * a report that silently runs to nine pages is one a reader cannot tell they
 * have only half of.
 */
function _stampFooters(doc, note) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.save().moveTo(M, FOOTER_Y - 5).lineTo(RIGHT, FOOTER_Y - 5)
      .lineWidth(1).strokeColor(INK).stroke().restore();
    doc.font('Courier').fontSize(6).fillColor(MUTED)
      .text(String(note || ''), M, FOOTER_Y, { width: W * 0.7, height: doc.currentLineHeight(), lineBreak: false, ellipsis: true })
      .text(`PAGE ${i + 1} OF ${range.count}`, M, FOOTER_Y, { width: W, height: doc.currentLineHeight(), align: 'right', lineBreak: false });
  }
  doc.fillColor(INK);
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
         i.CURRENT_VALUE_IS_ESTIMATE,
         i.DEPRECIATION_ENABLED,
         i.DEPRECIATION_RATE AS ITEM_DEPRECIATION_RATE,
         i.CONDITION,
         i.COMPLETENESS,
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
       -- DATE_TYPE is free text the user types; the form's own preset is
       -- "Purchased", so an exact match on 'purchase' finds nothing anyone
       -- entered and every report's purchase date comes back empty.
       LEFT JOIN TALLY.item_dates id_purchase ON id_purchase.ITEM_ID = i.ID AND LOWER(id_purchase.DATE_TYPE) IN ('purchased', 'purchase')
       WHERE a.PROPERTY_ID = ?
         AND i.STATUS = 'active'
         AND i.DELETED_AT IS NULL
         AND c.DELETED_AT IS NULL
         AND a.DELETED_AT IS NULL
       ORDER BY a.NAME, c.NAME, i.NAME`,
      [propertyId]
    );

    const items = [];
    // One row per item, whatever the joins do. Two of them can fan out: a
    // second "Purchased" date (DATE_TYPE is free text a user types, with no
    // uniqueness) and two condition snapshots sharing one CREATED_AT. Either
    // one prints the item twice and adds its value to the totals twice — the
    // same shape of bug as #310, on the same insurance-facing document.
    const seen = new Set();
    for (const row of rows) {
      if (seen.has(row.ITEM_ID)) continue;
      seen.add(row.ITEM_ID);
      const depRate = row.ITEM_DEPRECIATION_RATE || row.PRODUCT_DEPRECIATION_RATE || 0;
      const purchaseDate = row.PURCHASE_DATE || row.ITEM_CREATED_AT;
      const purchasePrice = row.PURCHASE_PRICE ? parseFloat(row.PURCHASE_PRICE) : null;

      // The "Current Value" column has FOUR possible provenances and used to
      // print all of them as identical currency. On the one document where a
      // number's origin decides whether a claim is honest, that is the whole
      // problem — most sharply in the last branch, where an item with no
      // current value at all reports its PURCHASE PRICE as its current value,
      // silently overstating the total.
      //
      // The number itself is unchanged; what is new is that it now says where
      // it came from. Only 'estimated' needs a stored fact — the rest are
      // derivable, so the boolean column is the minimum added state.
      let currentValue = purchasePrice;
      let valueBasis = purchasePrice != null ? 'purchase' : null;
      if (row.DEPRECIATION_ENABLED && purchasePrice && depRate) {
        currentValue = _calcDepreciatedValue(purchasePrice, parseFloat(depRate), purchaseDate);
        valueBasis = 'depreciated';
      } else if (row.CURRENT_VALUE != null) {
        // Note the precedence, which predates this change: an item with
        // depreciation enabled never consults CURRENT_VALUE at all.
        currentValue = parseFloat(row.CURRENT_VALUE);
        valueBasis = row.CURRENT_VALUE_IS_ESTIMATE ? 'estimated' : 'declared';
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
        valueBasis,
        // 'box_only'/'accessories_only' mean the thing itself is elsewhere, so
        // this row's money describes an object that is not in the bin.
        completeness: row.COMPLETENESS || 'complete',
        condition: row.LATEST_CONDITION || row.CONDITION || null,
        areaName: row.AREA_NAME,
        containerName: row.CONTAINER_NAME,
      });
    }

    return items;
  },

  // ── Total Value ──────────────────────────────────────────────────────────

  /**
   * The property's value, grouped for presentation.
   *
   * THE INVARIANT: `totals` describes the property, not the grouping. Whatever
   * `groupBy` is, `totals.currentTotal` is the same number — every active item
   * counted exactly once. Only `groups` changes shape.
   *
   * That was not true before #310. The grouping was done in SQL, and the tag
   * grouping bought its GROUP_NAME with an INNER JOIN onto `entity_tags`: an
   * item carrying three tags arrived as three rows and was added three times,
   * an item carrying none never arrived at all. The one report you would hand
   * an insurer could be inflated and incomplete at the same time, and the
   * caller summed the groups to get a grand total, so the error was invisible.
   *
   * So: one query for the money, one map from item to tag names, and the
   * grouping key chosen in JS from columns the first query already carries.
   * Groups may share an item (a thing with three tags is listed under all
   * three — that is what the reader asked to see); `totals` is computed from
   * the de-duplicated item set instead of from the groups, and `overlapping`
   * says out loud when the two disagree.
   */
  async totalValue(propertyId, { groupBy = 'property' } = {}) {
    const rows = await _db.query(
      `SELECT
         i.ID AS ITEM_ID,
         a.NAME AS AREA_NAME,
         i.CONDITION AS ITEM_CONDITION,
         i.PURCHASE_PRICE,
         i.CURRENT_VALUE,
         i.COMPLETENESS,
         i.DEPRECIATION_ENABLED,
         i.DEPRECIATION_RATE AS ITEM_DEP_RATE,
         p.DEPRECIATION_RATE AS PRODUCT_DEP_RATE,
         i.CREATED_AT AS ITEM_CREATED_AT,
         id_purchase.DATE_VALUE AS PURCHASE_DATE
       FROM TALLY.items i
       JOIN TALLY.containers c ON c.ID = i.CONTAINER_ID
       JOIN TALLY.areas a ON a.ID = c.AREA_ID
       LEFT JOIN TALLY.products p ON p.ID = i.PRODUCT_ID
       LEFT JOIN TALLY.item_dates id_purchase ON id_purchase.ITEM_ID = i.ID AND LOWER(id_purchase.DATE_TYPE) IN ('purchased', 'purchase')
       WHERE a.PROPERTY_ID = ?
         AND i.STATUS = 'active'
         AND i.DELETED_AT IS NULL
         AND c.DELETED_AT IS NULL
         AND a.DELETED_AT IS NULL
       ORDER BY a.NAME, i.NAME`,
      [propertyId],
    );

    // `item_dates` is user-defined free text with no uniqueness of its own, so
    // two rows typed "Purchased" on one item fan this LEFT JOIN out exactly the
    // way the tag join did. Keying by item id makes the value set a SET, which
    // is the only thing that makes the invariant above provable.
    const items = new Map();
    for (const row of rows) if (!items.has(row.ITEM_ID)) items.set(row.ITEM_ID, row);

    const tagNames = groupBy === 'tag' ? await ReportsService._itemTagNames(propertyId) : null;

    const groups = new Map();
    const bucket = (name) => {
      if (!groups.has(name)) {
        groups.set(name, { group: name, purchaseTotal: 0, currentTotal: 0, itemCount: 0, excludedCount: 0 });
      }
      return groups.get(name);
    };
    const totals = { itemCount: 0, purchaseTotal: 0, currentTotal: 0, excludedCount: 0 };

    for (const row of items.values()) {
      const names = ReportsService._groupNamesFor(row, groupBy, tagNames);

      // A box or a bag of spares carries the price of the object it came from,
      // and that object is in use somewhere else. The insurance report has
      // skipped these since #178; counting them here left the two reports
      // disagreeing about what the same property is worth.
      //
      // Counted separately rather than filtered in SQL: an exclusion nobody can
      // see is indistinguishable from data that was never entered.
      if (_isPartial({ completeness: row.COMPLETENESS })) {
        totals.excludedCount += 1;
        for (const name of names) bucket(name).excludedCount += 1;
        continue;
      }

      const purchasePrice = row.PURCHASE_PRICE ? parseFloat(row.PURCHASE_PRICE) : 0;
      let currentValue;
      if (row.DEPRECIATION_ENABLED && purchasePrice) {
        const depRate = parseFloat(row.ITEM_DEP_RATE || row.PRODUCT_DEP_RATE || 0);
        const purchaseDate = row.PURCHASE_DATE || row.ITEM_CREATED_AT;
        currentValue = _calcDepreciatedValue(purchasePrice, depRate, purchaseDate);
      } else if (row.CURRENT_VALUE != null) {
        currentValue = parseFloat(row.CURRENT_VALUE);
      } else {
        currentValue = purchasePrice;
      }

      totals.itemCount += 1;
      totals.purchaseTotal += purchasePrice;
      totals.currentTotal += currentValue;

      for (const name of names) {
        const g = bucket(name);
        g.itemCount += 1;
        g.purchaseTotal += purchasePrice;
        g.currentTotal += currentValue;
      }
    }

    const groupList = [...groups.values()].map(g => ({
      group: g.group,
      purchaseTotal: _round2(g.purchaseTotal),
      currentTotal: _round2(g.currentTotal),
      itemCount: g.itemCount,
      excludedCount: g.excludedCount,
    }));

    return {
      groupBy,
      groups: groupList,
      totals: {
        groupCount: groupList.length,
        itemCount: totals.itemCount,
        purchaseTotal: _round2(totals.purchaseTotal),
        currentTotal: _round2(totals.currentTotal),
        excludedCount: totals.excludedCount,
      },
      // Measured, not assumed: only tag grouping CAN overlap, and it only does
      // when some item actually carries more than one tag. Consumers use this
      // to label the subtotals rather than to correct them.
      overlapping: groupList.reduce((s, g) => s + g.itemCount, 0) > totals.itemCount,
    };
  },

  /** The grouping bucket(s) one item belongs to. Tags are the only many. */
  _groupNamesFor(row, groupBy, tagNames) {
    if (groupBy === 'area') return [row.AREA_NAME || 'Unassigned'];
    // #285: condition is a first-class item column, so this is one key
    // extractor rather than a fourth SELECT. NULL is a real answer — "how much
    // of the property is in poor condition" is only worth reading beside how
    // much of it nobody has rated.
    if (groupBy === 'condition') return [row.ITEM_CONDITION || 'Unrated'];
    if (groupBy === 'tag') {
      // An explicit bucket, because an item with no tags is not a rounding
      // error — before #310 it was dropped from the report altogether.
      const names = tagNames && tagNames.get(row.ITEM_ID);
      return names && names.length ? names : ['Untagged'];
    }
    return ['Total'];
  },

  /** item id → its tag names, for the whole property, in one query. */
  async _itemTagNames(propertyId) {
    const rows = await _db.query(
      `SELECT et.ENTITY_ID AS ITEM_ID, t.NAME AS TAG_NAME
         FROM TALLY.entity_tags et
         JOIN TALLY.tags t ON t.ID = et.TAG_ID
        WHERE et.ENTITY_TYPE = 'item'
          AND t.PROPERTY_ID = ?
        ORDER BY t.NAME`,
      [propertyId],
    );
    const byItem = new Map();
    for (const row of rows) {
      const names = byItem.get(row.ITEM_ID) || [];
      if (!names.includes(row.TAG_NAME)) names.push(row.TAG_NAME);
      byItem.set(row.ITEM_ID, names);
    }
    return byItem;
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

  /**
   * The property's name, for the report header.
   *
   * Scoped through property_members like every other read: the route's
   * resolvePropertyRole has already established membership, but a query that
   * enforces it independently cannot be broken by a change to the route.
   */
  async getPropertyName(propertyId, userId) {
    const rows = await _db.query(
      `SELECT p.NAME
         FROM TALLY.properties p
         INNER JOIN TALLY.property_members pm ON pm.PROPERTY_ID = p.ID AND pm.USER_ID = ?
        WHERE p.ID = ?`,
      [userId, propertyId],
    );
    return rows[0]?.NAME || null;
  },

  // ── PDF Generation ───────────────────────────────────────────────────────
  //
  // Every report used to print as a centred Helvetica title over an unruled
  // column grid — the pdfkit default, sharing nothing with the app or the
  // printed labels. These renderers use the devices tally already has: an
  // inverted title bar, mono figures, ruled rows, and the report's answer in a
  // black band at the TOP. The totals used to sit alone at the bottom of page
  // four, which is the last place anyone looks.

  async generatePdf(reportType, data, context = {}) {
    // bufferPages so the footer can say "page 3 of 9" — the count is not
    // known until the last row is drawn, and a report that silently runs
    // to nine pages is one a reader cannot tell they have half of.
    const doc = new PDFDocument({ size: 'LETTER', margin: M, bufferPages: true });
    return collectPdf(doc, () => {
      const renderers = {
        insurance: ReportsService._renderInsurancePdf,
        total_value: ReportsService._renderTotalValuePdf,
        items_by_location: ReportsService._renderLocationPdf,
        lending: ReportsService._renderLendingPdf,
        activity_log: ReportsService._renderActivityPdf,
        tag: ReportsService._renderTagPdf,
      };

      _titleBar(doc, REPORT_NAMES[reportType] || 'Report');
      _metaLine(
        doc,
        [context.propertyName, context.scope].filter(Boolean).join(' · ') || 'Tally',
        _fmtDate(new Date()),
      );

      const render = renderers[reportType];
      let note = '';
      if (render) {
        note = render.call(ReportsService, doc, data) || '';
      } else {
        doc.font('Helvetica').fontSize(10).text('Unknown report type.', M, doc.y + 10);
      }

      _stampFooters(doc, note);
    });
  },

  _renderInsurancePdf(doc, items) {
    const cols = [
      { label: 'Item',     x: M,       w: 150 },
      { label: 'Brand',    x: M + 152, w: 78 },
      { label: 'Paid',     x: M + 232, w: 62, align: 'right' },
      { label: 'Value',    x: M + 296, w: 74, align: 'right' },
      { label: 'Cond',     x: M + 372, w: 44, align: 'center' },
      { label: 'Location', x: M + 418, w: 94 },
    ];

    // Both totals skip box/spares rows. Their money describes the object the
    // packaging came from, not the packaging — a scanned computer box carries
    // the computer's catalogue price, and the computer is in use elsewhere.
    const counted = items.filter(i => !_isPartial(i));
    const partial = items.filter(_isPartial);
    const totalPurchase = counted.reduce((s, i) => s + (i.purchasePrice || 0), 0);
    const totalCurrent = counted.reduce((s, i) => s + (i.currentValue || 0), 0);
    const basisCount = (b) => items.filter(i => i.valueBasis === b).length;
    const estimated = basisCount('estimated');
    const fromPurchase = basisCount('purchase');

    _band(doc, [
      { k: 'Items', v: String(items.length) },
      { k: 'Purchase total', v: _fmtCurrency(totalPurchase) },
      { k: 'Current total', v: _fmtCurrency(totalCurrent) },
      estimated ? { k: 'Estimated', v: String(estimated) } : null,
      partial.length ? { k: 'Excluded', v: String(partial.length) } : null,
    ]);

    if (!items.length) return _empty(doc, 'No insured items in this property.');

    const heads = () => _colHeads(doc, cols);
    heads();

    const H = 12;
    items.forEach((item, i) => {
      _ensureRoom(doc, H, heads);
      const y = _rowTop(doc, H, i % 2 === 1);
      doc.font('Helvetica').fontSize(7).fillColor(INK)
        .text(item.itemName || '-', cols[0].x, y + 2.5, { width: cols[0].w, height: doc.currentLineHeight(), lineBreak: false, ellipsis: true });
      doc.fillColor(MUTED)
        .text(item.brand || '—', cols[1].x, y + 2.5, { width: cols[1].w, height: doc.currentLineHeight(), lineBreak: false, ellipsis: true });
      _num(doc, _fmtCurrency(item.purchasePrice), cols[2], y + 2.5, { muted: true });

      // A box or a bag of spares still PRINTS — you want to know the box is in
      // that tote — but it must not show the absent thing's value as though the
      // thing were there.
      if (_isPartial(item)) {
        doc.font('Helvetica-Oblique').fontSize(6.2).fillColor(MUTED)
          .text(PARTIAL_LABEL[item.completeness], cols[3].x, y + 3, { width: cols[3].w, height: doc.currentLineHeight(), align: 'right', lineBreak: false });
      } else {
        _num(doc, _fmtCurrency(item.currentValue) + (BASIS_MARK[item.valueBasis] || ''), cols[3], y + 2.5, { bold: true });
      }

      doc.font('Helvetica').fontSize(6.5).fillColor(MUTED)
        .text(item.condition || '—', cols[4].x, y + 3, { width: cols[4].w, height: doc.currentLineHeight(), align: 'center', lineBreak: false })
        .text([item.areaName, item.containerName].filter(Boolean).join(' › '), cols[5].x, y + 3, { width: cols[5].w, height: doc.currentLineHeight(), lineBreak: false, ellipsis: true });
      doc.fillColor(INK);
      _rowEnd(doc, y, H);
    });

    // Where the value in the totals actually came from. A reader cannot weigh
    // the number in the band without it, and counting marks by hand across four
    // pages is not a reasonable thing to ask.
    _ensureRoom(doc, 46);
    doc.y += 8;
    doc.font('Courier').fontSize(6.5).fillColor(MUTED)
      .text(
        `VALUE BASIS — DECLARED ${basisCount('declared')}   ESTIMATED (e) ${estimated}   ` +
        `DEPRECIATED (d) ${basisCount('depreciated')}   FROM PURCHASE PRICE (p) ${fromPurchase}`,
        M, doc.y, { width: W, characterSpacing: 0.4 },
      );
    if (estimated || fromPurchase) {
      doc.font('Helvetica-Oblique').fontSize(7)
        .text(
          'e = value suggested by photo identification and kept, not declared.    ' +
          'p = no current value recorded; the purchase price is shown in its place.',
          M, doc.y + 3, { width: W },
        );
    }
    // An exclusion nobody can see is indistinguishable from data never entered.
    if (partial.length) {
      const withheld = partial.reduce((s, i) => s + (i.currentValue || 0), 0);
      doc.font('Helvetica').fontSize(7.5).fillColor(INK)
        .text(
          `Excluded from the totals — packaging or spares only: ${partial.length} ` +
          `(${_fmtCurrency(withheld)} of recorded value not counted). These rows are ` +
          'listed above; the item itself is not in this property.',
          M, doc.y + 5, { width: W },
        );
    }
    doc.fillColor(INK);

    return `${_plural(items.length, 'ITEM')} · ${counted.length} COUNTED`;
  },

  _renderTotalValuePdf(doc, data) {
    const cols = [
      { label: 'Group',    x: M,       w: 230 },
      { label: 'Items',    x: M + 236, w: 50, align: 'right' },
      { label: 'Paid',     x: M + 292, w: 100, align: 'right' },
      { label: 'Value',    x: M + 398, w: 114, align: 'right' },
    ];

    const { groups, totals, overlapping } = _totalValueView(data);

    // Sorted, because the question this report answers is "where is the money"
    // and the answer should be the first row rather than something you find by
    // comparing four-figure numbers by eye.
    const sorted = [...groups].sort((a, b) => (b.currentTotal || 0) - (a.currentTotal || 0));
    const max = Math.max(1, ...sorted.map(g => g.currentTotal || 0));

    // The band is the property, NOT the sum of the column beneath it. Under a
    // tag grouping those are different numbers by design — a thing with three
    // tags is listed three times and owned once — and the band is the one an
    // insurer is handed (#310).
    const items = totals.itemCount;
    const paid = totals.purchaseTotal;
    const value = totals.currentTotal;
    const excluded = totals.excludedCount;
    _band(doc, [
      { k: 'Groups', v: String(sorted.length) },
      { k: 'Items', v: String(items) },
      { k: 'Purchase total', v: _fmtCurrency(paid) },
      { k: 'Current total', v: _fmtCurrency(value) },
      excluded ? { k: 'Excluded', v: String(excluded) } : null,
    ]);

    // Said before the rows, not after them: a reader who adds the Value column
    // up and gets a bigger number than the band has to be told why on the way
    // in, or they will trust the arithmetic they did themselves.
    if (overlapping) {
      _ensureRoom(doc, 22);
      doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(INK)
        .text(
          'Groups overlap — an item with three tags is listed under all three. The subtotals below ' +
          'therefore add up to more than the property is worth; the totals above count each item once.',
          M, doc.y + 6, { width: W },
        );
      doc.y += 2;
    }

    if (!sorted.length) return _empty(doc, 'Nothing to total in this property.');

    const heads = () => _colHeads(doc, cols);
    heads();

    const H = 21;
    sorted.forEach((g, i) => {
      _ensureRoom(doc, H, heads);
      const y = _rowTop(doc, H, i % 2 === 1);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(INK)
        .text(g.group || '-', cols[0].x, y + 2.5, { width: cols[0].w, height: doc.currentLineHeight(), lineBreak: false, ellipsis: true });
      _num(doc, String(g.itemCount ?? 0), cols[1], y + 3);
      _num(doc, _fmtCurrency(g.purchaseTotal), cols[2], y + 3, { muted: true });
      _num(doc, _fmtCurrency(g.currentTotal), cols[3], y + 3, { bold: true });

      // Proportion, not just magnitude — six rows can show their shape.
      //
      // Two things this got wrong first. Centred in the row, the bar read as
      // belonging to the NEXT group's name, so it now sits tight under its own.
      // Full-width, the largest group's bar was 100% and therefore
      // indistinguishable from a divider rule — so it spans the label column
      // only, where even a full bar visibly stops before the figures.
      const barY = y + 12, barW = cols[0].w;
      doc.save().rect(M, barY, barW, 3.5).fill('#e6e7ea').restore();
      doc.save().rect(M, barY, Math.max(1, barW * ((g.currentTotal || 0) / max)), 3.5).fill(INK).restore();
      doc.fillColor(INK);
      _rowEnd(doc, y, H);
    });

    if (excluded) {
      _ensureRoom(doc, 26);
      doc.font('Helvetica').fontSize(7.5).fillColor(INK)
        .text(
          `${_plural(excluded, 'ROW').toLowerCase()} excluded — packaging or spares only. ` +
          'Their price belongs to the item they came from, which is not in this property. ' +
          'The insurance summary excludes them on the same basis.',
          M, doc.y + 8, { width: W },
        );
    }
    return [
      'BAR = SHARE OF THE LARGEST GROUP',
      overlapping ? 'SUBTOTALS OVERLAP · TOTALS COUNT EACH ITEM ONCE' : null,
      excluded ? `${excluded} EXCLUDED` : null,
    ].filter(Boolean).join(' · ');
  },

  _renderLocationPdf(doc, areas) {
    const totals = areas.reduce((acc, a) => {
      acc.items += _countItems(a.containers);
      acc.containers += _countContainers(a.containers);
      return acc;
    }, { items: 0, containers: 0 });

    _band(doc, [
      { k: 'Areas', v: String(areas.length) },
      { k: 'Containers', v: String(totals.containers) },
      { k: 'Items', v: String(totals.items) },
    ]);

    if (!areas.length) return _empty(doc, 'This property has no areas yet.');

    for (const area of areas) {
      // Keep an area heading with at least its first container, or a page can
      // end on a heading that promises contents overleaf.
      _ensureRoom(doc, 46);
      doc.y += 8;
      const y = doc.y;
      doc.save().rect(M, y, W, 15).fill(INK).restore();
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#FFFFFF')
        .text(String(area.areaName || '—').toUpperCase(), M + 6, y + 4,
          { width: W - 120, height: doc.currentLineHeight(), characterSpacing: 0.8, lineBreak: false, ellipsis: true });
      doc.font('Courier').fontSize(6.5)
        .text(_plural(_countItems(area.containers), 'ITEM'), M, y + 4.5, { width: W - 6, height: doc.currentLineHeight(), align: 'right', lineBreak: false });
      doc.fillColor(INK);
      doc.y = y + 15;

      for (const container of area.containers) {
        ReportsService._renderContainerPdf(doc, container, 0);
      }
    }

    return [_plural(totals.items, 'ITEM'), _plural(areas.length, 'AREA'), _plural(totals.containers, 'CONTAINER')].join(' · ');
  },

  _renderContainerPdf(doc, container, depth) {
    // Depth reads from an indent rule rather than font size alone, so a bin
    // three levels down is still legible as a bin.
    //
    // The marker is a guillemet, not the box-drawing character this first
    // used. pdfkit's built-in Helvetica is WinAnsi-encoded and has no glyph
    // for U+2514, so it printed as a stray '%' — no error, just a wrong page,
    // and only a rendered PNG showed it. Guarded by the encoding test in
    // reports.pdf.test.js.
    const indent = M + depth * 14;
    _ensureRoom(doc, 24);
    doc.y += 4;
    const hy = doc.y;
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(INK)
      .text(`${depth ? '» ' : ''}${container.containerName || '—'}`, indent, hy,
        { width: W - (indent - M) - 60, height: doc.currentLineHeight(), lineBreak: false, ellipsis: true });
    doc.font('Courier').fontSize(6).fillColor(MUTED)
      .text(_plural((container.items || []).length, 'ITEM'), M, hy + 0.5, { width: W, height: doc.currentLineHeight(), align: 'right', lineBreak: false });
    const ruleY = hy + 9;
    doc.save().moveTo(indent, ruleY).lineTo(RIGHT, ruleY).lineWidth(0.8).strokeColor(INK).stroke().restore();
    doc.fillColor(INK);
    doc.y = ruleY + 1.5;

    const H = 11;
    (container.items || []).forEach((item, i) => {
      _ensureRoom(doc, H);
      const y = _rowTop(doc, H, i % 2 === 1);
      doc.font('Helvetica').fontSize(7).fillColor(INK)
        .text(item.itemName || '-', indent + 8, y + 2, { width: W - (indent - M) - 150, height: doc.currentLineHeight(), lineBreak: false, ellipsis: true });
      _num(doc, _fmtCurrency(item.purchasePrice), { x: RIGHT - 150, w: 60 }, y + 2, { muted: true });
      // A lent or missing item carries a pill rather than a bare word — on a
      // moving-day checklist "it is not in the box" is the fact that matters.
      if (item.status && item.status !== 'active') {
        _pill(doc, item.status, RIGHT - 78, y + 1.5, { solid: true });
      } else {
        doc.font('Helvetica').fontSize(6.5).fillColor(MUTED)
          .text(item.condition || '—', RIGHT - 78, y + 2.5, { width: 78, height: doc.currentLineHeight(), lineBreak: false });
      }
      doc.fillColor(INK);
      _rowEnd(doc, y, H);
    });

    for (const child of (container.children || [])) {
      ReportsService._renderContainerPdf(doc, child, depth + 1);
    }
  },

  _renderLendingPdf(doc, loans) {
    const cols = [
      { label: 'Item',     x: M + 8,   w: 152 },
      { label: 'Lent to',  x: M + 164, w: 96 },
      { label: 'Lent',     x: M + 262, w: 66, align: 'right' },
      { label: 'Due',      x: M + 330, w: 66, align: 'right' },
      { label: 'Location', x: M + 402, w: 110 },
    ];

    const overdue = loans.filter(l => l.overdue);
    const oldest = loans.reduce((max, l) => {
      const days = l.lentAt ? Math.floor((Date.now() - new Date(l.lentAt)) / 86400000) : 0;
      return days > max ? days : max;
    }, 0);

    _band(doc, [
      { k: 'On loan', v: String(loans.length) },
      { k: 'Overdue', v: String(overdue.length) },
      { k: 'Longest out', v: loans.length ? `${oldest}d` : '—' },
    ]);

    if (!loans.length) return _empty(doc, 'Nothing is lent out right now.');

    // Overdue first: the only question this report answers on sight is which
    // ones are late, so they must not be scattered through the list.
    const sorted = [...loans].sort((a, b) => {
      if (!!a.overdue !== !!b.overdue) return a.overdue ? -1 : 1;
      return new Date(a.dueAt || 0) - new Date(b.dueAt || 0);
    });

    const heads = () => _colHeads(doc, cols);
    heads();

    const H = 13;
    sorted.forEach((loan, i) => {
      _ensureRoom(doc, H, heads);
      const y = _rowTop(doc, H, i % 2 === 1);
      // A solid rule in the margin. Visible down the edge of the page without
      // reading a single word, which "Yes" in the fifth column never was.
      if (loan.overdue) doc.save().rect(M, y, 3, H - 2).fill(INK).restore();

      doc.font(loan.overdue ? 'Helvetica-Bold' : 'Helvetica').fontSize(7).fillColor(INK)
        .text(loan.itemName || '-', cols[0].x, y + 3, { width: cols[0].w - (loan.overdue ? 42 : 0), height: doc.currentLineHeight(), lineBreak: false, ellipsis: true });
      if (loan.overdue) {
        _pill(doc, 'overdue', cols[0].x + cols[0].w - 40, y + 2);
      }
      doc.font('Helvetica').fontSize(7).fillColor(MUTED)
        .text(loan.lentTo || '-', cols[1].x, y + 3, { width: cols[1].w, height: doc.currentLineHeight(), lineBreak: false, ellipsis: true });
      _num(doc, loan.lentAt ? _fmtDate(loan.lentAt) : '—', cols[2], y + 3, { muted: true, size: 6.5 });
      _num(doc, loan.dueAt ? _fmtDate(loan.dueAt) : '—', cols[3], y + 3, { bold: !!loan.overdue, size: 6.5 });
      doc.font('Helvetica').fontSize(6.5).fillColor(MUTED)
        .text([loan.areaName, loan.containerName].filter(Boolean).join(' › '), cols[4].x, y + 3.5, { width: cols[4].w, height: doc.currentLineHeight(), lineBreak: false, ellipsis: true });
      doc.fillColor(INK);
      _rowEnd(doc, y, H);
    });

    return overdue.length ? `${overdue.length} OVERDUE — LISTED FIRST` : 'NONE OVERDUE';
  },

  _renderActivityPdf(doc, entries) {
    const cols = [
      { label: 'When',   x: M,       w: 104 },
      { label: 'Who',    x: M + 110, w: 86 },
      { label: 'Action', x: M + 200, w: 56 },
      { label: 'Entity', x: M + 262, w: 250 },
    ];

    const people = new Set(entries.map(e => e.displayName).filter(Boolean));
    _band(doc, [
      { k: 'Entries', v: String(entries.length) },
      { k: 'People', v: String(people.size) },
      { k: 'First', v: entries.length ? _fmtDate(entries[0].createdAt) : '—' },
      { k: 'Last', v: entries.length ? _fmtDate(entries[entries.length - 1].createdAt) : '—' },
    ]);

    if (!entries.length) return _empty(doc, 'No activity in this window.');

    const heads = () => _colHeads(doc, cols);
    heads();

    const H = 12;
    entries.forEach((entry, i) => {
      _ensureRoom(doc, H, heads);
      const y = _rowTop(doc, H, i % 2 === 1);
      doc.font('Courier').fontSize(6.5).fillColor(MUTED)
        .text(entry.createdAt ? _fmtDate(entry.createdAt) : '—', cols[0].x, y + 3, { width: cols[0].w, height: doc.currentLineHeight(), lineBreak: false });
      doc.font('Helvetica').fontSize(7).fillColor(INK)
        .text(entry.displayName || '—', cols[1].x, y + 2.5, { width: cols[1].w, height: doc.currentLineHeight(), lineBreak: false, ellipsis: true });
      // The action is what you scan a column for, so it is the anchor. Deleted
      // is solid because it is the one you go looking for.
      if (entry.action) {
        _pill(doc, entry.action, cols[2].x, y + 1.8, { solid: /delet|remov|purge/i.test(entry.action) });
      }
      // One readable reference instead of a type column and an id column that
      // only mean something when read together.
      doc.font('Helvetica').fontSize(7).fillColor(MUTED)
        .text(
          [entry.entityType, entry.entityId != null ? `#${entry.entityId}` : null].filter(Boolean).join(' '),
          cols[3].x, y + 2.5, { width: cols[3].w, height: doc.currentLineHeight(), lineBreak: false, ellipsis: true },
        );
      doc.fillColor(INK);
      _rowEnd(doc, y, H);
    });

    // Stated, because the cap truncates silently and a reader has no way to
    // tell a quiet fortnight from a list that stopped early.
    return entries.length >= ACTIVITY_CAP
      ? `SHOWING THE FIRST ${ACTIVITY_CAP} ENTRIES — OLDER ACTIVITY IS NOT SHOWN`
      : _plural(entries.length, 'ENTRY').replace('ENTRYS', 'ENTRIES');
  },

  _renderTagPdf(doc, tagGroups) {
    // The per-tag LISTING repeats a multi-tagged item on purpose — that is what
    // a tag report is for. The BAND is a property-level total, so it counts
    // each item once; summing the sections was the #310 error in a second
    // place. An id-less row (a fixture, a hand-built payload) counts as itself.
    let items = 0, value = 0, rows = 0;
    const seen = new Set();
    for (const group of tagGroups) {
      for (const item of group.items || []) {
        rows += 1;
        if (item.itemId != null) {
          if (seen.has(item.itemId)) continue;
          seen.add(item.itemId);
        }
        items += 1;
        value += item.purchasePrice || 0;
      }
    }

    _band(doc, [
      { k: 'Tags', v: String(tagGroups.length) },
      { k: 'Items', v: String(items) },
      { k: 'Purchase total', v: _fmtCurrency(value) },
    ]);

    if (!tagGroups.length) return _empty(doc, 'No tagged items found.');

    for (const group of tagGroups) {
      _ensureRoom(doc, 40);
      doc.y += 8;
      const hy = doc.y;
      // The same outlined chip that prints on the physical label — a tag should
      // look like itself wherever it appears.
      _pill(doc, group.tagName || '—', M, hy, { size: 7.5 });
      const subtotal = (group.items || []).reduce((s, i) => s + (i.purchasePrice || 0), 0);
      doc.font('Courier').fontSize(6.5).fillColor(MUTED)
        .text(`${_plural((group.items || []).length, 'ITEM')} · ${_fmtCurrency(subtotal)}`,
          M, hy + 3, { width: W, height: doc.currentLineHeight(), align: 'right', lineBreak: false });
      const ruleY = hy + 14;
      doc.save().moveTo(M, ruleY).lineTo(RIGHT, ruleY).lineWidth(1.2).strokeColor(INK).stroke().restore();
      doc.fillColor(INK);
      doc.y = ruleY + 1.5;

      const H = 11;
      (group.items || []).forEach((item, i) => {
        _ensureRoom(doc, H);
        const y = _rowTop(doc, H, i % 2 === 1);
        doc.font('Helvetica').fontSize(7).fillColor(INK)
          .text(item.itemName || '-', M + 6, y + 2, { width: 230, height: doc.currentLineHeight(), lineBreak: false, ellipsis: true });
        _num(doc, _fmtCurrency(item.purchasePrice), { x: M + 242, w: 60 }, y + 2, { muted: true });
        doc.font('Helvetica').fontSize(6.5).fillColor(MUTED)
          .text([item.areaName, item.containerName].filter(Boolean).join(' › '),
            M + 310, y + 2.5, { width: W - 310, height: doc.currentLineHeight(), lineBreak: false, ellipsis: true });
        doc.fillColor(INK);
        _rowEnd(doc, y, H);
      });
    }

    return rows > items
      ? `${_plural(items, 'ITEM')} ACROSS ${_plural(tagGroups.length, 'TAG')} · ${rows} LISTINGS (MULTI-TAGGED ITEMS REPEAT)`
      : `${_plural(items, 'ITEM')} ACROSS ${_plural(tagGroups.length, 'TAG')}`;
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
            // A spreadsheet is where these numbers get summed and pasted into a
            // claim, so provenance has to survive the export as its own column —
            // the PDF's letter suffix would just corrupt the figure here.
            { id: 'valueBasis', title: 'Value Basis' },
            // Whether this row is the thing or only its box/spares. Without it
            // a spreadsheet total silently re-includes what the PDF excluded.
            { id: 'completeness', title: 'Completeness' },
            { id: 'condition', title: 'Condition' },
            { id: 'areaName', title: 'Area' },
            { id: 'containerName', title: 'Container' },
          ],
        });
        records = data.map(i => ({
          ...i,
          purchasePrice: i.purchasePrice != null ? i.purchasePrice : '',
          currentValue: i.currentValue != null ? i.currentValue : '',
          valueBasis: i.valueBasis || '',
          completeness: i.completeness || 'complete',
          condition: i.condition || '',
          brand: i.brand || '',
          productName: i.productName || '',
        }));
        break;

      case 'total_value': {
        stringifier = createObjectCsvStringifier({
          header: [
            { id: 'group', title: 'Group' },
            { id: 'itemCount', title: 'Item Count' },
            { id: 'purchaseTotal', title: 'Purchase Total' },
            { id: 'currentTotal', title: 'Current Total' },
            // Without this a spreadsheet total silently disagrees with the PDF
            // about how many things the property contains.
            { id: 'excludedCount', title: 'Excluded (box/spares)' },
          ],
        });
        const view = _totalValueView(data);
        records = view.groups.map(g => ({ ...g, excludedCount: g.excludedCount ?? 0 }));
        // The property's own total travels WITH the groups, as a labelled last
        // row. Under a tag grouping, SUM() over the column above it is not the
        // answer — a thing with three tags is in three of those rows — and a
        // spreadsheet is exactly where someone would sum it and believe the
        // result (#310).
        records.push({
          group: view.overlapping
            ? 'TOTAL (each item once — groups above overlap)'
            : 'TOTAL (each item once)',
          itemCount: view.totals.itemCount,
          purchaseTotal: view.totals.purchaseTotal,
          currentTotal: view.totals.currentTotal,
          excludedCount: view.totals.excludedCount,
        });
        break;
      }

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

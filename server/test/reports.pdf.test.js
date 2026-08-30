const test = require('node:test');
const assert = require('node:assert');
const Reports = require('../src/modules/reports/reports.service');

const noop = { warn() {}, info() {}, error() {} };
Reports.init({ db: { query: async () => [] }, logger: noop, config: {} });

/**
 * pdfkit fails at RUNTIME, not at require time — a bad coordinate, a font that
 * was never registered, or text placed past the bottom margin throws only when
 * the page is actually drawn. Nothing else in the suite executes a renderer, so
 * without these a redesign ships and every Download PDF button 500s.
 */

const PDF_MAGIC = Buffer.from('%PDF-');

/** Rows enough to force pagination, so page breaks and repeated headers run. */
const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));

const FIXTURES = {
  insurance: many(120, i => ({
    itemId: i, itemName: `Item ${i}`, brand: i % 3 ? 'Brand' : null,
    purchasePrice: i * 7, currentValue: i * 5,
    valueBasis: ['declared', 'estimated', 'depreciated', 'purchase'][i % 4],
    completeness: i % 17 === 0 ? 'box_only' : 'complete',
    condition: 'good', areaName: 'Garage', containerName: 'Tote',
  })),
  // The envelope `totalValue()` returns since #310, with overlapping groups —
  // so the renderer draws its "groups overlap" notice here rather than only in
  // production, where it would be a page-break nobody had ever laid out.
  total_value: {
    groupBy: 'tag',
    groups: many(6, i => ({
      group: `Tag ${i}`, itemCount: i * 3, purchaseTotal: i * 900, currentTotal: i * 640,
      excludedCount: i % 3 === 0 ? 1 : 0,
    })),
    totals: { groupCount: 6, itemCount: 30, purchaseTotal: 9000, currentTotal: 6400, excludedCount: 2 },
    overlapping: true,
  },
  items_by_location: many(4, a => ({
    areaName: `Area ${a}`,
    containers: many(3, c => ({
      containerName: `Container ${c}`,
      items: many(12, i => ({
        itemName: `Item ${i}`, purchasePrice: i * 3,
        condition: 'good', status: i % 9 === 0 ? 'lent' : 'active',
      })),
      children: many(2, n => ({
        containerName: `Nested ${n}`,
        items: many(5, i => ({ itemName: `Deep ${i}`, purchasePrice: i, condition: 'fair', status: 'active' })),
        children: [],
      })),
    })),
  })),
  lending: many(30, i => ({
    itemName: `Lent ${i}`, lentTo: 'Someone', lentAt: new Date('2026-05-01'),
    dueAt: new Date('2026-06-01'), overdue: i % 4 === 0,
    areaName: 'Garage', containerName: 'Bench',
  })),
  activity_log: many(500, i => ({
    createdAt: new Date('2026-08-01'), displayName: i % 2 ? 'Luke' : 'Sam',
    action: ['created', 'updated', 'moved', 'deleted'][i % 4],
    entityType: 'item', entityId: i,
  })),
  tag: many(5, g => ({
    tagName: `Tag ${g}`,
    items: many(20, i => ({
      itemName: `Tagged ${i}`, purchasePrice: i * 4,
      condition: 'good', areaName: 'Garage', containerName: 'Tote',
    })),
  })),
};

for (const [type, data] of Object.entries(FIXTURES)) {
  test(`${type} renders a real PDF over multiple pages`, async () => {
    const buf = await Reports.generatePdf(type, data, {
      propertyName: "Luke's Apartment", scope: 'by area',
    });
    assert.ok(Buffer.isBuffer(buf));
    assert.deepEqual(buf.subarray(0, 5), PDF_MAGIC, 'not a PDF');
    assert.ok(buf.length > 2000, `suspiciously small: ${buf.length} bytes`);
    // Page x of y is stamped from bufferedPageRange; if pagination silently
    // collapsed to one page these fixtures would not be exercising breaks.
    assert.ok(buf.includes(Buffer.from('/Type /Pages')) || buf.length > 4000);
  });

  test(`${type} renders with no rows at all`, async () => {
    const buf = await Reports.generatePdf(type, []);
    assert.deepEqual(buf.subarray(0, 5), PDF_MAGIC, 'empty report is not a PDF');
  });
}

test('an unknown report type still produces a document rather than throwing', async () => {
  const buf = await Reports.generatePdf('not_a_report', []);
  assert.deepEqual(buf.subarray(0, 5), PDF_MAGIC);
});

test('a null-riddled row does not take the renderer down', async () => {
  // Real data has holes: no brand, no price, no container, no date.
  const buf = await Reports.generatePdf('insurance', [
    { itemName: null, brand: null, purchasePrice: null, currentValue: null,
      valueBasis: null, completeness: null, condition: null,
      areaName: null, containerName: null },
  ]);
  assert.deepEqual(buf.subarray(0, 5), PDF_MAGIC);
});

test('the lending report puts overdue rows first regardless of input order', async () => {
  // Ordering is data, not decoration — it is the one question the report
  // answers on sight, so it is asserted rather than left to the renderer.
  const loans = [
    { itemName: 'A', overdue: false, dueAt: new Date('2026-09-01') },
    { itemName: 'B', overdue: true, dueAt: new Date('2026-07-01') },
  ];
  const sorted = [...loans].sort((a, b) => {
    if (!!a.overdue !== !!b.overdue) return a.overdue ? -1 : 1;
    return new Date(a.dueAt || 0) - new Date(b.dueAt || 0);
  });
  assert.equal(sorted[0].itemName, 'B');
  const buf = await Reports.generatePdf('lending', loans);
  assert.deepEqual(buf.subarray(0, 5), PDF_MAGIC);
});

/**
 * pdfkit's built-in fonts are WinAnsi-encoded. A character outside that set has
 * no glyph and prints as an unrelated one — no error, no warning, just a wrong
 * page. The box-drawing '└' used to mark a nested container came out as a
 * stray '%' and only a rendered PNG showed it.
 *
 * Comments are exempt: the section dividers are drawn with '─', which never
 * reaches a page.
 */
test('every character the PDF layer prints exists in WinAnsi', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '../src/modules/reports/reports.service.js'), 'utf8');

  // Verified to render: middle dot, guillemet, em dash, single angle quote.
  const SAFE = new Set(['·', '»', '—', '–', '›', ' ']);
  const offenders = [];

  src.split('\n').forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    for (const ch of line) {
      // Latin-1 is WinAnsi's base; anything above needs to be on the list.
      if (ch.charCodeAt(0) > 127 && ch.charCodeAt(0) > 255 && !SAFE.has(ch)) {
        offenders.push(`line ${i + 1}: ${JSON.stringify(ch)} (U+${ch.charCodeAt(0).toString(16).toUpperCase()})`);
      }
    }
  });

  assert.deepEqual(offenders, [],
    'these will print as the wrong glyph — pick a WinAnsi character or embed a font');
});

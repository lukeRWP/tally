const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const ReportsService = require('../src/modules/reports/reports.service');
const reportsRoutes = require('../src/modules/reports/reports.routes');
const { REPORT_TYPES, GROUP_BY } = require('../src/modules/reports/reports.schema');

// Route-level tests for POST /api/reports/_y_/generate (#263).
//
// Four of the six reports had NEVER generated a file. The client offered
// `total-value`, `by-location`, `activity` and `tags`; the Joi enum accepts
// `total_value`, `items_by_location`, `activity_log` and `tag`; and the three
// groupBy values the client offered (`location`/`tag`/`condition`) overlapped
// the server's (`property`/`area`/`tag`) in exactly one place. Every miss came
// back as a 422 toast. The service was never at fault — all six types have a
// fetch branch, a PDF renderer and a CSV branch — so the fix was to make the
// client speak the service's vocabulary, and this file is what stops the two
// ends drifting apart again silently.
//
// Idiom from labels.routes.test.js / matches.routes.test.js: a real Express app
// with the real reports.routes.js, so the route's own Joi validation runs for
// real; only ReportsService is mocked, per test, with t.mock.method.
//
// CLIENT_OFFERS below is the literal contents of REPORT_TYPES/REPORT_GROUP_BY
// in client/src/pages/reports.tsx + client/src/hooks/use-reports.ts. It is
// deliberately spelled out rather than derived: the whole bug was two lists
// that agreed in nobody's head, so this one has to be readable next to the page
// it mirrors.
const CLIENT_OFFERS = Object.freeze({
  reportTypes: ['insurance', 'total_value', 'items_by_location', 'lending', 'activity_log', 'tag'],
  // `condition` is here because the server implements it now (#285) — the
  // grouping key became a function of an item row rather than a SELECT of its
  // own, so a fourth grouping is a fourth key extractor. It is the one value on
  // this list that once shipped to users doing nothing at all.
  groupBy: ['property', 'area', 'tag', 'condition'],
});

// …and because a hand-copy is exactly what went wrong the first time, the two
// client files that define those lists are read back and compared below. Change
// either end of the contract and this suite goes red, which is the only reason
// this file exists.
const fs = require('fs');
const path = require('path');

const CLIENT = (...p) => path.join(__dirname, '..', '..', 'client', 'src', ...p);

/** Pull the quoted strings out of `src` between `start` and the next `end`. */
function extractStrings(src, start, end, what) {
  const from = src.indexOf(start);
  assert.notEqual(from, -1, `could not find ${what} — has the client been refactored?`);
  const to = src.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `could not find the end of ${what}`);
  const found = src.slice(from, to).match(/'([a-z_]+)'/g);
  assert.ok(found && found.length, `found no strings in ${what}`);
  return found.map(s => s.slice(1, -1));
}

const logger = { warn() {}, info() {}, error() {} };

function makeApp({ db = { query: async () => [] }, role = 'owner' } = {}) {
  const app = express();
  app.use(express.json());
  app.locals.requireAuth = (req, res, next) => { req.user = { id: 42 }; next(); };
  // The real resolvePropertyRole reads property_members; the route only cares
  // that req.propertyRole is set, and 403s when it is not.
  app.locals.resolvePropertyRole = (req, res, next) => { req.propertyRole = role; next(); };
  reportsRoutes({ app, db, logger, config: {} });
  return app;
}

/** Run fn against a live ephemeral listener, always closing it after. */
async function withServer(fn, opts) {
  const server = makeApp(opts).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

const generate = (base, body) => fetch(`${base}/api/reports/_y_/generate`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** Stub the data + document layers so these tests are about dispatch only. */
function stubService(t) {
  t.mock.method(ReportsService, '_fetchReportData', async () => [{ group: 'Total' }]);
  t.mock.method(ReportsService, 'getPropertyName', async () => 'Home');
  t.mock.method(ReportsService, 'generatePdf', async () => Buffer.from('%PDF-fake'));
  t.mock.method(ReportsService, 'generateCsv', () => 'Group\nTotal\n');
}

// ── the contract itself ─────────────────────────────────────────────────────

test('the schema and the preview route share ONE list — no second copy to drift', () => {
  // reports.routes.js used to hard-code its own `validTypes` array for the
  // preview endpoint. Both ends now read REPORT_TYPES.
  assert.deepEqual([...REPORT_TYPES], CLIENT_OFFERS.reportTypes);
  assert.deepEqual([...GROUP_BY], CLIENT_OFFERS.groupBy);
  assert.ok(Object.isFrozen(REPORT_TYPES) && Object.isFrozen(GROUP_BY));
});

test('the CLIENT still speaks exactly this vocabulary — read back from its source', () => {
  // The bug this suite exists for was invisible to every server-side test,
  // because the server was self-consistent and the client was the other half of
  // the contract. Nothing links the two trees at build time, so the link is
  // made here: if reports.tsx or use-reports.ts stops matching the Joi enum,
  // `npm test` in server/ fails and nobody ships a 422 to a Generate button.
  const hook = fs.readFileSync(CLIENT('hooks', 'use-reports.ts'), 'utf8');
  const page = fs.readFileSync(CLIENT('pages', 'reports.tsx'), 'utf8');

  const unionIds = extractStrings(hook, 'export type ReportTypeId =', ';', 'the ReportTypeId union');
  assert.deepEqual(unionIds, [...REPORT_TYPES],
    'the client\'s ReportTypeId union has drifted from the server\'s Joi enum');

  const groupBy = extractStrings(hook, 'export const REPORT_GROUP_BY = [', ']', 'REPORT_GROUP_BY');
  assert.deepEqual(groupBy, [...GROUP_BY],
    'the client\'s groupBy options have drifted from the server\'s Joi enum');

  // The page's own six rows — the ids actually posted by Generate. tsc already
  // proves each is a member of the union; this proves all six are still there.
  const pageIds = (page.match(/^\s{4}id: '([a-z_]+)',$/gm) || []).map(m => m.match(/'([a-z_]+)'/)[1]);
  assert.deepEqual(pageIds, [...REPORT_TYPES],
    'the /reports page no longer offers exactly the six server report types');
});

test('EVERY report id the client offers is accepted and reaches the service', async (t) => {
  stubService(t);
  const seen = [];
  ReportsService._fetchReportData.mock.mockImplementation(async (reportType) => {
    seen.push(reportType);
    return [];
  });

  await withServer(async (base) => {
    for (const reportType of CLIENT_OFFERS.reportTypes) {
      const res = await generate(base, { reportType, propertyId: 1 });
      assert.equal(res.status, 200, `${reportType} must not 422 — the client's Generate button posts this exact string`);
      assert.equal(res.headers.get('content-type'), 'application/pdf');
      assert.ok((await res.arrayBuffer()).byteLength > 0, `${reportType} returned an empty body`);
    }
  });

  assert.deepEqual(seen, CLIENT_OFFERS.reportTypes,
    'each id must dispatch to the service under its own name, not be coerced');
});

test('EVERY groupBy the client offers is accepted and forwarded verbatim', async (t) => {
  stubService(t);
  const seen = [];
  ReportsService._fetchReportData.mock.mockImplementation(async (reportType, propertyId, opts) => {
    seen.push(opts.groupBy);
    return [];
  });

  await withServer(async (base) => {
    for (const groupBy of CLIENT_OFFERS.groupBy) {
      const res = await generate(base, { reportType: 'total_value', propertyId: 1, groupBy });
      assert.equal(res.status, 200, `groupBy=${groupBy} must not 422`);
    }
  });

  assert.deepEqual(seen, CLIENT_OFFERS.groupBy);
});

test('every client id generates a CSV too, not just a PDF', async (t) => {
  stubService(t);

  await withServer(async (base) => {
    for (const reportType of CLIENT_OFFERS.reportTypes) {
      const res = await generate(base, { reportType, propertyId: 1, format: 'csv' });
      assert.equal(res.status, 200, `${reportType} csv`);
      assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8');
      assert.match(res.headers.get('content-disposition'), new RegExp(`tally-${reportType}-report\\.csv`));
      assert.ok((await res.text()).length > 0, `${reportType} produced an empty CSV`);
    }
  });
});

// ── the spellings that used to be sent ──────────────────────────────────────

test('the four hyphenated ids that shipped in the bundle are still rejected', async (t) => {
  const fetchData = t.mock.method(ReportsService, '_fetchReportData', async () => { throw new Error('must not run'); });

  await withServer(async (base) => {
    for (const reportType of ['total-value', 'by-location', 'activity', 'tags']) {
      const res = await generate(base, { reportType, propertyId: 1 });
      assert.equal(res.status, 422, `${reportType} is not a report type`);
      const json = await res.json();
      assert.equal(json.success, false);
      assert.equal(json.message, 'Validation failed');
    }
  });

  assert.equal(fetchData.mock.callCount(), 0, 'an invalid type must never reach the service');
});

test('a groupBy with no implementation is still rejected rather than substituted', async (t) => {
  stubService(t);

  // `location` is the client's old name for `area`; `category` never existed.
  // `condition` used to be on this list and has been implemented (#285) — the
  // rule is unchanged, only its membership: a grouping the server cannot
  // perform must 422, never quietly become `property`.
  await withServer(async (base) => {
    for (const groupBy of ['location', 'category']) {
      const res = await generate(base, { reportType: 'total_value', propertyId: 1, groupBy });
      assert.equal(res.status, 422, `groupBy=${groupBy} has no implementation and must not be accepted`);
    }
  });
});

test('the PREVIEW takes the same groupBy, and rejects one it cannot perform', async (t) => {
  // #310's secondary half: this route defaulted to `property` for anything it
  // was sent, and the hook sent nothing — so the figure printed beside Generate
  // was computed for a different grouping than the one about to be generated.
  const seen = [];
  t.mock.method(ReportsService, '_fetchReportData', async (type, id, opts) => { seen.push(opts.groupBy); return []; });

  await withServer(async (base) => {
    for (const groupBy of CLIENT_OFFERS.groupBy) {
      const res = await fetch(`${base}/api/reports/_x_/preview/total_value/1?groupBy=${groupBy}`);
      assert.equal(res.status, 200, `preview groupBy=${groupBy}`);
    }
    const bad = await fetch(`${base}/api/reports/_x_/preview/total_value/1?groupBy=location`);
    assert.equal(bad.status, 400, 'an unknown grouping must not silently become "property"');
  });

  assert.deepEqual(seen, CLIENT_OFFERS.groupBy);
});

// ── defaults and guards the client depends on ───────────────────────────────

test('an omitted groupBy defaults to property rather than undefined', async (t) => {
  stubService(t);
  let seen = 'unset';
  ReportsService._fetchReportData.mock.mockImplementation(async (type, id, opts) => { seen = opts.groupBy; return []; });

  await withServer(async (base) => {
    // The five non-total_value reports send no groupBy at all (the client
    // drops the key), so the default has to survive that.
    const res = await generate(base, { reportType: 'insurance', propertyId: 1 });
    assert.equal(res.status, 200);
  });

  assert.equal(seen, 'property');
});

test('the tag report accepts an empty tagIds array — "all tags" is a real request', async (t) => {
  stubService(t);
  let seen = 'unset';
  ReportsService._fetchReportData.mock.mockImplementation(async (type, id, opts) => { seen = opts.tagIds; return []; });

  await withServer(async (base) => {
    const res = await generate(base, { reportType: 'tag', propertyId: 1, tagIds: [] });
    assert.equal(res.status, 200);
  });

  assert.deepEqual(seen, []);
});

test('a non-member is 403d after validation and never reaches the service', async (t) => {
  const fetchData = t.mock.method(ReportsService, '_fetchReportData', async () => { throw new Error('must not run'); });

  await withServer(async (base) => {
    const res = await generate(base, { reportType: 'insurance', propertyId: 1 });
    assert.equal(res.status, 403);
  }, { role: null });

  assert.equal(fetchData.mock.callCount(), 0);
});

test('the preview route accepts the same six ids and rejects the hyphenated ones', async (t) => {
  t.mock.method(ReportsService, '_fetchReportData', async () => []);

  await withServer(async (base) => {
    for (const reportType of CLIENT_OFFERS.reportTypes) {
      const res = await fetch(`${base}/api/reports/_x_/preview/${reportType}/1`);
      assert.equal(res.status, 200, `${reportType} preview`);
    }
    for (const reportType of ['total-value', 'by-location', 'activity', 'tags']) {
      const res = await fetch(`${base}/api/reports/_x_/preview/${reportType}/1`);
      assert.equal(res.status, 400, `${reportType} preview must be rejected`);
    }
  });
});

// ── end to end: real renderers, only the SQL layer stubbed ──────────────────
//
// The tests above prove the contract; this one proves a real document comes out
// the other end. _fetchReportData is stubbed with the same fixture shapes the
// service returns (see reports.pdf.test.js), and generatePdf/generateCsv are
// the real thing — so the whole dispatch → renderer → response chain runs for
// all six types, which is what nobody had ever driven end to end.

const FIXTURES = {
  insurance: [{
    itemId: 1, itemName: 'Drill', brand: 'DeWalt', productName: 'DCD777',
    purchasePrice: 129, currentValue: 90, valueBasis: 'declared',
    completeness: 'complete', condition: 'good', areaName: 'Garage', containerName: 'Tote',
  }],
  // An envelope, not a list: the groups can overlap (an item with three tags is
  // in three of them) so the property's own totals travel beside them (#310).
  total_value: {
    groupBy: 'tag',
    groups: [
      { group: 'Tools', itemCount: 12, purchaseTotal: 2400, currentTotal: 1780, excludedCount: 1 },
      { group: 'Untagged', itemCount: 3, purchaseTotal: 300, currentTotal: 210, excludedCount: 0 },
    ],
    totals: { groupCount: 2, itemCount: 14, purchaseTotal: 2600, currentTotal: 1900, excludedCount: 1 },
    overlapping: true,
  },
  items_by_location: [{
    areaId: 1, areaName: 'Garage',
    containers: [{
      containerId: 1, containerName: 'Tote',
      items: [{ itemId: 1, itemName: 'Drill', purchasePrice: 129, condition: 'good', status: 'active' }],
      children: [],
    }],
  }],
  lending: [{
    lendingId: 1, itemId: 1, itemName: 'Drill', lentTo: 'Sam',
    lentAt: new Date('2026-05-01'), dueAt: new Date('2026-06-01'), overdue: true,
    areaName: 'Garage', containerName: 'Tote', notes: null,
  }],
  activity_log: [{
    id: 1, userId: 42, displayName: 'Luke', entityType: 'item',
    entityId: 1, action: 'updated', changes: {}, createdAt: new Date('2026-08-01'),
  }],
  tag: [{
    tagId: 1, tagName: 'Tools', tagColor: '#f60',
    items: [{ itemId: 1, itemName: 'Drill', purchasePrice: 129, condition: 'good', areaName: 'Garage', containerName: 'Tote' }],
  }],
};

const PDF_MAGIC = Buffer.from('%PDF-');

test('all six report types produce a real, non-empty document over HTTP', async (t) => {
  t.mock.method(ReportsService, 'getPropertyName', async () => "Luke's Apartment");
  t.mock.method(ReportsService, '_fetchReportData', async (reportType) => FIXTURES[reportType]);

  await withServer(async (base) => {
    for (const reportType of CLIENT_OFFERS.reportTypes) {
      const pdf = await generate(base, { reportType, propertyId: 1, format: 'pdf' });
      assert.equal(pdf.status, 200, `${reportType} pdf`);
      const buf = Buffer.from(await pdf.arrayBuffer());
      assert.deepEqual(buf.subarray(0, 5), PDF_MAGIC, `${reportType} did not answer a PDF`);
      assert.ok(buf.length > 2000, `${reportType} PDF suspiciously small: ${buf.length} bytes`);

      const csv = await generate(base, { reportType, propertyId: 1, format: 'csv' });
      assert.equal(csv.status, 200, `${reportType} csv`);
      const text = await csv.text();
      // A header row plus at least one data row — an empty document would pass
      // a bare "status 200" assertion and still be the bug.
      assert.ok(text.split('\n').filter(Boolean).length >= 2,
        `${reportType} CSV had no data rows: ${JSON.stringify(text)}`);
    }
  });
});

test('total_value renders a document for every groupBy, and names the scope in the header', async (t) => {
  t.mock.method(ReportsService, 'getPropertyName', async () => 'Home');
  const scopes = [];
  t.mock.method(ReportsService, '_fetchReportData', async () => FIXTURES.total_value);
  const pdf = t.mock.method(ReportsService, 'generatePdf', async (type, data, ctx) => {
    scopes.push(ctx.scope);
    return Buffer.from('%PDF-fake');
  });

  await withServer(async (base) => {
    for (const groupBy of CLIENT_OFFERS.groupBy) {
      const res = await generate(base, { reportType: 'total_value', propertyId: 1, groupBy });
      assert.equal(res.status, 200);
    }
  });

  assert.equal(pdf.mock.callCount(), CLIENT_OFFERS.groupBy.length);
  assert.deepEqual(scopes, CLIENT_OFFERS.groupBy.map(g => `by ${g}`));
});

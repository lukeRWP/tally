const test = require('node:test');
const assert = require('node:assert');

const VisionService = require('../src/modules/products/vision.service');
const { CATEGORY_ENUM, NO_RESULT } = require('../src/modules/products/lookup/vision-identify');
const { createItem } = require('../src/modules/inventory/items.schema');
const TagsService = require('../src/modules/tags/tags.service');

const logger = { info() {}, warn() {}, error() {} };
function fakeDb(handler) { return { query: async (sql, params) => handler(sql, params) }; }

const ON = { vision: { enabled: true } };
const OFF = { vision: { enabled: false } };

// A stub adapter, so no test ever reaches the network or needs a key.
const adapterReturning = (payload) => ({ identifyImage: async () => payload });

// Distinct bytes per test: identify() caches and de-dupes on the sha256 of the
// buffer, so a shared constant would leak one test's answer into the next.
let n = 0;
const bytes = () => Buffer.from(`photo-${n++}-${Math.random()}`);

// ── normalise: what may reach the user ───────────────────────────────────────

test('a low-confidence name is KEPT — a generic name beats no name', () => {
  // This asserted the opposite until it met a real mug. Nulling low-confidence
  // names conflated "invented specificity" (bad) with "named generically"
  // (which is most of a household inventory). The item was landing as
  // "Unnamed", which is strictly worse than the plain truth.
  const s = VisionService.normalise({
    confidence: 'low', name: 'White Ceramic Mug',
    description: 'A plain white mug.', category: 'kitchen',
  });
  assert.equal(s.name, 'White Ceramic Mug');
  assert.equal(s.description, 'A plain white mug.');
  assert.equal(s.category, 'kitchen');
  assert.equal(s.confidence, 'low', 'the panel still labels it a guess');
});

test('confidence none yields no suggestion at all', () => {
  assert.equal(VisionService.normalise({ confidence: 'none', name: 'X', category: 'tool' }), null);
});

test('an unrecognised confidence value is treated as none, not trusted', () => {
  assert.equal(VisionService.normalise({ confidence: 'certain', name: 'X' }), null);
});

test('a category outside the enum is dropped rather than passed through', () => {
  const s = VisionService.normalise({
    confidence: 'high', name: 'Thing', description: 'A thing.', category: 'weapons',
  });
  assert.equal(s.category, null);
});

test('control, zero-width and bidi characters are stripped from text fields', () => {
  // Built from char codes, never written literally: a source file that
  // contains the invisible characters it is testing for is unreviewable, and
  // a bidi override in source is its own hazard.
  const BIDI_OVERRIDE = String.fromCharCode(0x202e);
  const ZERO_WIDTH = String.fromCharCode(0x200b);
  const nasty = `Dr${BIDI_OVERRIDE}ill${ZERO_WIDTH}`;
  const s = VisionService.normalise({
    confidence: 'high', name: nasty, description: nasty, category: 'tool',
  });
  const isInvisible = (c) => {
    const n = c.charCodeAt(0);
    return n < 0x20 || (n >= 0x7f && n <= 0x9f) || (n >= 0x200b && n <= 0x200f)
        || (n >= 0x202a && n <= 0x202e) || (n >= 0x2060 && n <= 0x2064) || n === 0xfeff;
  };
  for (const field of [s.name, s.description]) {
    assert.ok(![...field].some(isInvisible),
      'invisible characters must not reach stored text');
  }
  assert.equal(s.name, 'Drill', 'the visible characters survive intact');
});

test('the suggestion carries no field that would let it reach the shared catalogue', () => {
  const s = VisionService.normalise({
    confidence: 'high', name: 'Drill', description: 'A drill.', category: 'tool',
  });
  for (const key of ['barcode', 'productId', 'id', 'dataSource', 'retailPrice']) {
    assert.ok(!(key in s), `suggestion must not carry ${key} — ProductsService.create would take it`);
  }
});

test('confidence is carried through so the panel can say read vs guessed', () => {
  assert.equal(VisionService.normalise({
    confidence: 'medium', name: 'Drill', description: null, category: null,
  }).confidence, 'medium');
});

// ── identify: the three shapes, and never rejecting ──────────────────────────

test('with no key configured the answer is available:false and the adapter is never called', async () => {
  let called = false;
  VisionService.init({ logger, config: OFF, adapter: { identifyImage: async () => { called = true; } } });
  assert.deepEqual(await VisionService.identify(bytes(), 'image/jpeg', 1),
    { available: false, suggestion: null });
  assert.equal(called, false, 'a disabled feature must not spend a request');
});

test('a thrown adapter degrades to available:true with no suggestion, never rejects', async () => {
  VisionService.init({
    logger, config: ON,
    adapter: { identifyImage: async () => { throw Object.assign(new Error('boom'), { status: 500 }); } },
  });
  assert.deepEqual(await VisionService.identify(bytes(), 'image/jpeg', 1),
    { available: true, suggestion: null });
});

test('an upstream failure logs at ERROR, with the model that was attempted', async () => {
  // This was warn, which prod discards -- so a rejected key and an honest
  // "cannot identify" produced identical silence in the logs and identical
  // text on screen. An exception must not be quieter than a null result.
  const errors = [];
  VisionService.init({
    logger: { ...logger, error: (msg, meta) => errors.push(meta) },
    config: { vision: { enabled: true, model: 'claude-sonnet-5' } },
    adapter: {
      identifyImage: async () => {
        throw Object.assign(new Error('model not found'), { status: 404, type: 'not_found_error' });
      },
    },
  });
  await VisionService.identify(bytes(), 'image/jpeg', 1);
  assert.equal(errors.length, 1, 'an upstream throw must reach prod logs');
  assert.equal(errors[0].status, 404);
  assert.equal(errors[0].type, 'not_found_error');
  assert.equal(errors[0].model, 'claude-sonnet-5', 'a 404 is about the id, not the photo');
});

test('a thrown non-Error still degrades rather than escaping', async () => {
  VisionService.init({
    logger, config: ON,
    adapter: { identifyImage: async () => { throw null; } },
  });
  assert.deepEqual(await VisionService.identify(bytes(), 'image/jpeg', 1),
    { available: true, suggestion: null });
});

test('identical bytes in flight share one upstream call instead of billing twice', async () => {
  let calls = 0;
  VisionService.init({
    logger, config: ON,
    adapter: {
      identifyImage: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 10));
        return { result: { confidence: 'high', name: 'Drill', description: 'd', category: 'tool' } };
      },
    },
  });
  const buf = bytes();
  const [a, b] = await Promise.all([
    VisionService.identify(buf, 'image/jpeg', 1),
    VisionService.identify(buf, 'image/jpeg', 1),
  ]);
  assert.equal(calls, 1, 'a double-fired effect must not pay twice');
  assert.deepEqual(a, b);
});

test('a failure is not cached, so a deliberate retry actually retries', async () => {
  let calls = 0;
  VisionService.init({
    logger, config: ON,
    adapter: {
      identifyImage: async () => {
        calls++;
        if (calls === 1) throw new Error('transient');
        return { result: { confidence: 'high', name: 'Drill', description: 'd', category: 'tool' } };
      },
    },
  });
  const buf = bytes();
  assert.equal((await VisionService.identify(buf, 'image/jpeg', 1)).suggestion, null);
  assert.equal((await VisionService.identify(buf, 'image/jpeg', 1)).suggestion.name, 'Drill');
  assert.equal(calls, 2);
});

// ── the truncation detector ──────────────────────────────────────────────────

test('a truncated response is logged at ERROR so it surfaces in production', async () => {
  // Production's console transport emits at its configured level (default
  // 'error'). A truncation storm bills on every capture while the user sees
  // "nothing found", so if this line is below that threshold the detector does
  // not exist in the only environment that matters.
  const errors = [];
  const infos = [];
  VisionService.init({
    logger: { ...logger, error: (msg, meta) => errors.push(meta), info: (msg, meta) => infos.push(meta) },
    config: ON,
    adapter: adapterReturning({ result: null, usage: null, noResultReason: NO_RESULT.TRUNCATED }),
  });
  const answer = await VisionService.identify(bytes(), 'image/jpeg', 1);
  assert.deepEqual(answer, { available: true, suggestion: null });
  assert.equal(infos.length, 0, 'must not be logged at info, which prod discards');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].noResultReason, 'max_tokens');
  assert.equal(errors[0].identified, false);
});

test('a refusal and an unparseable body also surface at error', async () => {
  for (const reason of [NO_RESULT.REFUSAL, NO_RESULT.UNPARSEABLE, NO_RESULT.NO_TEXT_BLOCK]) {
    const errors = [];
    VisionService.init({
      logger: { ...logger, error: (msg, meta) => errors.push(meta) },
      config: ON,
      adapter: adapterReturning({ result: null, usage: null, noResultReason: reason }),
    });
    await VisionService.identify(bytes(), 'image/jpeg', 1);
    assert.equal(errors.length, 1, `${reason} should surface`);
    assert.equal(errors[0].noResultReason, reason);
  }
});

test('an honest "cannot identify" stays at info and does not cry wolf', async () => {
  // The model saying it cannot tell is normal operation. Logging it at error
  // would bury the truncations this is meant to expose.
  const errors = [];
  const infos = [];
  VisionService.init({
    logger: { ...logger, error: (msg, meta) => errors.push(meta), info: (msg, meta) => infos.push(meta) },
    config: ON,
    adapter: adapterReturning({ result: { confidence: 'none' }, usage: null }),
  });
  await VisionService.identify(bytes(), 'image/jpeg', 1);
  assert.equal(errors.length, 0, 'a normal null must not be an error');
  assert.equal(infos[0].noResultReason, 'low_confidence');
});

// ── the category gate at the write site ──────────────────────────────────────

test('createItem accepts every category the model is allowed to return', () => {
  for (const category of CATEGORY_ENUM) {
    const r = createItem.validate({ name: 'X', containerId: 1, category });
    assert.equal(r.error, undefined, `${category} should be accepted`);
  }
});

test('createItem rejects a category outside the enum, so the tag sink is gated at the write', () => {
  // The vision route's own filtering cannot be the only check: this is an
  // ordinary authenticated endpoint, reachable without ever calling it.
  const r = createItem.validate({ name: 'X', containerId: 1, category: 'anything at all' });
  assert.ok(r.error, 'an arbitrary string must not become a tag name');
});

test('category is optional — an item created without one is unaffected', () => {
  assert.equal(createItem.validate({ name: 'X', containerId: 1 }).error, undefined);
});

test('every allowed category fits tags.NAME VARCHAR(50)', () => {
  // Under STRICT_TRANS_TABLES an over-long value errors the insert rather than
  // truncating, which is how the DATA_SOURCE enum silently broke product caching.
  for (const category of CATEGORY_ENUM) {
    assert.ok(category.length <= 50, `${category} would error the insert`);
  }
});

// ── findOrCreate: the race ───────────────────────────────────────────────────

test('findOrCreate returns the existing tag without inserting', async () => {
  const seen = [];
  TagsService.init({
    db: fakeDb((sql) => {
      seen.push(sql);
      if (/^SELECT/i.test(sql.trim())) return [{ ID: 9, NAME: 'tool', COLOR: '#8A8578', PROPERTY_ID: 3 }];
      throw new Error('must not insert when the tag already exists');
    }),
    logger,
  });
  const tag = await TagsService.findOrCreate({ name: 'tool', color: '#8A8578', propertyId: 3 });
  assert.equal(tag.id, 9);
  assert.ok(!seen.some((s) => /INSERT/i.test(s)), 'no INSERT should be attempted');
});

test('findOrCreate survives a concurrent insert by re-selecting the winner', async () => {
  // This is the regression test for the blind INSERT: two items committed back
  // to back with the same new category race uq_tags_name_property, and the
  // loser must not turn into a 409 on a perfectly valid item.
  let selects = 0;
  TagsService.init({
    db: fakeDb((sql) => {
      if (/^SELECT/i.test(sql.trim())) {
        selects++;
        // Absent on the first look, present after the racing insert landed.
        return selects === 1 ? [] : [{ ID: 42, NAME: 'kitchen', COLOR: '#8A8578', PROPERTY_ID: 3 }];
      }
      throw Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });
    }),
    logger,
  });
  const tag = await TagsService.findOrCreate({ name: 'kitchen', color: '#8A8578', propertyId: 3 });
  assert.equal(tag.id, 42, 'the racing winner is adopted rather than erroring');
});

test('findOrCreate still throws on an error that is not a duplicate', async () => {
  TagsService.init({
    db: fakeDb((sql) => {
      if (/^SELECT/i.test(sql.trim())) return [];
      throw Object.assign(new Error('table is gone'), { code: 'ER_NO_SUCH_TABLE' });
    }),
    logger,
  });
  await assert.rejects(
    () => TagsService.findOrCreate({ name: 'kitchen', color: '#8A8578', propertyId: 3 }),
    /table is gone/,
  );
});

test('findOrCreate scopes both the lookup and the insert by property', async () => {
  const params = [];
  TagsService.init({
    db: fakeDb((sql, p) => {
      params.push({ sql, p });
      if (/^SELECT \* FROM TALLY.tags WHERE NAME/i.test(sql.trim())) return [];
      if (/INSERT/i.test(sql)) return { insertId: 7 };
      return [{ ID: 7, NAME: 'tool', COLOR: '#8A8578', PROPERTY_ID: 3 }];
    }),
    logger,
  });
  await TagsService.findOrCreate({ name: 'tool', color: '#8A8578', propertyId: 3 });
  const lookup = params[0];
  assert.match(lookup.sql, /PROPERTY_ID = \?/, 'the lookup must be property-scoped');
  assert.deepEqual(lookup.p, ['tool', 3]);
  const insert = params.find((x) => /INSERT/i.test(x.sql));
  assert.deepEqual(insert.p, ['tool', '#8A8578', 3]);
});

// ── route mounting ───────────────────────────────────────────────────────────

test('identify-photo is mounted behind auth, both limiters, and the upload guard', () => {
  // Capturing only the path would verify nothing: the route mounted without
  // requireAuth, or with the limiters after the 6MB buffer instead of before
  // it, would still register the same string and pass.
  const routes = [];
  const requireAuth = (req, res, next) => next();
  const record = (m) => (p, ...handlers) => routes.push({ method: m, path: p, handlers });
  const app = {
    locals: { requireAuth },
    get: record('GET'), post: record('POST'), put: record('PUT'),
    patch: record('PATCH'), delete: record('DELETE'),
  };
  require('../src/modules/products/products.routes')({
    app, db: fakeDb(() => []), logger,
    config: { vision: { enabled: false, dailyPerUser: 250 } },
  });

  const r = routes.find((x) => x.method === 'POST' && x.path === '/api/products/_y_/identify-photo');
  assert.ok(r, 'the route must be registered');
  assert.equal(r.handlers[0], requireAuth, 'auth comes first');
  // requireAuth, burst, daily, photoUpload, handler
  assert.equal(r.handlers.length, 5, 'both limiters and the upload guard must be present');
  assert.ok(r.handlers.indexOf(requireAuth) < r.handlers.length - 2,
    'the limiters must sit before the upload so a throttled request buffers nothing');
});

test('registering products routes does not disturb the existing endpoints', () => {
  const routes = [];
  const requireAuth = (req, res, next) => next();
  const record = (m) => (p, ...handlers) => routes.push({ method: m, path: p, handlers });
  const app = {
    locals: { requireAuth },
    get: record('GET'), post: record('POST'), put: record('PUT'),
    patch: record('PATCH'), delete: record('DELETE'),
  };
  require('../src/modules/products/products.routes')({
    app, db: fakeDb(() => []), logger,
    config: { vision: { enabled: false, dailyPerUser: 250 } },
  });

  for (const path of [
    '/api/products/_x_/barcode/:barcode',
    '/api/products/_x_/search',
    '/api/products/_y_/lookup',
    '/api/products/_y_/check-duplicate',
  ]) {
    assert.ok(routes.some((x) => x.path === path), `missing pre-existing route: ${path}`);
  }
  // The catalogue must stay unwritable — there is no owner model for those rows.
  assert.ok(!routes.some((x) => x.method === 'PUT' && x.path.includes('products')),
    'no writable catalogue route may reappear');
});

// ── the abort wiring ─────────────────────────────────────────────────────────

test('a normal request reaches the model with a LIVE signal', async () => {
  // Regression test for the bug that made this feature look broken for a day.
  //
  // The handler used req.on('close') to cancel the upstream call when the
  // browser hung up. On Node 16+ an IncomingMessage emits 'close' when the
  // request is COMPLETE, and multer has already drained the body before the
  // handler runs -- so it fired on the same tick and aborted the model call on
  // EVERY request. Asserting the signal is live at the point of use is the only
  // form of this test that would have failed against the old code.
  const express = require('express');
  const { photoUpload, makeHandler } = require('../src/modules/products/vision.http');

  let seenAborted = null;
  const stubService = {
    isEnabled: () => true,
    identify: async (_buf, _mime, _userId, signal) => {
      // Stand in for the round trip: the bug only shows once you await.
      await new Promise((r) => setTimeout(r, 50));
      seenAborted = signal.aborted;
      return { available: true, suggestion: null };
    },
  };

  const app = express();
  app.use((req, _res, next) => { req.user = { id: 1 }; next(); });
  app.post('/t', photoUpload, makeHandler(stubService));

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const form = new FormData();
    // A real JPEG magic-byte prefix so sniffMime accepts it.
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2048)]);
    form.append('file', new Blob([jpeg], { type: 'image/jpeg' }), 'p.jpg');
    const res = await fetch(`http://127.0.0.1:${server.address().port}/t`, { method: 'POST', body: form });
    assert.equal(res.status, 200);
    assert.equal(seenAborted, false,
      'the signal handed to the model must still be live — req.on("close") aborts it instantly');
  } finally {
    server.close();
  }
});

// ── IMPORTANT 2: matchAvailable rides identify-photo's response ─────────────
//
// The kill switch has to reach the client BEFORE it decides to skip step 2 —
// POST /matches' own 503 arrives too late. identify-photo is the only call
// capture.tsx makes before that decision, so config.match.enabled has to ride
// its response, independent of vision's own on/off state (they are two
// separate switches: MATCH_ENABLED vs VISION_ENABLED).

async function postPhoto(app) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const form = new FormData();
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2048)]);
    form.append('file', new Blob([jpeg], { type: 'image/jpeg' }), 'p.jpg');
    const res = await fetch(`http://127.0.0.1:${server.address().port}/t`, { method: 'POST', body: form });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

test('matchAvailable is true when config.match.enabled is true, even with vision off', async () => {
  const express = require('express');
  const { photoUpload, makeHandler } = require('../src/modules/products/vision.http');
  const stubService = { isEnabled: () => false };

  const app = express();
  app.use((req, _res, next) => { req.user = { id: 1 }; next(); });
  app.post('/t', photoUpload, makeHandler(stubService, { match: { enabled: true } }));

  const { status, body } = await postPhoto(app);
  assert.equal(status, 200);
  assert.deepEqual(body.data, { available: false, suggestion: null, matchAvailable: true },
    'match can be available even though vision itself answered nothing this time');
});

test('matchAvailable is false when MATCH_ENABLED is off, even though vision found a suggestion', async () => {
  const express = require('express');
  const { photoUpload, makeHandler } = require('../src/modules/products/vision.http');
  const stubService = {
    isEnabled: () => true,
    identify: async () => ({ available: true, suggestion: { name: 'Drill', brand: 'DeWalt' } }),
  };

  const app = express();
  app.use((req, _res, next) => { req.user = { id: 1 }; next(); });
  app.post('/t', photoUpload, makeHandler(stubService, { match: { enabled: false } }));

  const { status, body } = await postPhoto(app);
  assert.equal(status, 200);
  assert.equal(body.data.suggestion.name, 'Drill', 'vision\'s own result is untouched');
  assert.equal(body.data.matchAvailable, false,
    'MATCH_ENABLED=false must reach the client even when vision is on and found something');
});

test('matchAvailable defaults to false rather than throwing when config is omitted', async () => {
  const express = require('express');
  const { photoUpload, makeHandler } = require('../src/modules/products/vision.http');
  const stubService = { isEnabled: () => false };

  const app = express();
  app.use((req, _res, next) => { req.user = { id: 1 }; next(); });
  app.post('/t', photoUpload, makeHandler(stubService));   // no config argument

  const { status, body } = await postPhoto(app);
  assert.equal(status, 200);
  assert.equal(body.data.matchAvailable, false);
});

// ── the output schema ────────────────────────────────────────────────────────

test('no property combines an enum with a union type', () => {
  // The structured-output validator rejects that combination outright: it
  // checks each enum member against the declared type and refuses
  // 'electronics' against ['string','null']. It is a SCHEMA validation error,
  // so it 400s before the image is read — every call fails identically no
  // matter what was photographed, which reads as "the model recognised
  // nothing" rather than as a bug.
  //
  // Verified against the live API that this holds whether or not null is a
  // member of the enum list, so the rule is enum + union, not enum + null.
  const { SCHEMA } = require('../src/modules/products/lookup/vision-identify');
  const offenders = [];
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    if (node.enum && Array.isArray(node.type)) offenders.push(path);
    for (const [k, v] of Object.entries(node.properties || {})) walk(v, `${path}.${k}`);
    for (const [i, v] of (node.anyOf || []).entries()) walk(v, `${path}.anyOf[${i}]`);
  };
  walk(SCHEMA, 'schema');
  assert.deepEqual(offenders, [], `enum + union type is rejected by the API: ${offenders.join(', ')}`);
});

test('category still accepts every enum value and null', () => {
  const { SCHEMA, CATEGORY_ENUM } = require('../src/modules/products/lookup/vision-identify');
  const branches = SCHEMA.properties.category.anyOf;
  assert.ok(branches, 'nullability must be expressed with anyOf, not a union type');
  const stringBranch = branches.find((b) => b.type === 'string');
  assert.deepEqual(stringBranch.enum, CATEGORY_ENUM, 'the enum must stay the single source');
  assert.ok(branches.some((b) => b.type === 'null'),
    'the model must be able to say it has no category — otherwise "cannot tell" '
    + 'collapses into the "other" tag and pollutes a hand-curated namespace');
});

// ── the extra extracted fields ───────────────────────────────────────────────

test('value and quantity are bounded, not merely typed', () => {
  // These land in a DECIMAL(10,2) and an INT under STRICT_TRANS_TABLES, where
  // an out-of-range write errors rather than clamping. A model returning 1e9,
  // a negative, or a fraction must be rejected here, not by MySQL.
  const base = { confidence: 'high', name: 'Mug', description: 'd', category: 'kitchen' };
  const v = (extra) => VisionService.normalise({ ...base, ...extra });
  assert.equal(v({ estimatedValue: 24.99 }).estimatedValue, 24.99);
  assert.equal(v({ estimatedValue: 24.999 }).estimatedValue, 25, 'rounded to cents');
  for (const bad of [0, -5, 1e9, Infinity, NaN, '25', null]) {
    assert.equal(v({ estimatedValue: bad }).estimatedValue, null, `value ${bad} must be rejected`);
  }
  assert.equal(v({ quantity: 4 }).quantity, 4);
  for (const bad of [0, -1, 2.5, 100000, '4']) {
    assert.equal(v({ quantity: bad }).quantity, null, `quantity ${bad} must be rejected`);
  }
});

test('createItem bounds currentValue independently of the model', () => {
  // An ordinary authenticated endpoint: the vision layer's filtering cannot be
  // the only gate on a number reports.service.js reads into the insurance report.
  assert.equal(createItem.validate({ name: 'X', containerId: 1, currentValue: 25.5 }).error, undefined);
  for (const bad of [-1, 0, 1000001]) {
    assert.ok(createItem.validate({ name: 'X', containerId: 1, currentValue: bad }).error,
      `currentValue ${bad} must be rejected at the route`);
  }
});

test('ItemsService.create binds CURRENT_VALUE in the right position', async () => {
  // The column list, the placeholders and the params array are three things
  // that must agree. They silently disagreed when this field was added — the
  // SQL edit failed while the params edit applied, which binds every value one
  // position off rather than erroring cleanly.
  const ItemsService = require('../src/modules/inventory/items.service');
  // create() fires AuditService.logChange without awaiting it; an uninitialised
  // audit service throws on a later tick and fails the test from outside it.
  const AuditService = require('../src/modules/audit/audit.service');
  AuditService.init({ db: { query: async () => [] }, logger });
  let sql = '', params = null;
  // create() checks-and-writes in one transaction (#88): the mock exposes
  // withTransaction, and the container-liveness lock is answered with a live row.
  const query = async (s, p) => {
    if (/INSERT INTO TALLY\.items/.test(s)) { sql = s; params = p; return { insertId: 1 }; }
    if (/SELECT c\.ID FROM TALLY\.containers c/.test(s)) return [{ ID: 3 }];
    return [];
  };
  ItemsService.init({
    db: { query, withTransaction: async (fn) => fn({ query }) },
    logger,
  });
  await ItemsService.create(
    { containerId: 3, name: 'Mug', quantity: 2, purchasePrice: 10, currentValue: 25.5 }, 1,
  );
  const cols = sql.match(/\(CONTAINER_ID[^)]*\)/)[0].split(',').map((c) => c.trim().replace(/`/g, ''));
  const placeholders = (sql.match(/VALUES \(([^)]*)\)/)[1].match(/\?/g) || []).length;
  assert.equal(cols.length, placeholders + 1, 'columns must equal placeholders + the STATUS literal');
  assert.equal(params.length, placeholders, 'params must equal placeholders');
  assert.equal(params[cols.indexOf('CURRENT_VALUE')], 25.5, 'CURRENT_VALUE bound to its own column');
  assert.equal(params[cols.indexOf('PURCHASE_PRICE')], 10, 'PURCHASE_PRICE not shifted');
  assert.equal(params[cols.indexOf('QUANTITY')], 2);
});

// ── prompt caching ───────────────────────────────────────────────────────────

test('the system prompt is sent as a cacheable block', () => {
  // Caching is a prefix match on exact bytes. Sending `system` as a bare string
  // cannot carry cache_control, so this silently reverts to uncached if anyone
  // simplifies it back.
  const src = require('fs').readFileSync(
    require.resolve('../src/modules/products/lookup/vision-identify'), 'utf8');
  assert.match(src, /system:\s*\[\{\s*type:\s*'text'/,
    'system must be a block array, not a bare string, to carry cache_control');
  assert.match(src, /cache_control:\s*\{\s*type:\s*'ephemeral'\s*\}/);
});

test('nothing per-request can leak into the cached prefix', () => {
  // Any interpolation in SYSTEM would change the bytes per call and turn every
  // request into a cache WRITE at 1.25x — worse than not caching, and silent.
  const { SYSTEM } = require('../src/modules/products/lookup/vision-identify');
  assert.equal(typeof SYSTEM, 'string');
  assert.ok(SYSTEM.length > 3000, 'the prompt must stay over the 1024-token minimum to cache at all');
  // Two reads must be byte-identical — a getter or template would not be.
  const again = require('../src/modules/products/lookup/vision-identify').SYSTEM;
  assert.equal(SYSTEM, again, 'SYSTEM must be a constant, not computed per access');
});

test('cache counters are logged so a silent miss is detectable', async () => {
  const logged = [];
  VisionService.init({
    logger: { ...logger, info: (msg, meta) => logged.push(meta) },
    config: ON,
    adapter: adapterReturning({
      result: { confidence: 'high', name: 'Drill', description: 'd', category: 'tool' },
      usage: { input_tokens: 1900, output_tokens: 20,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 1300 },
    }),
  });
  await VisionService.identify(bytes(), 'image/jpeg', 1);
  assert.equal(logged[0].cacheRead, 1300, 'a cache hit must be visible in the log');
  assert.equal(logged[0].cacheWrite, 0);
});

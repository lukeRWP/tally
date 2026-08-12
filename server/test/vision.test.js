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

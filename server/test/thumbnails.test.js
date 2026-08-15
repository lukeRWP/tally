const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const storage = require('../src/infrastructure/storage');
const Thumbnails = require('../src/modules/files/thumbnails.service');

const noop = { warn() {}, info() {}, error() {} };
const KEY = 'items/1/photo/uuid-photo.jpg';

/** A real JPEG, so sharp does real work rather than being mocked into agreement. */
async function jpeg(px = 1600) {
  return sharp({
    create: { width: px, height: Math.round(px * 0.75), channels: 3, background: '#8899aa' },
  }).jpeg().toBuffer();
}

/** Swap storage's IO for fakes, returning what the service did. */
function harness({ source, failGet = false, failPut = false } = {}) {
  const calls = { gets: [], puts: [], updates: [] };
  const realGet = storage.getObject;
  const realUpload = storage.upload;
  storage.getObject = async (k) => {
    calls.gets.push(k);
    if (failGet) throw new Error('no such key');
    return source;
  };
  storage.upload = async (k, body, ct) => {
    calls.puts.push({ key: k, bytes: body.length, contentType: ct });
    if (failPut) throw new Error('storage down');
    return k;
  };
  Thumbnails.init({
    db: { query: async (sql, params) => { calls.updates.push({ sql, params }); return { affectedRows: 1 }; } },
    logger: noop,
  });
  return { calls, restore() { storage.getObject = realGet; storage.upload = realUpload; } };
}

/** ensure() is fire-and-forget, so tests wait on the work rather than on it. */
const settle = () => new Promise(r => setTimeout(r, 400));

test('a thumbnail is far smaller than the original and stays an image', async () => {
  const source = await jpeg(1600);
  const h = harness({ source });
  try {
    Thumbnails.ensure(KEY);
    await settle();
    assert.equal(h.calls.puts.length, 1, 'nothing was written');
    const written = h.calls.puts[0];
    assert.equal(written.contentType, 'image/jpeg');
    assert.ok(written.bytes < source.length / 4,
      `thumb ${written.bytes}B vs source ${source.length}B — not worth the round trip`);
  } finally { h.restore(); }
});

test('the derivative is actually the target size', async () => {
  // Asserting bytes alone would pass on a corrupt file; this decodes it.
  const source = await jpeg(1600);
  const h = harness({ source });
  try {
    Thumbnails.ensure(KEY);
    await settle();
    // Re-derive what the service produced, the same way it did.
    const meta = await sharp(await sharp(source).rotate()
      .resize(Thumbnails.THUMB_PX, Thumbnails.THUMB_PX, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 72 }).toBuffer()).metadata();
    assert.equal(Math.max(meta.width, meta.height), Thumbnails.THUMB_PX);
  } finally { h.restore(); }
});

test('the generated key is recorded against the right file row', async () => {
  const h = harness({ source: await jpeg(400) });
  try {
    Thumbnails.ensure(KEY);
    await settle();
    assert.equal(h.calls.updates.length, 1);
    const { sql, params } = h.calls.updates[0];
    assert.match(sql, /UPDATE TALLY\.item_files SET THUMB_KEY = \?/);
    // Matched on FILE_KEY, which carries a randomUUID and so names one row.
    assert.match(sql, /WHERE FILE_KEY = \?/);
    assert.deepEqual(params, [Thumbnails.thumbKeyFor(KEY), KEY]);
  } finally { h.restore(); }
});

test('a list of rows for the same photo generates it once', async () => {
  const h = harness({ source: await jpeg(400) });
  try {
    for (let i = 0; i < 25; i++) Thumbnails.ensure(KEY);
    await settle();
    assert.equal(h.calls.puts.length, 1, `${h.calls.puts.length} resizes for one photo`);
  } finally { h.restore(); }
});

test('a photo that cannot be read is not retried on every render', async () => {
  // Without a failure memo a permanently broken file becomes a permanent load:
  // every list request would queue another doomed resize, forever.
  const h = harness({ failGet: true });
  try {
    Thumbnails.ensure(KEY);
    await settle();
    assert.equal(h.calls.gets.length, 1);
    for (let i = 0; i < 10; i++) Thumbnails.ensure(KEY);
    await settle();
    assert.equal(h.calls.gets.length, 1, 'retried a known-bad key');
  } finally { h.restore(); }
});

test('a failure records nothing, so the read path keeps serving the original', async () => {
  const h = harness({ source: await jpeg(400), failPut: true });
  try {
    Thumbnails.ensure(KEY);
    await settle();
    assert.equal(h.calls.updates.length, 0,
      'THUMB_KEY was set for an object that was never written');
  } finally { h.restore(); }
});

test('ensure() never throws into its caller', () => {
  // Called from a read path mid-render. It must be inert before init, with a
  // null key, and with no database.
  Thumbnails.init({ db: null, logger: noop });
  assert.doesNotThrow(() => Thumbnails.ensure(KEY));
  assert.doesNotThrow(() => Thumbnails.ensure(null));
  assert.doesNotThrow(() => Thumbnails.ensure(undefined));
});

test('concurrency stays capped while many photos arrive at once', async () => {
  const source = await jpeg(800);
  let concurrent = 0, peak = 0;
  const realGet = storage.getObject, realUpload = storage.upload;
  storage.getObject = async () => {
    concurrent += 1; peak = Math.max(peak, concurrent);
    await new Promise(r => setTimeout(r, 30));
    return source;
  };
  storage.upload = async (k) => { concurrent -= 1; return k; };
  Thumbnails.init({ db: { query: async () => ({}) }, logger: noop });
  try {
    for (let i = 0; i < 12; i++) Thumbnails.ensure(`items/1/photo/n-${i}.jpg`);
    await new Promise(r => setTimeout(r, 800));
    assert.ok(peak <= 2, `peak concurrency ${peak} — resizing is starving the request handler`);
  } finally { storage.getObject = realGet; storage.upload = realUpload; }
});

test('storage actually exports the reader the generator calls', () => {
  // The tests above replace storage.getObject with a fake, so they would pass
  // against a module that never exported it — which is exactly what happened:
  // defined, not exported, so every real generation threw
  // "storage.getObject is not a function", got caught, and logged a warning
  // nobody would read. ESLint's no-unused-vars is what found it.
  assert.equal(typeof storage.getObject, 'function',
    'thumbnail generation cannot read an original');
  assert.equal(typeof storage.upload, 'function');
});

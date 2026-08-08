const test = require('node:test');
const assert = require('node:assert');
const Items = require('../src/modules/inventory/items.service');

function fakeDb(handler) { return { query: async (sql, params) => handler(sql, params) }; }
const logger = { warn() {}, info() {}, error() {} };

function capture(rows = []) {
  const seen = { sql: '', params: null };
  Items.init({ db: fakeDb((s, p) => { seen.sql = s.replace(/\s+/g, ' ').trim(); seen.params = p; return rows; }), logger });
  return seen;
}

// THE property this endpoint lives or dies by. It authenticates the caller but
// resolves no property, so this join is the only thing standing between one
// household's home screen and every other household's inventory.
test('recent is membership-scoped in SQL', async () => {
  const seen = capture();
  await Items.getRecent(42, {});
  assert.match(seen.sql, /JOIN TALLY\.property_members pm ON a\.PROPERTY_ID = pm\.PROPERTY_ID/i);
  assert.match(seen.sql, /pm\.USER_ID = \?/i);
  assert.ok(!/LEFT JOIN TALLY\.property_members/i.test(seen.sql),
    'an OUTER join keeps rows with no membership and lists the whole database');
  assert.equal(seen.params[0], 42, 'userId is bound, never interpolated');
});

// CREATED_AT is a DATETIME — one-second resolution — and a capture session puts
// several items in the same second. Without the tiebreaker their order is the
// optimiser's choice and the top of the home screen reshuffles between loads.
test('newest first, with a deterministic tiebreaker', async () => {
  const seen = capture();
  await Items.getRecent(42, {});
  assert.match(seen.sql, /ORDER BY i\.CREATED_AT DESC, i\.ID DESC/i);
});

test('the recycle bin never reaches the home screen', async () => {
  const seen = capture();
  await Items.getRecent(42, {});
  assert.match(seen.sql, /i\.DELETED_AT IS NULL/i);
});

test('limit is bound and defaults to a screenful', async () => {
  const seen = capture();
  await Items.getRecent(42, {});
  assert.match(seen.sql, /LIMIT \?/);
  assert.equal(seen.params[1], 25);
  await Items.getRecent(42, { limit: 5 });
  assert.equal(seen.params[1], 5);
});

test('each row carries where it lives and the photo you took', async () => {
  const seen = capture([{
    ID: 7, CONTAINER_ID: 5, NAME: 'Cordless Drill', QR_CODE: 'TLY-I-1', STATUS: 'active',
    CREATED_AT: '2026-08-07T10:00:00Z', PHOTO_KEY: 'items/7/photo/a.jpg',
    CONTAINER_NAME: 'Bin 4', AREA_NAME: 'Garage', PROPERTY_NAME: 'Home',
  }]);
  const out = await Items.getRecent(42, {});
  assert.match(seen.sql, /FROM TALLY\.item_files f/i, 'newest photo rides along like getByContainer');
  assert.deepEqual(out[0].location, { property: 'Home', area: 'Garage', container: 'Bin 4' });
  assert.equal(out[0].photoKey, 'items/7/photo/a.jpg');
});

// Presigning is per row, so one unreachable object must cost one thumbnail —
// not the whole home screen.
test('an unreachable object store degrades the thumbnail, never the list', async () => {
  capture([{ ID: 7, CONTAINER_ID: 5, NAME: 'Drill', PHOTO_KEY: 'items/7/photo/a.jpg', STATUS: 'active' }]);
  const out = await Items.getRecent(42, {});
  assert.equal(out.length, 1);
  assert.equal(out[0].photoUrl, undefined);
});

const test = require('node:test');
const assert = require('node:assert');

// The share viewer renders off a discriminated envelope. It once branched on
// `data.entityType` — a key this service has never produced — so EVERY share
// link rendered a blank page. These tests pin the contract the client relies
// on: a `type` discriminator plus the nested payload key it names.
function fakeDb(handler) {
  return { query: async (sql, params) => handler(sql, params) };
}
const logger = { info() {}, warn() {}, error() {}, debug() {} };

function serviceWith(rows) {
  const Sharing = require('../src/modules/sharing/sharing.service');
  Sharing.init({ db: fakeDb((sql) => rows(sql)), logger, config: {} });
  return Sharing;
}

test('item share envelope carries type + nested item payload', async () => {
  const Sharing = serviceWith((sql) =>
    /FROM TALLY\.items/i.test(sql)
      ? [{ ID: 1, NAME: 'Exam Gloves', QUANTITY: 100, QR_CODE: 'TLY-I-59C8985A' }]
      : []);
  const env = await Sharing.getEntityForShare('item', 1);
  assert.equal(env.type, 'item', 'discriminator must be `type`');
  assert.equal(env.entityType, undefined, 'must NOT be `entityType` — the client bug');
  assert.ok(env.item && env.item.name === 'Exam Gloves', 'payload nests under `item`');
  assert.ok(Array.isArray(env.files) && Array.isArray(env.dates));
});

test('container share nests under `container` with nestedContainers + items', async () => {
  const Sharing = serviceWith((sql) =>
    /FROM TALLY\.containers/i.test(sql) ? [{ ID: 1, NAME: 'Tote', TYPE: 'Drawer' }] : []);
  const env = await Sharing.getEntityForShare('container', 1);
  assert.equal(env.type, 'container');
  assert.ok(env.container && env.container.name === 'Tote');
  assert.ok(Array.isArray(env.nestedContainers), '`nestedContainers`, not `children`');
  assert.ok(Array.isArray(env.items));
});

test('area shares are supported by the service (the client just never rendered them)', async () => {
  const Sharing = serviceWith((sql) =>
    /FROM TALLY\.areas/i.test(sql) ? [{ ID: 1, NAME: 'Coat Closet' }] : []);
  const env = await Sharing.getEntityForShare('area', 1);
  assert.equal(env.type, 'area');
  assert.ok(env.area && env.area.name === 'Coat Closet');
});

test('property share sends FLAT child arrays that carry parent ids for stitching', async () => {
  const Sharing = serviceWith((sql) => {
    if (/FROM TALLY\.properties/i.test(sql)) return [{ ID: 1, NAME: "Luke's Apartment" }];
    if (/FROM TALLY\.areas/i.test(sql)) return [{ ID: 7, NAME: 'Coat Closet' }];
    if (/FROM TALLY\.containers/i.test(sql)) return [{ ID: 3, AREA_ID: 7, PARENT_CONTAINER_ID: null, NAME: 'Tote' }];
    if (/FROM TALLY\.items/i.test(sql)) return [{ ID: 9, CONTAINER_ID: 3, NAME: 'Gloves' }];
    return [];
  });
  const env = await Sharing.getEntityForShare('property', 1);
  assert.equal(env.type, 'property');
  assert.ok(env.property && env.property.name === "Luke's Apartment");
  // The client stitches the tree itself, so these ids are load-bearing.
  assert.equal(env.containers[0].areaId, 7, 'containers must expose areaId');
  assert.equal(env.items[0].containerId, 3, 'items must expose containerId');
  assert.ok('parentContainerId' in env.containers[0], 'containers must expose parentContainerId');
});

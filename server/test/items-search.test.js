const test = require('node:test');
const assert = require('node:assert');
const Items = require('../src/modules/inventory/items.service');

function fakeDb(handler) { return { query: async (sql, params) => handler(sql, params) }; }
const logger = { warn() {}, info() {}, error() {} };

test('search returns each result with its location names (Where is X? needs where)', async () => {
  let sql = '', params = null;
  Items.init({ db: fakeDb((s, p) => { sql = s; params = p; return [{
    ID: 7, CONTAINER_ID: 5, NAME: 'Cordless Drill', QR_CODE: 'TLY-I-1', STATUS: 'active',
    CONTAINER_NAME: 'Bin 4', AREA_NAME: 'Garage', PROPERTY_NAME: 'Home',
  }]; }), logger });

  const out = await Items.search('drill', 42, {});
  assert.match(sql, /pr\.NAME AS PROPERTY_NAME/, 'selects the property name');
  assert.match(sql, /a\.NAME AS AREA_NAME/, 'selects the area name');
  assert.match(sql, /c\.NAME AS CONTAINER_NAME/, 'selects the container name');
  assert.match(sql, /JOIN TALLY\.properties pr/, 'joins properties for the name');
  assert.match(sql, /pm\.USER_ID = \?/, 'stays membership-scoped');
  assert.equal(params[0], 42, 'userId bound first');
  assert.deepEqual(out[0].location, { property: 'Home', area: 'Garage', container: 'Bin 4' });
});

test('search omits the status clause entirely when no status filter is given (All)', async () => {
  let sql = '';
  Items.init({ db: fakeDb((s) => { sql = s; return []; }), logger });
  await Items.search('drill', 42, {});
  assert.ok(!/i\.STATUS = \?/.test(sql), 'no status restriction means lent/removed items are findable');
});

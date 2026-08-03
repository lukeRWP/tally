const test = require('node:test');
const assert = require('node:assert');
const Audit = require('../src/modules/audit/audit.service');

const logger = { warn() {}, info() {}, error() {} };

test('getPropertyIdForEntity resolves a valid entity type', async () => {
  let params = null;
  Audit.init({ db: { query: async (_sql, p) => { params = p; return [{ PROPERTY_ID: 9 }]; } }, logger });
  const pid = await Audit.getPropertyIdForEntity('item', 7);
  assert.equal(pid, 9);
  assert.deepEqual(params, [7]);
});

test('getPropertyIdForEntity returns null for an unknown type without querying', async () => {
  let queried = false;
  Audit.init({ db: { query: async () => { queried = true; return []; } }, logger });
  const pid = await Audit.getPropertyIdForEntity('widget', 7);
  assert.equal(pid, null);
  assert.equal(queried, false);
});

test('getPropertyIdForEntity rejects prototype-chain keys (no query, returns null)', async () => {
  // A raw route param like '__proto__' / 'constructor' resolves to a truthy
  // *inherited* value on the queries object; the typeof-string guard must
  // reject it rather than pass a non-string to db.query().
  for (const evil of ['__proto__', 'constructor', 'hasOwnProperty', 'toString']) {
    let queried = false;
    Audit.init({ db: { query: async () => { queried = true; return []; } }, logger });
    const pid = await Audit.getPropertyIdForEntity(evil, 1);
    assert.equal(pid, null, `${evil} → null`);
    assert.equal(queried, false, `${evil} → no db query`);
  }
});

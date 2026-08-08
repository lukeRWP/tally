const test = require('node:test');
const assert = require('node:assert');
const Items = require('../src/modules/inventory/items.service');

const noop = { warn() {}, info() {}, error() {} };

// getById joins the product, so the offer is derived from the catalogue title
// the item was named after — not from the pruned name it already carries.
function dbWith(row) {
  return { query: async (sql) => (/FROM TALLY\.items i/i.test(sql) ? [row] : []) };
}

const BASE = {
  ID: 1, CONTAINER_ID: 2, NAME: 'x', QUANTITY: 1, STATUS: 'active',
  PROPERTY_ID: 3, AREA_ID: 4,
};

test('offers the short form when the stored name is a catalogue title', async () => {
  Items.init({ db: dbWith({
    ...BASE,
    NAME: 'CREST 3D WHITE WHITESTRIPS VIVID PLUS TEETH WHITENING KIT 24 INDIVIDUAL STRIPS (10 VIVID PLUS TREATMENTS + 2 1HR EXPRESS TREATMENTS) BASIC',
    PRODUCT_NAME: 'CREST 3D WHITE WHITESTRIPS VIVID PLUS TEETH WHITENING KIT 24 INDIVIDUAL STRIPS (10 VIVID PLUS TREATMENTS + 2 1HR EXPRESS TREATMENTS) BASIC',
  }), logger: noop });
  const item = await Items.getById(1);
  assert.ok(item.suggestedName);
  assert.ok(item.suggestedName.length < item.name.length);
  assert.equal(item.suggestedName, 'Crest 3D White Whitestrips Vivid Plus Teeth');
});

// Taking the offer must retire it, or the button never stops asking.
test('withholds the offer once the name is already the short form', async () => {
  Items.init({ db: dbWith({
    ...BASE,
    NAME: 'Crest 3D White Whitestrips Vivid Plus Teeth',
    PRODUCT_NAME: 'CREST 3D WHITE WHITESTRIPS VIVID PLUS TEETH WHITENING KIT 24 INDIVIDUAL STRIPS (10 VIVID PLUS TREATMENTS + 2 1HR EXPRESS TREATMENTS) BASIC',
  }), logger: noop });
  assert.equal((await Items.getById(1)).suggestedName, null);
});

// A name someone typed is theirs. Nothing to shorten it against, and no offer.
test('makes no offer for a hand-named item with no product', async () => {
  Items.init({ db: dbWith({ ...BASE, NAME: 'Huggies Baby Wipes', PRODUCT_NAME: null }), logger: noop });
  assert.equal((await Items.getById(1)).suggestedName, null);
});

// The barcode fallback has no catalogue title behind it, so there is nothing
// better to propose — the offer must not appear and pretend otherwise.
test('makes no offer for an Item-<barcode> name', async () => {
  Items.init({ db: dbWith({ ...BASE, NAME: 'Item 036000548136', PRODUCT_NAME: null }), logger: noop });
  assert.equal((await Items.getById(1)).suggestedName, null);
});

// A name someone chose is theirs. Offering the catalogue title back would turn
// a shortening affordance into a nag to undo their own edit.
test('makes no offer for an item renamed away from its catalogue title', async () => {
  Items.init({ db: dbWith({
    ...BASE,
    NAME: 'Whitening strips',
    PRODUCT_NAME: 'CREST 3D WHITE WHITESTRIPS VIVID PLUS TEETH WHITENING KIT 24 INDIVIDUAL STRIPS (10 VIVID PLUS TREATMENTS + 2 1HR EXPRESS TREATMENTS) BASIC',
  }), logger: noop });
  assert.equal((await Items.getById(1)).suggestedName, null);
});

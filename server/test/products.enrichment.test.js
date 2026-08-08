const test = require('node:test');
const assert = require('node:assert');
const Products = require('../src/modules/products/products.service');

const noop = { warn() {}, info() {}, error() {} };

// A local cache hit returns the orchestrator's OWN mapper, not _mapProduct, so
// this is the path that silently lost the short name on every re-scan.
test('lookupBarcode adds shortName on a local cache hit', async () => {
  Products.init({
    db: {
      query: async (sql) => {
        if (/FROM TALLY\.products WHERE BARCODE = \?/i.test(sql)) {
          return [{
            ID: 7,
            BARCODE: '0123',
            NAME: 'LANEIGE Lip Sleeping Mask Intense Hydration Lip Treatment',
            DESCRIPTION: 'An overnight lip mask.',
            RETAIL_PRICE: '24.00',
            DATA_SOURCE: 'open_food_facts',
          }];
        }
        return [];
      },
    },
    logger: noop,
  });

  const result = await Products.lookupBarcode('0123');
  assert.equal(result.source, 'local');
  assert.equal(result.product.shortName, 'Laneige Lip Sleeping Mask Intense Hydration');
  assert.equal(result.product.name, 'LANEIGE Lip Sleeping Mask Intense Hydration Lip Treatment');
});

// A name its owner typed is already the name they chose.
test('a manual catalogue entry keeps its name verbatim', () => {
  const mapped = Products._mapProduct({
    ID: 2,
    NAME: "Dad's old drill, garage shelf",
    DATA_SOURCE: 'manual',
  });
  assert.equal(mapped.shortName, "Dad's old drill, garage shelf");
});

test('_mapProduct falls back to the full name when nothing survives shortening', () => {
  const mapped = Products._mapProduct({ ID: 1, NAME: 'Milk' });
  assert.equal(mapped.shortName, 'Milk');
  assert.equal(mapped.name, 'Milk');
});

// The ENUM predates open_products_facts / web_search / url_extract, and NAME is
// VARCHAR(255) while the scrapers return untruncated text. Either overflow is
// a strict-mode error that the auto-save catch swallows, leaving the item with
// PRODUCT_ID NULL and no enrichment at all.
test('create fits every value the adapters emit into the columns that hold them', async () => {
  const seen = [];
  Products.init({
    db: {
      query: async (sql, params) => {
        if (/^INSERT INTO TALLY\.products/i.test(sql)) {
          seen.push(params);
          return { insertId: 11 };
        }
        if (/FROM TALLY\.products WHERE ID = \?/i.test(sql)) return [{ ID: 11, NAME: 'Anything' }];
        return [];
      },
    },
    logger: noop,
  });

  for (const src of ['open_products_facts', 'web_search', 'url_extract']) {
    await Products.create({ name: 'Anything', dataSource: src });
  }
  assert.deepEqual(seen.map((p) => p[p.length - 1]), ['scrape', 'scrape', 'scrape']);

  seen.length = 0;
  await Products.create({ name: 'Anything', dataSource: 'upc_db' });
  assert.equal(seen[0][seen[0].length - 1], 'upc_db');

  seen.length = 0;
  await Products.create({
    barcode: '9'.repeat(80),
    name: 'N'.repeat(600),
    brand: 'B'.repeat(400),
    category: 'Electronics > Audio > Headphones > Over-Ear > Wireless > Noise Cancelling',
    dataSource: 'upc_db',
  });
  const [barcode, name, brand, category] = seen[0];
  assert.equal(barcode.length, 50);
  assert.equal(name.length, 255);
  assert.equal(brand.length, 255);
  assert.ok(category.length <= 100);
});

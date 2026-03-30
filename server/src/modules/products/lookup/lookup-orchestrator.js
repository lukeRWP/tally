const upcDatabase = require('./upc-database');
const openFoodFacts = require('./open-food-facts');

let db = null;
let _logger = null;

function init(dbRef, logger) { db = dbRef; _logger = logger; }

async function lookupByBarcode(barcode) {
  // 1. Local catalog — fast, check first
  const local = await db.query('SELECT * FROM TALLY.products WHERE BARCODE = ?', [barcode]);
  if (local.length > 0) {
    return { source: 'local', product: mapToResult(local[0]) };
  }

  // 2. External APIs — run in parallel for speed (was sequential, taking up to 10s)
  const [upcResult, offResult] = await Promise.allSettled([
    upcDatabase.lookupBarcode(barcode),
    openFoodFacts.lookupBarcode(barcode),
  ]);

  // Log failures for visibility
  if (upcResult.status === 'rejected' && _logger) {
    _logger.warn('UPC Database lookup failed', { barcode, error: upcResult.reason?.message });
  }
  if (offResult.status === 'rejected' && _logger) {
    _logger.warn('Open Food Facts lookup failed', { barcode, error: offResult.reason?.message });
  }

  // Prefer UPC Database (better for general products), fall back to Open Food Facts
  const upc = upcResult.status === 'fulfilled' ? upcResult.value : null;
  if (upc?.name) return { source: 'upc_db', product: upc };

  const off = offResult.status === 'fulfilled' ? offResult.value : null;
  if (off?.name) return { source: 'open_food_facts', product: off };

  if (_logger) _logger.info('Product not found in any source', { barcode });
  return { source: 'not_found', product: { barcode } };
}

function mapToResult(row) {
  return {
    id: row.ID,
    barcode: row.BARCODE,
    name: row.NAME,
    brand: row.BRAND,
    category: row.CATEGORY,
    description: row.DESCRIPTION,
    imageUrl: row.IMAGE_URL,
    retailPrice: row.RETAIL_PRICE ? parseFloat(row.RETAIL_PRICE) : null,
    retailLinks: row.RETAIL_LINKS || [],
    specs: row.SPECS || {},
    depreciationRate: row.DEPRECIATION_RATE ? parseFloat(row.DEPRECIATION_RATE) : null,
    dataSource: row.DATA_SOURCE,
  };
}

module.exports = { init, lookupByBarcode };

const upcDatabase = require('./upc-database');
const openFoodFacts = require('./open-food-facts');
const openProductsFacts = require('./open-products-facts');
const webSearch = require('./web-search');

let db = null;
let _logger = null;

function init(dbRef, logger) { db = dbRef; _logger = logger; }

async function lookupByBarcode(barcode) {
  // 1. Local catalog — fast, check first
  const local = await db.query('SELECT * FROM TALLY.products WHERE BARCODE = ?', [barcode]);
  if (local.length > 0) {
    return { source: 'local', product: mapToResult(local[0]) };
  }

  // 2. Primary APIs — run in parallel (UPC Database + Open Food Facts + Open Products Facts)
  const [upcResult, offResult, opfResult] = await Promise.allSettled([
    upcDatabase.lookupBarcode(barcode),
    openFoodFacts.lookupBarcode(barcode),
    openProductsFacts.lookupBarcode(barcode),
  ]);

  // Log failures
  for (const [name, result] of [['UPC Database', upcResult], ['Open Food Facts', offResult], ['Open Products Facts', opfResult]]) {
    if (result.status === 'rejected' && _logger) {
      _logger.warn(`${name} lookup failed`, { barcode, error: result.reason?.message });
    }
  }

  // Check results in priority order
  const upc = upcResult.status === 'fulfilled' ? upcResult.value : null;
  if (upc?.name) return { source: 'upc_db', product: upc };

  const off = offResult.status === 'fulfilled' ? offResult.value : null;
  if (off?.name) return { source: 'open_food_facts', product: off };

  const opf = opfResult.status === 'fulfilled' ? opfResult.value : null;
  if (opf?.name) return { source: 'open_products_facts', product: opf };

  // 3. Fallback — DuckDuckGo instant answer (the Google scrape was removed in #355)
  try {
    const webResult = await webSearch.lookupBarcode(barcode);
    if (webResult?.name) {
      if (_logger) _logger.info('Product found via web search', { barcode, name: webResult.name });
      return { source: 'web_search', product: webResult };
    }
  } catch (err) {
    if (_logger) _logger.warn('Web search lookup failed', { barcode, error: err.message });
  }

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

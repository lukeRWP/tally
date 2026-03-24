const upcDatabase = require('./upc-database');
const openFoodFacts = require('./open-food-facts');

let db = null;

function init(dbRef) { db = dbRef; }

async function lookupByBarcode(barcode) {
  // 1. Local catalog
  const local = await db.query('SELECT * FROM TALLY.products WHERE BARCODE = ?', [barcode]);
  if (local.length > 0) {
    return { source: 'local', product: mapToResult(local[0]) };
  }
  // 2. UPC Database
  const upcResult = await upcDatabase.lookupBarcode(barcode);
  if (upcResult?.name) return { source: 'upc_db', product: upcResult };
  // 3. Open Food Facts
  const offResult = await openFoodFacts.lookupBarcode(barcode);
  if (offResult?.name) return { source: 'open_food_facts', product: offResult };
  // 4. Not found
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

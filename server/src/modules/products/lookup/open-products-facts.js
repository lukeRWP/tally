const axios = require('axios');

// Open Products Facts — covers non-food items (cosmetics, pet food, general products)
// Same API as Open Food Facts but different database
const BASES = [
  'https://world.openproductsfacts.org/api/v2',
  'https://world.openbeautyfacts.org/api/v2',
  'https://world.openpetfoodfacts.org/api/v2',
];

async function lookupBarcode(barcode) {
  // Try all three databases in parallel
  const results = await Promise.allSettled(
    BASES.map(base =>
      axios.get(`${base}/product/${barcode}.json`, {
        timeout: 3000,
        headers: { 'User-Agent': 'Tally/1.0 (home-inventory)' },
      })
    )
  );

  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const { data } = result.value;
    if (data.status !== 1 || !data.product) continue;
    const p = data.product;
    const name = p.product_name || p.generic_name;
    if (!name) continue;
    return {
      barcode,
      name,
      brand: p.brands || null,
      category: p.categories_tags?.[0]?.replace('en:', '') || null,
      description: p.generic_name || null,
      imageUrl: p.image_url || null,
      specs: { quantity: p.quantity },
      dataSource: 'open_products_facts',
    };
  }
  return null;
}

module.exports = { lookupBarcode };

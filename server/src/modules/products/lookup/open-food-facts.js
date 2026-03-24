const axios = require('axios');
const BASE_URL = 'https://world.openfoodfacts.org/api/v2';

async function lookupBarcode(barcode) {
  try {
    const { data } = await axios.get(`${BASE_URL}/product/${barcode}`, {
      timeout: 5000,
      headers: { 'User-Agent': 'Tally/1.0 (home-inventory)' },
    });
    if (data.status !== 1 || !data.product) return null;
    const p = data.product;
    return {
      barcode,
      name: p.product_name || p.generic_name || null,
      brand: p.brands || null,
      category: p.categories_tags?.[0]?.replace('en:', '') || null,
      description: p.generic_name || null,
      imageUrl: p.image_url || null,
      specs: { quantity: p.quantity, ingredients: p.ingredients_text, nutriscore: p.nutriscore_grade },
      dataSource: 'open_food_facts',
    };
  } catch { return null; }
}

module.exports = { lookupBarcode };

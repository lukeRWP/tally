const axios = require('axios');
const BASE_URL = 'https://api.upcitemdb.com/prod/trial/lookup';

async function lookupBarcode(barcode) {
  // Let errors propagate — the orchestrator handles them via Promise.allSettled
  const { data } = await axios.get(BASE_URL, {
    params: { upc: barcode },
    timeout: 3000,
    headers: { 'User-Agent': 'Tally/1.0 (home-inventory)' },
  });
  if (!data.items?.length) return null;
  const item = data.items[0];
  return {
    barcode,
    name: item.title || null,
    brand: item.brand || null,
    category: item.category || null,
    description: item.description || null,
    imageUrl: item.images?.[0] || null,
    retailPrice: item.lowest_recorded_price ? parseFloat(item.lowest_recorded_price) : null,
    retailLinks: (item.offers || []).map(o => ({
      retailer: o.merchant, url: o.link, price: o.price ? parseFloat(o.price) : null,
    })),
    specs: { ean: item.ean, upc: item.upc, model: item.model, weight: item.weight },
    dataSource: 'upc_db',
  };
}

module.exports = { lookupBarcode };

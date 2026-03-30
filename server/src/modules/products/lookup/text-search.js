const axios = require('axios');

// Search external product databases by name/text (not barcode)

async function searchByText(query) {
  const results = [];

  // Open Food Facts has a text search API
  const [offResult, opfResult] = await Promise.allSettled([
    searchOpenFoodFacts(query),
    searchOpenProductsFacts(query),
  ]);

  if (offResult.status === 'fulfilled' && offResult.value) {
    results.push(...offResult.value);
  }
  if (opfResult.status === 'fulfilled' && opfResult.value) {
    results.push(...opfResult.value);
  }

  // Deduplicate by barcode
  const seen = new Set();
  return results.filter(p => {
    if (!p.barcode || seen.has(p.barcode)) return false;
    seen.add(p.barcode);
    return true;
  }).slice(0, 20);
}

async function searchOpenFoodFacts(query) {
  const { data } = await axios.get('https://world.openfoodfacts.org/cgi/search.pl', {
    params: {
      search_terms: query,
      search_simple: 1,
      action: 'process',
      json: 1,
      page_size: 10,
      fields: 'code,product_name,brands,categories_tags,image_url,generic_name',
    },
    timeout: 3000,
    headers: { 'User-Agent': 'Tally/1.0 (home-inventory)' },
  });
  if (!data.products?.length) return [];
  return data.products
    .filter(p => p.product_name)
    .map(p => ({
      barcode: p.code || null,
      name: p.product_name,
      brand: p.brands || null,
      category: p.categories_tags?.[0]?.replace('en:', '') || null,
      description: p.generic_name || null,
      imageUrl: p.image_url || null,
      dataSource: 'open_food_facts',
    }));
}

async function searchOpenProductsFacts(query) {
  const bases = [
    'https://world.openproductsfacts.org',
    'https://world.openbeautyfacts.org',
  ];
  const all = [];
  const results = await Promise.allSettled(
    bases.map(base =>
      axios.get(`${base}/cgi/search.pl`, {
        params: {
          search_terms: query,
          search_simple: 1,
          action: 'process',
          json: 1,
          page_size: 5,
          fields: 'code,product_name,brands,categories_tags,image_url,generic_name',
        },
        timeout: 3000,
        headers: { 'User-Agent': 'Tally/1.0 (home-inventory)' },
      })
    )
  );
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const products = r.value.data?.products || [];
    for (const p of products) {
      if (!p.product_name) continue;
      all.push({
        barcode: p.code || null,
        name: p.product_name,
        brand: p.brands || null,
        category: p.categories_tags?.[0]?.replace('en:', '') || null,
        description: p.generic_name || null,
        imageUrl: p.image_url || null,
        dataSource: 'open_products_facts',
      });
    }
  }
  return all;
}

module.exports = { searchByText };

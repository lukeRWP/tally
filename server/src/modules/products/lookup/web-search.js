const axios = require('axios');

// Last-resort fallback: the DuckDuckGo instant-answer API (free, no key, a
// documented JSON endpoint). The Google Shopping HTML scrape that used to
// follow it is gone (#355): brittle, against ToS, and the Anthropic-backed
// product-match flow is the sanctioned path for anything the barcode APIs
// and this miss.

async function lookupBarcode(barcode) {
  // Try DuckDuckGo instant answer first
  try {
    const ddg = await axios.get('https://api.duckduckgo.com/', {
      params: { q: `${barcode} barcode product`, format: 'json', no_redirect: 1 },
      timeout: 3000,
      headers: { 'User-Agent': 'Tally/1.0 (home-inventory)' },
    });
    const d = ddg.data;
    // DDG returns Abstract or RelatedTopics with product info
    if (d.AbstractText && d.Heading) {
      return {
        barcode,
        name: d.Heading,
        brand: null,
        category: d.AbstractSource || null,
        description: d.AbstractText.substring(0, 500) || null,
        imageUrl: d.Image || null,
        dataSource: 'web_search',
      };
    }
    // Check related topics for a product match
    if (d.RelatedTopics?.length > 0) {
      const topic = d.RelatedTopics[0];
      if (topic.Text) {
        // Extract product name from the first sentence
        const name = topic.Text.split(' - ')[0]?.substring(0, 200) || topic.Text.substring(0, 200);
        return {
          barcode,
          name,
          brand: null,
          category: null,
          description: topic.Text.substring(0, 500) || null,
          imageUrl: topic.Icon?.URL || null,
          dataSource: 'web_search',
        };
      }
    }
  } catch {
    // DDG failed — nothing else to try
  }

  return null;
}

module.exports = { lookupBarcode };

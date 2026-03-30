const axios = require('axios');

// Last-resort fallback: search the web for the barcode number
// Uses DuckDuckGo instant answer API (free, no key, no rate limit)
// Then falls back to parsing Google search results page

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
    // DDG failed, continue to next method
  }

  // Try Google Shopping search (RSS feed, no API key)
  try {
    const google = await axios.get('https://www.google.com/search', {
      params: { q: `${barcode}`, tbm: 'shop', num: 1 },
      timeout: 3000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Tally/1.0)',
        'Accept': 'text/html',
      },
      responseType: 'text',
    });
    const html = google.data;
    // Extract product title from Google Shopping result
    const titleMatch = html.match(/<h3[^>]*>([^<]+)<\/h3>/);
    const priceMatch = html.match(/\$(\d+\.?\d*)/);
    if (titleMatch?.[1]) {
      return {
        barcode,
        name: decodeHTMLEntities(titleMatch[1]),
        brand: null,
        category: null,
        description: null,
        imageUrl: null,
        retailPrice: priceMatch?.[1] ? parseFloat(priceMatch[1]) : null,
        dataSource: 'web_search',
      };
    }
  } catch {
    // Google failed too
  }

  return null;
}

function decodeHTMLEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/');
}

module.exports = { lookupBarcode };

const axios = require('axios');
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const { URL } = require('url');

/**
 * Is this IP in a private/reserved range the extractor must never reach?
 * IPv4: 0/8, loopback 127/8, RFC1918, link-local + cloud metadata 169.254/16,
 * CGNAT 100.64/10, multicast/reserved (>=224). IPv6: loopback, ULA (fc00::/7),
 * link-local (fe80::/10), and IPv4-mapped addresses (re-checked as IPv4).
 */
function isPrivateOrReserved(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    return (
      p[0] === 0 || p[0] === 10 || p[0] === 127 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      p[0] >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const a = ip.toLowerCase();
    if (a.startsWith('fc') || a.startsWith('fd')) return true;   // fc00::/7 ULA
    if (/^fe[89ab]/.test(a)) return true;                        // fe80::/10 link-local
    // Anything in ::/16 — loopback (::1), unspecified (::), IPv4-mapped
    // (::ffff:a.b.c.d, which can smuggle a private IPv4), and IPv4-compatible
    // (::a.b.c.d) — is never a globally routable host, so block it outright.
    if (a.startsWith('::')) return true;
    return false;
  }
  return true; // unparseable → block
}

/**
 * Drop-in dns.lookup that resolves the way the HTTP client actually connects
 * (so decimal/octal IPv4 forms and IPv6 are handled identically) and rejects
 * any result in a private/reserved range. Attached to the HTTP(S) agents so
 * EVERY connection — initial request, redirect, and DNS-rebind re-resolution —
 * is validated at connect time.
 */
function ssrfSafeLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err);
    for (const a of addresses) {
      if (isPrivateOrReserved(a.address)) {
        return callback(new Error('Refusing to connect to a private/reserved address (SSRF protection)'));
      }
    }
    if (options && options.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

const ssrfHttpAgent = new http.Agent({ lookup: ssrfSafeLookup });
const ssrfHttpsAgent = new https.Agent({ lookup: ssrfSafeLookup });

/**
 * Pre-flight SSRF check for a clean error message. The real enforcement is the
 * validating lookup on the HTTP agents (which also covers redirects + rebinding).
 */
async function validateUrlNotPrivate(urlStr) {
  const parsed = new URL(urlStr);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only HTTP and HTTPS URLs are allowed');
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  // A literal IP hostname connects directly without going through dns.lookup,
  // so the agent guard never sees it — validate it here.
  if (net.isIP(host)) {
    if (isPrivateOrReserved(host)) {
      throw new Error('URL resolves to a private/reserved address and is not allowed');
    }
    return;
  }
  const addresses = await dns.promises.lookup(host, { all: true, verbatim: true }).catch(() => []);
  for (const a of addresses) {
    if (isPrivateOrReserved(a.address)) {
      throw new Error('URL resolves to a private/reserved address and is not allowed');
    }
  }
}

/**
 * Extract product details from a URL by parsing:
 * 1. JSON-LD structured data (@type: Product) — most reliable
 * 2. Open Graph meta tags (og:title, og:image, etc.)
 * 3. Standard HTML meta tags as fallback
 */
async function extractFromUrl(url) {
  await validateUrlNotPrivate(url);

  const { data: html } = await axios.get(url, {
    timeout: 8000,
    maxRedirects: 5,
    // SSRF protection: every connection (incl. redirects/rebinds) resolves
    // through ssrfSafeLookup, which rejects private/reserved addresses.
    httpAgent: ssrfHttpAgent,
    httpsAgent: ssrfHttpsAgent,
    maxContentLength: 5 * 1024 * 1024, // cap response body (defensive)
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    responseType: 'text',
  });

  const product = {
    name: null,
    brand: null,
    description: null,
    imageUrl: null,
    retailPrice: null,
    category: null,
    retailLinks: [{ retailer: extractDomain(url), url, price: null }],
    dataSource: 'url_extract',
    sourceUrl: url,
  };

  // 1. JSON-LD structured data (schema.org Product)
  const jsonLd = extractJsonLd(html);
  if (jsonLd) {
    product.name = jsonLd.name || product.name;
    product.brand = jsonLd.brand?.name || jsonLd.brand || product.brand;
    product.description = truncate(jsonLd.description, 500) || product.description;
    product.imageUrl = Array.isArray(jsonLd.image) ? jsonLd.image[0] : (jsonLd.image || product.imageUrl);
    product.category = jsonLd.category || product.category;
    const price = jsonLd.offers?.price || jsonLd.offers?.lowPrice
      || (Array.isArray(jsonLd.offers) ? jsonLd.offers[0]?.price : null);
    if (price) product.retailPrice = parseFloat(price);
    if (product.retailPrice && product.retailLinks[0]) {
      product.retailLinks[0].price = product.retailPrice;
    }
  }

  // 2. Open Graph tags
  const og = extractOpenGraph(html);
  product.name = product.name || og.title;
  product.description = product.description || truncate(og.description, 500);
  product.imageUrl = product.imageUrl || og.image;
  if (!product.retailPrice && og.price) {
    product.retailPrice = parseFloat(og.price);
  }

  // 3. Standard meta/title fallback
  if (!product.name) {
    product.name = extractTag(html, /<title[^>]*>([^<]+)<\/title>/i);
  }
  if (!product.description) {
    product.description = truncate(extractMeta(html, 'description'), 500);
  }

  // 4. Try to extract price from page if still missing
  if (!product.retailPrice) {
    const priceMatch = html.match(/\$(\d{1,6}\.\d{2})/);
    if (priceMatch) product.retailPrice = parseFloat(priceMatch[1]);
  }

  // Clean up name — remove site suffix like " | Amazon.com"
  if (product.name) {
    product.name = product.name
      .replace(/\s*[|\-–—]\s*(Amazon|Walmart|Target|eBay|Best Buy|Home Depot|Lowes|Costco|Wayfair).*$/i, '')
      .replace(/\s*[|\-–—]\s*[^|]*\.com.*$/i, '')
      .trim();
  }

  return product.name ? product : null;
}

function extractJsonLd(html) {
  const scripts = html.match(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const script of scripts) {
    try {
      const content = script.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '');
      let parsed = JSON.parse(content);

      // Handle @graph arrays
      if (parsed['@graph']) parsed = parsed['@graph'];
      if (Array.isArray(parsed)) {
        const product = parsed.find(item =>
          item['@type'] === 'Product' ||
          item['@type']?.includes?.('Product')
        );
        if (product) return product;
      }
      if (parsed['@type'] === 'Product' || parsed['@type']?.includes?.('Product')) {
        return parsed;
      }
    } catch { /* invalid JSON-LD, skip */ }
  }
  return null;
}

function extractOpenGraph(html) {
  return {
    title: extractMeta(html, 'og:title'),
    description: extractMeta(html, 'og:description'),
    image: extractMeta(html, 'og:image'),
    price: extractMeta(html, 'product:price:amount') || extractMeta(html, 'og:price:amount'),
  };
}

function extractMeta(html, name) {
  // Match both name= and property= attributes
  const regex = new RegExp(
    `<meta[^>]*(?:name|property)\\s*=\\s*["']${escapeRegex(name)}["'][^>]*content\\s*=\\s*["']([^"']*)["']` +
    `|<meta[^>]*content\\s*=\\s*["']([^"']*)["'][^>]*(?:name|property)\\s*=\\s*["']${escapeRegex(name)}["']`,
    'i'
  );
  const match = html.match(regex);
  return match ? (match[1] || match[2] || '').trim() : null;
}

function extractTag(html, regex) {
  const match = html.match(regex);
  return match ? decodeEntities(match[1]).trim() : null;
}

function extractDomain(url) {
  try {
    const hostname = new URL(url).hostname.replace('www.', '');
    // Map common domains to friendly names
    const names = {
      'amazon.com': 'Amazon', 'walmart.com': 'Walmart', 'target.com': 'Target',
      'bestbuy.com': 'Best Buy', 'homedepot.com': 'Home Depot', 'lowes.com': 'Lowes',
      'costco.com': 'Costco', 'ebay.com': 'eBay', 'wayfair.com': 'Wayfair',
      'ikea.com': 'IKEA', 'etsy.com': 'Etsy',
    };
    return names[hostname] || hostname;
  } catch { return 'Unknown'; }
}

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function truncate(str, max) {
  if (!str) return null;
  return str.length > max ? str.substring(0, max) + '...' : str;
}

module.exports = { extractFromUrl };

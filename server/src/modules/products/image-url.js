/**
 * Product image URLs (#355).
 *
 * A product row is shared by every household and its IMAGE_URL is written by
 * whichever lookup first found it — the upcitemdb / Open*Facts adapters, a
 * user-pasted retailer page (extract-url's og:image), or a hand-filled form.
 * Two gates, one per audience:
 *
 *  - storableImageUrl(): what may be persisted at all. https only, no
 *    credentials, bounded length. Blocks data:/javascript:/http: at the write
 *    instead of hoping every renderer guards. Applied in the Joi schema AND in
 *    ProductsService.create(), because the lookup auto-save path never sees
 *    the schema.
 *  - publicImageUrl(): what the ANONYMOUS share page may load. That page is the
 *    one place a third party's browser fetches a URL a household member chose,
 *    so it is limited to hosts the catalogue providers actually return. Anything
 *    else becomes "no image" — never an error, never a broken page.
 */
const MAX_LEN = 2000;

// Hosts seen from the lookup providers: the adapters' own CDNs plus every host
// in the 2026-09-03 production catalogue (upcitemdb hands back retailer CDN
// images). Suffix match, so `i5.walmartimages.com` passes for
// `walmartimages.com`. Extend when a provider adds one; the cost of a missing
// entry is a missing stock photo on a share page, nothing more.
const PUBLIC_IMAGE_HOSTS = [
  'openfoodfacts.org', 'openproductsfacts.org', 'openbeautyfacts.org', 'openpetfoodfacts.org',
  'walmartimages.com', 'scene7.com', 'kohlsimg.com', 'booksamillion.com', 'drugstore.com',
  'media-amazon.com', 'ssl-images-amazon.com', 'duckduckgo.com',
];

function parseHttps(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > MAX_LEN) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  return u;
}

function storableImageUrl(v) {
  const u = parseHttps(v);
  return u ? u.toString() : null;
}

function hostAllowed(hostname) {
  const h = hostname.toLowerCase();
  return PUBLIC_IMAGE_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
}

function publicImageUrl(v) {
  const u = parseHttps(v);
  return u && hostAllowed(u.hostname) ? u.toString() : null;
}

module.exports = { storableImageUrl, publicImageUrl, PUBLIC_IMAGE_HOSTS };

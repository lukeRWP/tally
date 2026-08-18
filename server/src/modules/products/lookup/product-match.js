const SDK = require('@anthropic-ai/sdk');

// A GTIN is 8, 12, 13 or 14 digits. Anything else the model offers as a "UPC"
// is not one — and a wrong barcode is worse than no barcode, because resolve
// uses it to converge on a catalog row.
const GTIN = /^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/;

function str(v, max) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function httpsUrl(v) {
  const s = str(v, 2000);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' ? u : null;
  } catch { return null; }
}

/**
 * Validate whatever the model returned into candidates we are willing to store.
 *
 * Everything here is defensive on purpose: this is model output reaching a
 * table that resolve reads to write the product catalog.
 */
function normaliseCandidates(raw, max) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const name = str(c.name, 255);
    const source = httpsUrl(c.sourceUrl);
    if (!name || !source) continue;          // both are required
    const upc = str(c.upc, 14);
    const price = typeof c.priceUsd === 'number' && isFinite(c.priceUsd) && c.priceUsd > 0
      ? Math.round(c.priceUsd * 100) / 100 : null;
    out.push({
      name,
      brand: str(c.brand, 255),
      model: str(c.model, 255),
      upc: upc && GTIN.test(upc) ? upc : null,
      priceUsd: price,
      imageUrl: httpsUrl(c.imageUrl)?.toString() ?? null,
      sourceUrl: source.toString(),
      // Derived, never taken from the model: it is the one field a reader uses
      // to judge whether a source is credible, so it must match the real URL.
      sourceDomain: source.hostname.replace(/^www\./, ''),
    });
    if (out.length >= max) break;
  }
  return out;
}

const SYSTEM = [
  'You identify a specific consumer product from a short description taken from',
  'a photo, and return purchasable matches.',
  '',
  'Use web search to find the actual product. Return at most 3 candidates,',
  'best first. Prefer a manufacturer or major-retailer page.',
  '',
  'Return a UPC/EAN only when the page states one. Never construct, guess or',
  'infer a barcode — an invented one is worse than none, because it will be',
  'treated as an identity. The same applies to model numbers.',
  '',
  'If you cannot find the product, return an empty list. An empty list is a',
  'correct answer and is preferred over a plausible wrong one.',
].join('\n');

const SCHEMA = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          brand: { type: ['string', 'null'] },
          model: { type: ['string', 'null'] },
          upc: { type: ['string', 'null'] },
          priceUsd: { type: ['number', 'null'] },
          imageUrl: { type: ['string', 'null'] },
          sourceUrl: { type: 'string' },
        },
        required: ['name', 'sourceUrl'],
        additionalProperties: false,
      },
    },
  },
  required: ['candidates'],
  additionalProperties: false,
};

function queryText({ brand, name, category, description }) {
  return [
    brand ? `Brand: ${brand}` : null,
    name ? `Item: ${name}` : null,
    category ? `Category: ${category}` : null,
    description ? `Seen in photo: ${description}` : null,
  ].filter(Boolean).join('\n');
}

/**
 * One Claude call with web search. Resolves to {candidates}; an unusable
 * response resolves to an empty list rather than throwing, because "found
 * nothing" and "returned nonsense" are the same outcome to the caller.
 * Transport and auth failures DO throw — the runner distinguishes them so a
 * retry can happen.
 */
async function search(input, { config, logger }) {
  const client = new SDK({ apiKey: config.vision.apiKey });
  const res = await client.messages.create({
    model: config.match.model,
    max_tokens: 2000,
    thinking: { type: 'adaptive' },
    system: SYSTEM,
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }],
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: queryText(input) }],
  }, { timeout: config.match.timeoutMs });

  const text = (res.content || [])
    .filter((b) => b.type === 'text').map((b) => b.text).join('');
  let parsed;
  try { parsed = JSON.parse(text); } catch {
    logger?.warn('product match returned non-JSON', { stopReason: res.stop_reason });
    return { candidates: [] };
  }
  return { candidates: normaliseCandidates(parsed?.candidates, config.match.maxCandidates) };
}

module.exports = { search, normaliseCandidates };

const crypto = require('crypto');

const NAME_MAX = 64;          // 48 is the print budget; 64 leaves editing room
const DESCRIPTION_MAX = 300;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;

const CONFIDENCE = ['high', 'medium', 'low', 'none'];
const CATEGORIES = new Set([
  'electronics', 'appliance', 'furniture', 'tool', 'kitchen', 'clothing',
  'toy', 'sports', 'outdoor', 'media', 'document', 'decor', 'health',
  'pet', 'automotive', 'craft', 'storage', 'other',
]);

const OFF     = Object.freeze({ available: false, suggestion: null });
const NOTHING = Object.freeze({ available: true,  suggestion: null });

// C0/C1 controls, zero-width marks, and the bidi overrides that let stored text
// render as something other than what a later consumer reads.
const CONTROL_AND_INVISIBLE =
  /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

function clean(value, max) {
  if (typeof value !== 'string') return null;
  const s = value.replace(CONTROL_AND_INVISIBLE, '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

/**
 * The suggestion is rebuilt field by field rather than passed through.
 *
 * ProductsService.create() writes whatever adapter-shaped object it is handed
 * into a catalogue every household shares, and lookupBarcode auto-saves any
 * result carrying a name. A vision guess has no barcode and no provenance, so
 * it must not be able to arrive there by accident - the surest guarantee is for
 * the object not to carry the fields that route would recognise.
 */
function normalise(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const confidence = CONFIDENCE.includes(raw.confidence) ? raw.confidence : 'none';
  if (confidence === 'none') return null;

  const suggestion = {
    // A low-confidence NAME is the worst thing this feature can produce: it is
    // the one field that pre-fills an input, and a plausible wrong name is
    // accepted without reading. Category and description are only ever seen on
    // a panel the user opened, so they survive at low confidence.
    name: confidence === 'low' ? null : clean(raw.name, NAME_MAX),
    description: clean(raw.description, DESCRIPTION_MAX),
    category: typeof raw.category === 'string' && CATEGORIES.has(raw.category)
      ? raw.category : null,
    // Carried so the review panel can say "read" vs "guessed". Computed to
    // calibrate trust, and previously discarded before the one screen where
    // trust is actually decided.
    confidence,
  };
  if (!suggestion.name && !suggestion.description && !suggestion.category) return null;
  return suggestion;
}

let _logger = null;
let _config = null;
let _adapter = null;

// Keyed by sha256 of the exact bytes. Insertion-ordered, so the oldest key is
// the first one Map iteration yields - that is the eviction victim.
const recent = new Map();
const inFlight = new Map();

function readCache(key) {
  const hit = recent.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { recent.delete(key); return null; }
  return hit.answer;
}

function writeCache(key, answer) {
  if (recent.size >= CACHE_MAX_ENTRIES) {
    const oldest = recent.keys().next().value;
    if (oldest !== undefined) recent.delete(oldest);
  }
  recent.set(key, { answer, at: Date.now() });
}

const VisionService = {
  init({ logger, config, adapter }) {
    _logger = logger; _config = config;
    _adapter = adapter || require('./lookup/vision-identify');   // injectable for tests
    recent.clear(); inFlight.clear();
  },

  isEnabled() { return !!(_config && _config.vision && _config.vision.enabled); },

  async identify(buffer, mimeType, userId, signal) {
    if (!VisionService.isEnabled()) return OFF;
    const key = crypto.createHash('sha256').update(buffer).digest('hex');

    const cached = readCache(key);
    if (cached) return cached;

    // A retry after a blip and a double-fired effect both arrive as the same
    // bytes while the first call is still open. Sharing the promise makes the
    // second one free instead of billing twice for an answer already on its way.
    const pending = inFlight.get(key);
    if (pending) return pending;

    const started = Date.now();
    const run = (async () => {
      try {
        const { result, usage, noResultReason } =
          await _adapter.identifyImage(buffer, mimeType, { signal });
        const suggestion = normalise(result);
        const answer = suggestion ? { available: true, suggestion } : NOTHING;
        // Only a real answer is remembered. Caching a failure would turn a
        // deliberate retry -- which sends the identical bytes -- into a replay
        // of the same failure for ten minutes.
        if (suggestion) writeCache(key, answer);
        _logger?.info?.('Vision identify complete', {
          userId, bytes: buffer.length, mimeType, ms: Date.now() - started,
          identified: !!suggestion,
          // Without this a truncation storm is indistinguishable from the model
          // honestly failing to recognise things, and both are billed.
          noResultReason: suggestion ? null : (noResultReason ?? 'low_confidence'),
          inputTokens: usage?.input_tokens ?? null,
          outputTokens: usage?.output_tokens ?? null,
        });
        return answer;
      } catch (err) {
        // Destructured, never passed whole: an HTTP client hangs the request
        // config off its errors and the request config carries the api key,
        // which matches none of error-handler's redaction field names.
        _logger?.warn?.('Vision identify failed', {
          userId, ms: Date.now() - started,
          status: err?.status ?? null, name: err?.name ?? null, message: err?.message ?? null,
        });
        return NOTHING;
      } finally { inFlight.delete(key); }
    })();

    inFlight.set(key, run);
    return run;
  },
};

module.exports = VisionService;
module.exports.normalise = normalise;
module.exports.clean = clean;

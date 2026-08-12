const crypto = require('crypto');

const NAME_MAX = 64;          // 48 is the print budget; 64 leaves editing room
const DESCRIPTION_MAX = 300;
const BRAND_MAX = 64;
// Bounds, not just types. These values land in a DECIMAL(10,2) money column and
// an INT quantity, and a model is perfectly capable of returning 1e9 or 0.
// STRICT_TRANS_TABLES turns an out-of-range write into an error, not a clamp.
const VALUE_MAX = 100000;     // a household item worth more than this gets typed by hand
const QUANTITY_MAX = 999;
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
// render as something other than what a later consumer reads. Matching control
// characters is the entire point here -- they are what this exists to remove.
// eslint-disable-next-line no-control-regex
const CONTROL_AND_INVISIBLE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

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
/** A finite positive number inside bounds, rounded to cents. Null otherwise. */
function money(value, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value <= 0 || value > max) return null;
  return Math.round(value * 100) / 100;
}

/** A positive whole count inside bounds. Null otherwise. */
function count(value, max) {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < 1 || value > max) return null;
  return value;
}

function normalise(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const confidence = CONFIDENCE.includes(raw.confidence) ? raw.confidence : 'none';
  if (confidence === 'none') return null;

  const suggestion = {
    // Low-confidence names are KEPT.
    //
    // This used to null them, on the reasoning that a plausible wrong name gets
    // accepted without being read. That conflated two different risks: inventing
    // specificity ("DeWalt 20V Impact Driver" for an unbranded drill) and naming
    // an object generically ("Mug"). Only the first is wrong. The second is what
    // a household inventory is mostly made of, and dropping it left the item
    // called "Unnamed" — strictly worse than the plain truth.
    //
    // The guard against invented detail lives in the prompt, which forbids a
    // brand, model or measurement that cannot be read. The guard against a name
    // being accepted unexamined is the dashed border on the field.
    name: clean(raw.name, NAME_MAX),
    description: clean(raw.description, DESCRIPTION_MAX),
    category: typeof raw.category === 'string' && CATEGORIES.has(raw.category)
      ? raw.category : null,
    brand: clean(raw.brand, BRAND_MAX),
    // Never auto-applied. It reaches CURRENT_VALUE, which reports.service.js
    // reads straight into the insurance report — a wrong number there looks
    // authoritative in a way a wrong name never does, so it requires an
    // explicit Keep and is labelled an estimate wherever it is shown.
    estimatedValue: money(raw.estimatedValue, VALUE_MAX),
    quantity: count(raw.quantity, QUANTITY_MAX),
    // Carried so the review panel can say "read" vs "guessed". Computed to
    // calibrate trust, and previously discarded before the one screen where
    // trust is actually decided.
    confidence,
  };
  if (!suggestion.name && !suggestion.description && !suggestion.category
      && !suggestion.brand && suggestion.estimatedValue == null
      && suggestion.quantity == null) return null;
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

        // Why the level is chosen rather than fixed: production's console
        // transport only emits at its configured level (default 'error'), so a
        // line logged at info is invisible in `docker compose logs`. The
        // detector this reason code exists for -- a run of truncations that
        // bills on every capture while the user sees "nothing found" -- has to
        // surface WITHOUT anyone having raised LOG_LEVEL first, or it is not a
        // detector.
        //
        // A model that honestly cannot identify a photo is not an anomaly and
        // stays at info; it would otherwise drown the real signal.
        const reason = suggestion ? null : (noResultReason ?? 'low_confidence');
        const anomalous = !!reason && reason !== 'low_confidence';
        const meta = {
          userId, bytes: buffer.length, mimeType, ms: Date.now() - started,
          identified: !!suggestion,
          noResultReason: reason,
          inputTokens: usage?.input_tokens ?? null,
          outputTokens: usage?.output_tokens ?? null,
        };
        if (anomalous) {
          // Paid for, and produced nothing the user can see. That is an error
          // condition even though the request itself succeeded.
          _logger?.error?.('Vision identify produced no usable result', meta);
        } else {
          _logger?.info?.('Vision identify complete', meta);
        }
        return answer;
      } catch (err) {
        // ERROR, not warn. The upstream call throwing -- a rejected key, a
        // model id the account cannot reach, a request shape the API refuses,
        // a timeout -- is strictly more serious than the model looking and
        // finding nothing, and it was logged at a LOWER level than that case.
        // Prod's console emits at 'error', so this was invisible: an API
        // failure and an honest decline produced the same silence in the logs
        // AND the same message on screen, which is not a diagnosable state.
        //
        // Destructured, never passed whole: an HTTP client hangs the request
        // config off its errors and the request config carries the api key,
        // which matches none of error-handler's redaction field names.
        _logger?.error?.('Vision identify failed', {
          userId, ms: Date.now() - started,
          // Which model was attempted: a 404 here means the id or the
          // account's access to it, not the photo.
          model: _config?.vision?.model ?? null,
          status: err?.status ?? null, name: err?.name ?? null,
          type: err?.type ?? null, message: err?.message ?? null,
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

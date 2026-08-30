/**
 * What a share link publishes — the catalogue, and the code that enforces it.
 *
 * A share link is the only surface in tally that answers with no session at
 * all, and until #298 the sharer was told exactly one thing about it: "anyone
 * can view without signing in". Not *what* travels. This module is the single
 * place that answers that, and it answers it once for three audiences:
 *
 *   1. `ShareDialog`, over GET /api/sharing/_x_/disclosure — so the sharer
 *      reads the same list the server enforces, rather than a hand-written
 *      caption that drifts the first time the payload changes;
 *   2. `sharing.service.js`, via `applyDisclosure()` — the strip actually runs
 *      against the built payload, so a category that claims to hide something
 *      demonstrably hides it (the tests assert exactly that);
 *   3. whoever next edits the payload — adding a field without adding it here
 *      is the bug this module exists to make obvious.
 *
 * DEFAULTS ARE TODAY'S BEHAVIOUR. Every optional category defaults to ON, a
 * stored NULL means "all on", and a key missing from a stored object means
 * "on". A link created before this existed therefore publishes exactly what it
 * published yesterday. Nothing here narrows the policy — it only gives the
 * sharer somewhere to say otherwise. What a share SHOULD publish by default is
 * still an open question on #298 and deliberately not answered here.
 */

/**
 * `optional: false` rows are the point of the link — they have no toggle and
 * exist so the dialog can state them plainly instead of leaving the sharer to
 * guess. `optional: true` rows each own a `strip` that removes their data from
 * a built envelope.
 */
const CATEGORIES = [
  // ── Always shared ────────────────────────────────────────────────────────
  {
    key: 'contents',
    label: 'What is in it',
    detail:
      'Names, descriptions, quantities, condition and QR code of everything the link covers.',
    appliesTo: ['property', 'area', 'container', 'item'],
    optional: false,
  },
  {
    key: 'sharer',
    label: 'Your display name and the expiry date',
    detail: 'So a stranger can see who sent the link and when it stops working. No email, no account.',
    appliesTo: ['property', 'area', 'container', 'item'],
    optional: false,
  },

  // ── Opt-out ──────────────────────────────────────────────────────────────
  {
    key: 'address',
    label: 'The property address',
    detail: 'The street address recorded for this property.',
    appliesTo: ['property'],
    optional: true,
    strip(envelope) {
      if (envelope.property) envelope.property.address = null;
    },
  },
  {
    key: 'location',
    label: 'Where it is kept',
    detail: 'The property, room and container names above what you are sharing.',
    appliesTo: ['area', 'container', 'item'],
    optional: true,
    strip(envelope) {
      if (envelope.item) envelope.item.breadcrumb = [];
      if (envelope.area) envelope.area.propertyName = null;
      if (envelope.container) {
        envelope.container.propertyName = null;
        envelope.container.areaName = null;
      }
    },
  },
  {
    key: 'purchasePrice',
    label: 'What you paid',
    detail: 'The purchase price recorded for this item.',
    appliesTo: ['item'],
    optional: true,
    strip(envelope) {
      if (envelope.item) envelope.item.purchasePrice = null;
    },
  },
  {
    key: 'files',
    label: 'Photos and receipts',
    detail:
      'Every file attached to this item, by download link. A receipt commonly carries a name and a card tail.',
    appliesTo: ['item'],
    optional: true,
    strip(envelope) {
      envelope.files = [];
    },
  },
  {
    key: 'conditionHistory',
    label: 'Condition check history',
    detail: 'Each recorded condition check, with its photo and notes.',
    appliesTo: ['item'],
    optional: true,
    strip(envelope) {
      envelope.conditionSnapshots = [];
    },
  },
  {
    key: 'dates',
    label: 'Warranty and service dates',
    detail: 'Dates you have recorded against this item, with their notes.',
    appliesTo: ['item'],
    optional: true,
    strip(envelope) {
      envelope.dates = [];
    },
  },
];

const ENTITY_TYPES = ['property', 'area', 'container', 'item'];

/** Every category that applies to one entity type, in catalogue order. */
function categoriesFor(entityType) {
  return CATEGORIES.filter((c) => c.appliesTo.includes(entityType));
}

/** Just the toggleable ones — the keys a stored choice may legitimately carry. */
function optionalKeysFor(entityType) {
  return categoriesFor(entityType)
    .filter((c) => c.optional)
    .map((c) => c.key);
}

/**
 * The catalogue as the dialog consumes it: no functions, grouped by entity
 * type, with the default (`true`) stated per row so the client never has to
 * invent one.
 */
function catalogue() {
  const out = {};
  for (const type of ENTITY_TYPES) {
    out[type] = categoriesFor(type).map((c) => ({
      key: c.key,
      label: c.label,
      detail: c.detail,
      optional: c.optional,
      defaultValue: true,
    }));
  }
  return out;
}

/**
 * A stored DISCLOSURE value (JSON column, NULL, or a string on drivers that
 * do not parse it) turned into a plain object. Anything unreadable is treated
 * as NULL — a corrupt value must not change what a link publishes, and "share
 * everything" is what that link did before the column existed.
 */
function parseStored(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The effective choice for a link: every optional key for its entity type,
 * resolved to a boolean. Missing key -> true, NULL -> all true.
 */
function resolve(stored, entityType) {
  const parsed = parseStored(stored);
  const out = {};
  for (const key of optionalKeysFor(entityType)) {
    out[key] = parsed == null || parsed[key] === undefined ? true : Boolean(parsed[key]);
  }
  return out;
}

/**
 * Client input on create, narrowed to keys that mean something for this entity
 * type. Returns null when nothing was chosen, so an untouched dialog stores
 * NULL and the row is indistinguishable from one written before #298.
 */
function normalizeChoice(input, entityType) {
  if (!input || typeof input !== 'object') return null;
  const keys = optionalKeysFor(entityType);
  const out = {};
  for (const key of keys) {
    if (input[key] !== undefined) out[key] = Boolean(input[key]);
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Remove from a built envelope everything its link's sharer turned off.
 *
 * Deliberately a post-pass over the finished payload rather than conditions
 * threaded through five SQL builders: one place to read, one place to test,
 * and no way for a query edit to quietly reintroduce a field the sharer said
 * no to. Mutates and returns the envelope.
 */
function applyDisclosure(envelope, stored) {
  if (!envelope || !envelope.type) return envelope;
  const choice = resolve(stored, envelope.type);
  for (const cat of categoriesFor(envelope.type)) {
    if (cat.optional && choice[cat.key] === false) cat.strip(envelope);
  }
  return envelope;
}

module.exports = {
  CATEGORIES,
  ENTITY_TYPES,
  categoriesFor,
  optionalKeysFor,
  catalogue,
  parseStored,
  resolve,
  normalizeChoice,
  applyDisclosure,
};

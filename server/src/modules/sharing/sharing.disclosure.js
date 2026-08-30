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
 * ── Changing a default ──────────────────────────────────────────────────────
 *
 * Every optional category below carries an explicit `defaultOn`. That flag is
 * the whole knob: to stop publishing the property address by default, change
 * the ONE line `defaultOn: true,` inside the `address` category (search for
 * `key: 'address'`) to `defaultOn: false,`. To do the same for the purchase
 * price, change the `defaultOn: true,` line inside the `purchasePrice`
 * category. Nothing else — not the client, not the schema, not a migration.
 *
 * Every category ships `defaultOn: true` today. What a share SHOULD publish by
 * default is still an open question on #298 and is deliberately not answered
 * here; this file only makes answering it a one-line edit.
 *
 * ── THE INVARIANT: an existing link is frozen ───────────────────────────────
 *
 * A default applies to a link at the moment it is CREATED, and never again.
 * Changing `defaultOn` must never change what an already-issued link
 * publishes — those URLs are in other people's hands, and a link that was
 * shared as "here is the address" must not silently become one that isn't (or,
 * far worse, the reverse). So the read path and the write path are separate:
 *
 *   resolve()        READ  — what an existing link publishes. NEVER consults
 *                            `defaultOn`. A stored NULL means "everything",
 *                            and a key absent from a stored object means "on".
 *                            Both are frozen at ON for all time.
 *   normalizeChoice() WRITE — what a NEW link stores. Consults `defaultOn`, so
 *                            that a default which is off is recorded on the row
 *                            even if the client never mentioned the category.
 *
 * Do not "simplify" this by having resolve() fall back to `defaultOn`. It
 * looks like the same thing and is not: it would retroactively rewrite every
 * link ever issued, including the pre-#298 ones whose DISCLOSURE column is
 * NULL because the column did not exist yet. `sharing.disclosure.test.js`
 * flips every default to `false` and asserts that stored NULLs, stored `{}`
 * and stored partial objects all still publish exactly what they publish
 * today — that test exists precisely to fail on such a simplification.
 */

/**
 * `optional: false` rows are the point of the link — they have no toggle, no
 * `defaultOn`, and exist so the dialog can state them plainly instead of
 * leaving the sharer to guess. `optional: true` rows each own a `defaultOn`
 * (the tick the dialog starts on for a NEW link) and a `strip` that removes
 * their data from a built envelope.
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
    // ↓ THE ADDRESS DEFAULT. Change this one line to `false` to stop new
    //   property shares publishing the street address. #298 is where that
    //   call gets made; nobody has made it, so it stays `true`.
    defaultOn: true,
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
    defaultOn: true,
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
    // ↓ THE PURCHASE-PRICE DEFAULT. Change this one line to `false` to stop
    //   new item shares publishing what you paid. Also #298's call to make.
    defaultOn: true,
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
    defaultOn: true,
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
    defaultOn: true,
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
    defaultOn: true,
    strip(envelope) {
      envelope.dates = [];
    },
  },
];

const ENTITY_TYPES = ['property', 'area', 'container', 'item'];

// A toggleable category with no stated default would read as `undefined` —
// falsy — and quietly ship OFF, which is the exact accident this module exists
// to prevent. Refuse to load rather than guess: a missing default is a code
// edit away from being noticed, and a silently-withheld field is not.
for (const cat of CATEGORIES) {
  if (cat.optional && typeof cat.defaultOn !== 'boolean') {
    throw new Error(
      `sharing.disclosure: optional category "${cat.key}" must declare an explicit boolean defaultOn`
    );
  }
}

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
 * The starting position for a NEW link: every optional key for this entity
 * type at its declared `defaultOn`. This is the ONLY place a default is read.
 *
 * Never use this to interpret a stored value — see the invariant in the header.
 */
function defaultChoice(entityType) {
  const out = {};
  for (const cat of categoriesFor(entityType)) {
    if (cat.optional) out[cat.key] = cat.defaultOn;
  }
  return out;
}

/**
 * The catalogue as the dialog consumes it: no functions, grouped by entity
 * type, with each row's default stated on the wire as `defaultValue` so the
 * client pre-ticks from the server's declared policy instead of assuming
 * all-on. Always-shared rows report `true` — they cannot be turned off.
 */
function catalogue() {
  const out = {};
  for (const type of ENTITY_TYPES) {
    out[type] = categoriesFor(type).map((c) => ({
      key: c.key,
      label: c.label,
      detail: c.detail,
      optional: c.optional,
      defaultValue: c.optional ? c.defaultOn : true,
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
 * READ PATH — what an EXISTING link publishes. Every optional key for its
 * entity type, resolved to a boolean.
 *
 * `defaultOn` is deliberately not consulted here, and must never be. Absence
 * is pinned to ON at both levels:
 *
 *   stored NULL          -> every category on. This is every link issued
 *                           before the DISCLOSURE column existed, and it is
 *                           also what a sharer who accepted an all-on dialog
 *                           gets, so the two are indistinguishable on purpose.
 *   key absent from the  -> that category on. Absence is a settled "yes", not
 *   stored object           an "unspecified" for a later default to fill in:
 *                           the link was issued under a catalogue where that
 *                           category was on, and it stays that way.
 *
 * Consequence, which is the point: flipping any `defaultOn` cannot change one
 * byte of what any already-issued link publishes.
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
 * WRITE PATH — what a NEW link stores, narrowed to keys that mean something
 * for this entity type. A key is recorded when either:
 *
 *   - the sharer stated it (exactly as before defaults existed), or
 *   - the sharer left it unstated and its `defaultOn` is false.
 *
 * The second clause is the only new behaviour, and it is inert while every
 * default is `true`: an unstated key whose default is on is simply left out,
 * because resolve() already reads absence as on. So with today's catalogue
 * this function writes byte-for-byte what it wrote before — including NULL for
 * an untouched dialog, a row indistinguishable from a pre-#298 link.
 *
 * It also means a default cannot be quietly bypassed by a caller that omits
 * the field: turn `address` off by default and a create with no `disclosure`
 * at all still stores `{address: false}`, rather than NULL — which resolve()
 * would read as "publish everything", forever.
 */
function normalizeChoice(input, entityType) {
  const stated = input && typeof input === 'object' ? input : null;
  const defaults = defaultChoice(entityType);
  const out = {};
  for (const key of optionalKeysFor(entityType)) {
    if (stated && stated[key] !== undefined) out[key] = Boolean(stated[key]);
    else if (defaults[key] === false) out[key] = false;
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
  defaultChoice,
  catalogue,
  parseStored,
  resolve,
  normalizeChoice,
  applyDisclosure,
};

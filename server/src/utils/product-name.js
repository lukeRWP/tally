/**
 * Retail titles are keyword soup written for a search engine, not a shelf:
 * "CREST 3D WHITE WHITESTRIPS ... KIT 24 INDIVIDUAL STRIPS (...) BASIC". Stored
 * verbatim they wrap the title bar to five lines and shrink the printed label
 * past legibility, so the item gets a SHORT name and the catalogue keeps the
 * long one.
 *
 * Two principles decide every rule below.
 *
 * 1. Structure, never vocabulary — position, punctuation, digit shape, letter
 *    case. A product lexicon fails silently on the first thing it has not seen,
 *    and household inventory is unbounded.
 * 2. Cut only as much as the label budget demands. A 6 Qt pot and an 8 Qt pot
 *    live in the same kitchen; deleting a size that already fits invents a
 *    collision rather than removing noise.
 */

/**
 * 48 characters, measured against the printed label rather than guessed.
 * labels.service.js shrink-to-fits the name into two lines of a 156pt box
 * (2x2 medium, 216 - 38 banner - 12 pad - 10 padX, behind a location banner)
 * and gives up at 8.25pt: real 48-character names settle at 9-10pt,
 * 55-character ones hit the floor and spill to a third line. Overflow does not
 * raise — it prints smaller until it is unreadable — so the bound is set where
 * there is still headroom.
 */
const MAX_LENGTH = 48;

/**
 * The longest input worth reasoning about. products.NAME is VARCHAR(255), but
 * url-extractor and web-search hand us un-truncated scraped <title>/<h3> text,
 * and the tail rules are unanchored on the left — quadratic on a megabyte of
 * punctuation. Everything past this point is noise by any measure.
 */
const MAX_INPUT = 300;

/**
 * Tokens that must survive an ALL-CAPS source untouched. Only needed for
 * letter-only tokens: anything containing a digit is detected by shape.
 */
const ACRONYMS = new Set([
  'USB', 'USBC', 'LED', 'LCD', 'OLED', 'QLED', 'HD', 'UHD', 'HDR', 'TV', 'DVD', 'CD', 'BD',
  'HDMI', 'RGB', 'GPS', 'NFC', 'ANC', 'PVC', 'ABS', 'BPA', 'SD', 'SSD', 'HDD', 'RAM', 'CPU',
  'GPU', 'IPS', 'SPF', 'UV', 'PC', 'XL', 'XXL', 'XS', 'AA', 'AAA', 'AC', 'DC', 'RV', 'ATV',
  'USA', 'UK', 'EU', 'IP', 'MFI', 'PD', 'QC', 'OZ', 'ML', 'LB', 'KG', 'FT', 'IN',
  // Brand-styled model words that read as a typo in title case (DEWALT 20V MAX).
  'MAX', 'PRO', 'AIR', 'MINI',
  // Generation numerals. Listed one by one rather than matched by pattern:
  // /^[IVXLCDM]+$/ also matches VIVID, MIX, DIM and CIVIL.
  'II', 'III', 'IV', 'VI', 'VII', 'VIII', 'IX', 'XI', 'XII', 'XIII',
]);

/**
 * Colour is a variant, not an identity — but only when it TRAILS, and only
 * when the name is over budget. "Cream", "tan" and "clear" are deliberately
 * absent: ice cream, shaving cream and clear tape are objects, not shades.
 */
const COLOURS = new Set([
  'black', 'white', 'silver', 'gray', 'grey', 'blue', 'red', 'green', 'pink', 'gold',
  'navy', 'beige', 'brown', 'purple', 'yellow', 'orange', 'graphite', 'charcoal', 'ivory',
  'burgundy', 'bronze', 'copper', 'multicolor', 'multicolour',
]);

/**
 * Trailing words that describe the LISTING rather than the object. "Kit",
 * "Set" and "Pack" are deliberately absent: they change what the thing is.
 */
const TRAILING_NOISE = new Set([
  'model', 'models', 'series', 'edition', 'version', 'basic', 'assorted', 'misc',
  'style', 'type', 'design', 'variety', 'new',
]);

const CONNECTIVES = new Set([
  'and', 'or', 'with', 'w/', 'for', 'the', 'a', 'an', 'of', 'in', 'on', 'to', 'by',
  'plus', '&', '+', '-', '–', '—', 'featuring', 'includes', 'including',
]);

/** Slogans that never identify anything. Kept tiny on purpose. */
const MARKETING = [
  /\bindustry[-\s]leading\b/gi,
  /\bbest[-\s]selling\b/gi,
  /\btop[-\s]rated\b/gi,
  /\baward[-\s]winning\b/gi,
  /\bas seen on tv\b/gi,
  /\ball[-\s]new\b/gi,
  /\bbrand new\b/gi,
];

const UNIT =
  '(?:fl\\.?\\s*oz|oz|ounces?|ml|l|liters?|litres?|g|gr|grams?|kg|lbs?|pounds?|' +
  'ct|cnt|counts?|pks?|packs?|pcs?|pieces?|sheets?|rolls?|strips?|pairs?|wipes?|pods?|pacs?|' +
  'tablets?|capsules?|caps|softgels|servings?|bags?|bars?|cans?|bottles?|joules?|watts?|w|' +
  'v|volts?|mah|ah|ft|feet|foot|in|inch|inches|yd|yards?|mm|cm|btu|gal|gallons?|' +
  'qt|quarts?|pt|pints?)';

/**
 * Whatever punctuation glued the size onto the name. `/` is NOT here: it is
 * the fraction bar in "1/2 in" and the aperture in "f/1.8G", and a tail rule
 * that may start mid-number turns a socket wrench into "Wrench 1".
 */
const SEP = '[\\s,;·\\-–—=]*';

/** A tail rule may not begin inside a number. Guards 1/2, 3 3/8, 1,5 and 26.5. */
const NOTNUM = '(?<![\\d.,/])';

/** A number that may use either a decimal point or a decimal comma. */
const NUM = '\\d+(?:[.,]\\d+)?';

/**
 * All anchored to the END. A size in the HEAD is identity — "Samsung 65-Inch
 * Class QLED", "STANLEY 25 ft Tape Measure" — and must not be touched.
 */
const TAIL_RULES = [
  new RegExp(`${NOTNUM}${SEP}${NUM}\\s*-?\\s*${UNIT}\\.?\\s*$`, 'i'),            // 128 fl oz, 750g, 2-Pack, 5000mAh
  new RegExp(`${NOTNUM}${SEP}\\d+\\s*[x×]\\s*${NUM}\\s*${UNIT}\\.?\\s*$`, 'i'),  // 12 x 330 ml
  new RegExp(`${SEP}(?:pack|set|box|case|bundle|carton)\\s+of\\s+\\d+\\s*$`, 'i'),
  new RegExp(
    `${NOTNUM}${SEP}\\d+\\s+(?:[a-z]+\\s+)?(?:strips?|sheets?|rolls?|bags?|pairs?|tablets?|capsules?` +
    `|wipes?|pods?|pacs?|count|ct|pack|pk|pieces?|pcs?|servings?|treatments?)\\s*$`,
    'i',
  ),                                                                             // 24 Individual Strips
  new RegExp(`${SEP}(?:half\\s+)?(?:gallon|quart|pint|liter|litre)s?\\s*$`, 'i'), // …Milk, Gallon
];

/**
 * Punctuation that ends the product and begins the variant. An UNSPACED slash
 * is excluded so "1/2-Inch" and "30 3/8" survive, and a comma BETWEEN DIGITS is
 * excluded because "1,5 L" is a decimal, not a list.
 */
const STRONG_DELIMS = /(?<!\d),(?!\d)|[;|·]|\s[–—]\s|\s-\s|\s\/\s/;

/**
 * Prepositions that introduce a feature list rather than a new fact. "for" is
 * deliberately absent: it names the VARIANT ("Body Wash for Dry Skin"), and
 * cutting there gives two different bottles the same name.
 */
const WEAK_DELIMS = /\s(?:with|w\/|featuring|includes|including)\s/i;

/**
 * A trailing parenthetical that states CONDITION rather than a SKU. Kept
 * because an insurance summary that calls a refurbished phone a new one is
 * wrong about money. Closed set — a SKU can never match it.
 */
const CONDITION_PAREN = /\(\s*((?:certified\s+)?refurbished|renewed|open\s+box|pre-?owned|used|sealed)\s*\)\s*$/i;

function words(s) {
  return s.split(/\s+/).filter(Boolean);
}

/** Punctuation and dangling connectives that a cut leaves behind. */
function trimTail(s) {
  let out = s.replace(/[\s,;:|·\-–—/+&=.]+$/g, '').trim();
  for (;;) {
    const w = words(out);
    if (w.length <= 1) break;
    if (!CONNECTIVES.has(w[w.length - 1].toLowerCase())) break;
    out = w.slice(0, -1).join(' ');
  }
  return out.replace(/[\s,;:|·\-–—/+&=.]+$/g, '').trim();
}

/**
 * In "CREST 3D WHITE" every token is capitalised, so case carries no signal
 * and the decision has to come from SHAPE.
 */
function isAcronymish(token) {
  const bare = token.replace(/[^\p{L}\p{N}-]/gu, '');
  if (!bare) return true;
  if (/\d/.test(bare)) return true;                      // 3D, A19, XM5, 20V, WH-1000XM5
  if (bare.length <= 2) return true;                     // AA, XL, UV
  if (ACRONYMS.has(bare.toUpperCase())) return true;
  if (bare.includes('-')) {
    return bare
      .split('-')
      .every((p) => !p || ACRONYMS.has(p.toUpperCase()) || /\d/.test(p) || p.length <= 2);
  }
  return false;
}

/**
 * A possessive or contraction tail stays lowercase; anything longer after an
 * apostrophe is a second name part. Without the distinction "Levi's" and
 * "L'Oréal" cannot both come out right.
 */
const CONTRACTION_TAILS = new Set(['s', 't', 'd', 'm', 'll', 're', 've']);

/**
 * Unicode-aware: an ASCII-only word pattern treats the accent in NESTLÉ as a
 * word boundary and prints "NestlÉ".
 */
function titleCaseToken(token) {
  return token.replace(/\p{L}[\p{L}\p{M}']*/gu, (w) => {
    const cased = w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    return cased.replace(/'(\p{L}+)/gu, (whole, tail) => (
      CONTRACTION_TAILS.has(tail)
        ? whole
        : `'${tail.charAt(0).toUpperCase()}${tail.slice(1)}`
    ));
  });
}

function recase(s) {
  return words(s)
    .map((t) => {
      if (isAcronymish(t)) return t;
      // \p{Lu}{3,} rather than [A-Z]{3,}: L'ORÉAL has no run of three ASCII
      // capitals, so an ASCII test leaves it SHOUTING.
      if (t === t.toUpperCase() && /\p{Lu}{3,}/u.test(t)) return titleCaseToken(t);
      // Open Food Facts titles are hand-typed and often all-lowercase
      // ("coca cola zero sugar"). A deliberately mixed-case token (iPhone,
      // MagSafe, n.5) never reaches this branch, so raising the first letter
      // cannot damage one.
      if (t === t.toLowerCase() && /^\p{Ll}{3,}$/u.test(t) && !CONNECTIVES.has(t)) {
        return titleCaseToken(t);
      }
      return t;
    })
    .join(' ');
}

/**
 * Cut at the EARLIEST delimiter that leaves a head worth keeping. Scanning
 * onward rather than giving up is what stops "Nutella - 750g" and
 * "Milk, Whole, Gallon" from collapsing to a single word. Three words, not
 * two, because marketplace titles open with the pitch — "Premium Quality,
 * Durable Stainless Steel Water Bottle" must not become "Premium Quality".
 */
function cutAtDelimiter(s, re, minWords, minChars) {
  let rest = s;
  let consumed = 0;
  for (;;) {
    const m = re.exec(rest);
    if (!m) return s;
    const head = trimTail(s.slice(0, consumed + m.index));
    if (words(head).length >= minWords && head.length >= minChars) return head;
    const step = m.index + Math.max(1, m[0].length);
    consumed += step;
    rest = rest.slice(step);
    if (!rest) return s;
  }
}

/** The trailing-noise half of stripTails, which is safe at any length. */
function stripNoiseWord(s) {
  const w = words(s);
  if (w.length < 3) return s;
  const last = w[w.length - 1].toLowerCase().replace(/[^\p{L}]/gu, '');
  if (TRAILING_NOISE.has(last)) return trimTail(w.slice(0, -1).join(' '));
  return s;
}

/**
 * Pack sizes, counts and colours. Gated on the budget by the caller: a name
 * that already fits keeps its "6 Qt", because that is the only thing telling
 * it apart from the 8 Qt in the same cupboard.
 */
function stripTails(s, max) {
  let out = s;
  // One removal can expose the next ("… 24 Individual Strips Basic").
  for (let pass = 0; pass < 6; pass += 1) {
    if (out.length <= max) break;
    let changed = false;
    for (const re of TAIL_RULES) {
      const next = out.replace(re, '');
      // A name that is ONLY a measurement ("12 fl oz") keeps it — deleting
      // every letter-free name would leave nothing to show.
      if (next !== out && /\p{L}/u.test(next)) {
        out = trimTail(next);
        changed = true;
      }
      if (out.length <= max) return out;
    }
    const noised = stripNoiseWord(out);
    if (noised !== out) { out = noised; changed = true; }
    if (out.length <= max) return out;
    const w = words(out);
    if (w.length >= 3) {
      const last = w[w.length - 1].toLowerCase().replace(/[^\p{L}]/gu, '');
      if (COLOURS.has(last)) { out = trimTail(w.slice(0, -1).join(' ')); changed = true; }
    }
    if (!changed) break;
  }
  return out;
}

/**
 * Retail copy restates the head noun in the tail ("Lip Sleeping Mask …
 * Lip Treatment"), so a repeated content word marks where the substance ends.
 * Only from the fourth token on, or "Red Bull Red Edition" loses its own name.
 */
function cutAtRepeat(s) {
  const w = words(s);
  const seen = new Set();
  for (let i = 0; i < w.length; i += 1) {
    const key = w[i].toLowerCase().replace(/[^\p{L}]/gu, '');
    if (key.length >= 3 && !CONNECTIVES.has(key) && !ACRONYMS.has(key.toUpperCase())) {
      if (seen.has(key) && i >= 3) return trimTail(w.slice(0, i).join(' '));
      seen.add(key);
    }
  }
  return s;
}

/** Codepoints, not UTF-16 units — a hard cut must never split a surrogate pair. */
function clampChars(s, max) {
  return Array.from(s).slice(0, max).join('');
}

function truncate(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1);
  const at = cut.lastIndexOf(' ');
  const head = at > 0 ? cut.slice(0, at) : '';
  const trimmed = trimTail(head);
  if (words(trimmed).length >= 2) return trimmed;
  // A single word longer than the budget — a SKU, a German compound, a scraped
  // spaceless <title>, or a script with no spaces at all. It still has to fit
  // the label, and it still has to fit items.NAME, so it is cut mid-word.
  return clampChars(trimTail(words(s)[0] || s) || s, max);
}

/**
 * Turn a retail listing title into a name a person would write on a box.
 * Pure and deterministic: same input, same output, no clock, no network.
 * Returns '' for anything unusable so the caller keeps its own fallback.
 */
function simplifyProductName(raw, options) {
  const max = (options && options.maxLength) || MAX_LENGTH;
  if (typeof raw !== 'string') return '';

  // 1. One space between tokens, so every pattern below sees the same shape,
  //    and a hard input cap so an un-truncated scrape cannot make the
  //    left-unanchored tail rules quadratic.
  let s = raw.slice(0, MAX_INPUT).replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ').trim();
  if (!s) return '';

  // 2. A trailing condition is held back, not deleted: "(Refurbished)" is a
  //    valuation fact in an app that prints an insurance summary.
  let condition = '';
  const cond = s.match(CONDITION_PAREN);
  if (cond) {
    condition = titleCaseToken(cond[1].replace(/\s+/g, ' '));
    s = s.slice(0, cond.index).trim();
  }

  // 3. Bracketed spans, before any cut: a comma INSIDE a parenthetical
  //    ("(QN65Q60DAFXZA, 2024 Model)") would otherwise cut the string in the
  //    middle of the bracket and keep the dangling "(".
  s = s.replace(/\s*[([{][^)\]}]*[)\]}]\s*/g, ' ').replace(/\s+/g, ' ').trim();

  // 4. Slogans, before the cuts, so the head-length guards below measure real
  //    content: "All New, Widget" must not settle for a head of "All New".
  for (const re of MARKETING) s = s.replace(re, ' ');
  s = s.replace(/\s+/g, ' ').trim();

  // 5. Punctuation is a stronger boundary than a preposition, so it goes first;
  //    the weak pass then works on the already-shortened head.
  s = cutAtDelimiter(s, STRONG_DELIMS, 3, 10);
  s = cutAtDelimiter(s, WEAK_DELIMS, 3, 14);

  // 6. Restatement, before the budget is spent on it.
  s = cutAtRepeat(s);

  // 7. Case before the length rules, so what is measured is what is stored.
  s = recase(trimTail(s));

  const budget = condition ? max - condition.length - 3 : max;

  // 8. Only now, and only if it still does not fit, are pack size, count and
  //    colour taken off. Below budget they stay, because they are what tells
  //    the 6 Qt from the 8 Qt.
  if (s.length > budget) s = stripTails(s, budget);

  // 9. Last resort.
  if (s.length > budget) {
    s = truncate(s, budget);
    // Truncation can newly EXPOSE a listing word: "…Q60D Series" only ends in
    // "Series" once the cut has happened — and cutting a spaceless SKU can
    // strip the digits that made it acronym-shaped, so case is decided again
    // on the string that will actually be stored.
    s = recase(stripNoiseWord(s));
  }

  s = trimTail(s);
  if (condition && s) s = `${s} (${condition})`;

  // A title made entirely of punctuation leaves "))", which is truthy and would
  // beat the caller's fallback.
  return /\p{L}|\p{N}/u.test(s) ? s : '';
}

module.exports = { simplifyProductName, MAX_LENGTH };

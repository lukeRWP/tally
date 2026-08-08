const test = require('node:test');
const assert = require('node:assert');
const { simplifyProductName, MAX_LENGTH } = require('../src/utils/product-name');

const CREST =
  'CREST 3D WHITE WHITESTRIPS VIVID PLUS TEETH WHITENING KIT 24 INDIVIDUAL STRIPS ' +
  '(10 VIVID PLUS TREATMENTS + 2 1HR EXPRESS TREATMENTS) BASIC';

test('shortens the reported barcode scans', () => {
  assert.equal(simplifyProductName(CREST), 'Crest 3D White Whitestrips Vivid Plus Teeth');
  assert.equal(
    simplifyProductName('LANEIGE Lip Sleeping Mask Intense Hydration Lip Treatment'),
    'Laneige Lip Sleeping Mask Intense Hydration',
  );
});

test('cuts at the first strong delimiter that leaves a usable head', () => {
  assert.equal(
    simplifyProductName('Great Value Whole Vitamin D Milk, Gallon, 128 fl oz'),
    'Great Value Whole Vitamin D Milk',
  );
  assert.equal(
    simplifyProductName('LOGITECH MX Master 3S Wireless Performance Mouse - Graphite'),
    'Logitech MX Master 3S Wireless Performance Mouse',
  );
  assert.equal(
    simplifyProductName('IKEA KALLAX Shelf Unit, White, 30 3/8x30 3/8"'),
    'Ikea Kallax Shelf Unit',
  );
});

test('skips a delimiter whose head is a bare pitch or a bare brand', () => {
  assert.equal(simplifyProductName('Nutella - 750g'), 'Nutella - 750g');
  assert.equal(
    simplifyProductName('Premium Quality, Durable Stainless Steel Water Bottle'),
    'Premium Quality, Durable Stainless Steel Water',
  );
  assert.equal(
    simplifyProductName('Heavy Duty, Adjustable Garage Storage Shelf'),
    'Heavy Duty, Adjustable Garage Storage Shelf',
  );
  assert.equal(simplifyProductName('Milk, Whole, Gallon'), 'Milk, Whole, Gallon');
});

test('cuts at a weak delimiter only when the head already stands alone', () => {
  assert.equal(
    simplifyProductName('Hydro Flask Wide Mouth Bottle with Flex Cap 32 oz Black'),
    'Hydro Flask Wide Mouth Bottle',
  );
  assert.equal(
    simplifyProductName('STANLEY FATMAX 25 ft Tape Measure with Blade Armor Coating'),
    'Stanley Fatmax 25 ft Tape Measure',
  );
});

test('"for" names the variant, so it is never a cut point', () => {
  assert.equal(
    simplifyProductName('Dove Body Wash for Sensitive Skin'),
    'Dove Body Wash for Sensitive Skin',
  );
  assert.notEqual(
    simplifyProductName('Nature Made Multivitamin for Women Tablets'),
    simplifyProductName('Nature Made Multivitamin for Men Tablets'),
  );
});

test('drops bracketed spans wherever they sit', () => {
  assert.equal(
    simplifyProductName('Apple AirPods Pro (2nd Generation) Wireless Ear Buds with USB-C Charging'),
    'Apple AirPods Pro Wireless Ear Buds',
  );
  assert.equal(
    simplifyProductName(
      'Anker 622 Magnetic Battery (MagGo), 5000mAh Foldable Magnetic Wireless Portable Charger',
    ),
    'Anker 622 Magnetic Battery',
  );
});

test('keeps a trailing condition, which is a valuation fact', () => {
  assert.equal(
    simplifyProductName('Apple iPhone 13 Pro 128GB (Refurbished)'),
    'Apple iPhone 13 Pro 128GB (Refurbished)',
  );
  assert.equal(
    simplifyProductName('Dyson V8 Animal Cordless Vacuum (Renewed)'),
    'Dyson V8 Animal Cordless Vacuum (Renewed)',
  );
  assert.equal(simplifyProductName('Sony WH-1000XM4 (Open Box)'), 'Sony WH-1000XM4 (Open Box)');
  // A SKU in brackets is still a SKU.
  assert.equal(
    simplifyProductName('DEWALT 20V MAX Cordless Drill / Driver Kit, Compact, 1/2-Inch (DCD771C2)'),
    'Dewalt 20V MAX Cordless Drill',
  );
});

test('removes brackets before cutting, not after', () => {
  assert.equal(
    simplifyProductName(
      'Samsung 65-Inch Class QLED 4K Q60D Series Quantum HDR Smart TV (QN65Q60DAFXZA, 2024 Model)',
    ),
    'Samsung 65-Inch Class QLED 4K Q60D',
  );
});

test('drops pack, count and size tails only when over budget', () => {
  assert.equal(
    simplifyProductName('Kirkland Signature Ultra Clean Laundry Detergent Pacs, 152-count'),
    'Kirkland Signature Ultra Clean Laundry Detergent',
  );
  assert.equal(
    simplifyProductName('Coca-Cola Classic Soda Soft Drink, 12 fl oz, 12 Pack'),
    'Coca-Cola Classic Soda Soft Drink',
  );
  assert.equal(
    simplifyProductName(
      'Ziploc Gallon Food Storage Freezer Bags, Grip and Seal Technology for Easier Grip and Close, 28 Count',
    ),
    'Ziploc Gallon Food Storage Freezer Bags',
  );
});

// A 6 Qt pot and an 8 Qt pot live in the same cupboard: deleting a size that
// already fits the label invents a collision instead of removing noise.
test('keeps a size that already fits', () => {
  assert.equal(simplifyProductName('Instant Pot Duo 6 Qt'), 'Instant Pot Duo 6 Qt');
  assert.equal(simplifyProductName('Instant Pot Duo 8 Qt'), 'Instant Pot Duo 8 Qt');
  assert.equal(simplifyProductName('Barilla Spaghetti n.5 500g'), 'Barilla Spaghetti n.5 500g');
  assert.equal(
    simplifyProductName('DEWALT Lithium Ion Battery Pack 20V'),
    'Dewalt Lithium Ion Battery Pack 20V',
  );
  assert.equal(
    simplifyProductName('Advil Ibuprofen 200 mg Tablets, 100 Count'),
    'Advil Ibuprofen 200 mg Tablets',
  );
  assert.equal(
    simplifyProductName('Sharpie Fine Point Permanent Marker Black'),
    'Sharpie Fine Point Permanent Marker Black',
  );
});

// A fraction is the identity of a socket, a drill bit and a length of pipe.
test('never cuts inside a number', () => {
  assert.equal(
    simplifyProductName('Craftsman Socket Wrench 1/2 in'),
    'Craftsman Socket Wrench 1/2',
  );
  assert.equal(simplifyProductName('Bosch Drill Bit Set 3/8 in'), 'Bosch Drill Bit Set 3/8');
  assert.equal(simplifyProductName('Nikon AF-S NIKKOR 50mm f/1.8G'), 'Nikon AF-S Nikkor 50mm f/1.8G');
  // A decimal comma is not a list separator.
  assert.equal(simplifyProductName('Coca-Cola Zero Sugar 1,5 L'), 'Coca-Cola Zero Sugar 1,5 L');
});

test('keeps a leading size', () => {
  assert.equal(
    simplifyProductName(
      'GE 30 in. Smart Slide-In Front-Control Gas Range with Convection Oven — Stainless Steel',
    ),
    'GE 30 in. Smart Slide-In Front-Control Gas Range',
  );
});

test('drops slogans', () => {
  assert.equal(
    simplifyProductName('Sony WH-1000XM5 Wireless Industry Leading Noise Canceling Headphones, Black'),
    'Sony WH-1000XM5 Wireless Noise Canceling',
  );
});

test('normalises SHOUTING while keeping acronyms, model numbers and numerals', () => {
  assert.equal(
    simplifyProductName('PHILIPS Hue White and Color Ambiance A19 LED Smart Bulb, 4 Pack'),
    'Philips Hue White and Color Ambiance A19 LED',
  );
  assert.equal(simplifyProductName('USB-C to Lightning Cable 6ft, 2-Pack'), 'USB-C to Lightning Cable 6ft');
  assert.equal(simplifyProductName('NEUTROGENA SPF 55 SUNSCREEN'), 'Neutrogena SPF 55 Sunscreen');
  assert.equal(
    simplifyProductName('Anker PowerLine III USB-C Cable'),
    'Anker PowerLine III USB-C Cable',
  );
});

// An ASCII-only word pattern treats the accent as a word boundary and stores
// "NestlÉ"; an [A-Z]{3,} test never fires on L'ORÉAL and leaves it SHOUTING.
test('recases accented brands without corrupting them', () => {
  assert.equal(simplifyProductName('NESTLÉ NESQUIK CHOCOLATE POWDER'), 'Nestlé Nesquik Chocolate Powder');
  assert.equal(simplifyProductName('MÜLLER CORNER YOGURT STRAWBERRY'), 'Müller Corner Yogurt Strawberry');
  assert.equal(simplifyProductName('HÄAGEN-DAZS VANILLA ICE CREAM'), 'Häagen-Dazs Vanilla Ice Cream');
  assert.ok(!/[A-ZÉÀÜ]{3,}/.test(simplifyProductName("L'ORÉAL PARIS ELVIVE TOTAL REPAIR 5")));
});

// An apostrophe joins two name parts as often as it marks a possessive, and a
// word pattern that swallows it lowercases the second part: "L'oreal".
test('capitalises a name part after an apostrophe but not a possessive', () => {
  assert.equal(simplifyProductName("L'ORÉAL Paris Voluminous Mascara"), "L'Oréal Paris Voluminous Mascara");
  assert.equal(simplifyProductName("LEVI'S 501 Original Fit Jeans"), "Levi's 501 Original Fit Jeans");
  // Both rules inside one token.
  assert.equal(simplifyProductName("O'KEEFFE'S Working Hands Hand Cream"), "O'Keeffe's Working Hands Hand Cream");
});

// "Ice cream", "shaving cream" and "clear tape" are objects, not shades.
test('does not mistake a noun for a colour', () => {
  assert.equal(simplifyProductName('Haagen-Dazs Vanilla Ice Cream'), 'Haagen-Dazs Vanilla Ice Cream');
  assert.equal(simplifyProductName('Barbasol Original Shaving Cream'), 'Barbasol Original Shaving Cream');
  assert.equal(simplifyProductName('Rustoleum Painters Touch Spray Clear'), 'Rustoleum Painters Touch Spray Clear');
  assert.equal(simplifyProductName('Black Pepper Grinder'), 'Black Pepper Grinder');
});

test('leaves deliberate mixed case alone', () => {
  assert.equal(simplifyProductName('Apple iPhone 15 Pro MagSafe Case'), 'Apple iPhone 15 Pro MagSafe Case');
});

test('capitalises hand-typed lowercase catalogue names', () => {
  assert.equal(simplifyProductName('coca cola zero sugar - 330 ml'), 'Coca Cola Zero Sugar');
});

test('cuts at a restated head noun', () => {
  assert.equal(
    simplifyProductName('Tide PODS Laundry Detergent Soap Pods, Spring Meadow Scent, 112 Count'),
    'Tide Pods Laundry Detergent Soap',
  );
  assert.equal(
    simplifyProductName('Red Bull Red Edition Energy Drink'),
    'Red Bull Red Edition Energy Drink',
  );
});

// The single assertion the previous version of this test made — one well-spaced
// English sentence — could not see an unbroken word, so the budget was not an
// invariant at all.
test('the budget is an invariant, not a hope', () => {
  const inputs = [
    CREST,
    'WH1000XM5B-WirelessNoiseCancelingOverEarHeadphonesBlackSonyElectronics',
    'Rindfleischetikettierungsueberwachungsaufgabenuebertragungsgesetz Wurst',
    'ULTRAMEGASUPERLONGPRODUCTMODELNUMBERWITHOUTANYSPACES1234567890',
    '味の素こんぶダシのもと中華あじ'.repeat(4),
    'a'.repeat(300),
    'Apple iPhone 13 Pro Max 1TB Deep Purple Unlocked Smartphone (Refurbished)',
  ];
  for (const raw of inputs) {
    const out = simplifyProductName(raw);
    assert.ok([...out].length <= MAX_LENGTH, `${[...out].length} > ${MAX_LENGTH}: ${out}`);
  }
  // Random shapes, including punctuation soup and non-ASCII.
  const alphabet = "abcdefgABCDEFG0123 ,-/()äéü×'";
  for (let i = 0; i < 4000; i += 1) {
    let s = '';
    for (let n = 1 + (i % 80); n > 0; n -= 1) {
      s += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    const out = simplifyProductName(s);
    assert.ok([...out].length <= MAX_LENGTH, `${[...out].length} > ${MAX_LENGTH}: ${out}`);
  }
});

test('never ends on a connective or on punctuation', () => {
  for (const raw of [CREST, 'Widget with Extra Long Feature List and More Things Besides That']) {
    const out = simplifyProductName(raw);
    assert.ok(!/\b(with|and|for|of|the|w\/)$/i.test(out), out);
    assert.ok(!/[\s,;:|·\-–—/+&=.]$/.test(out), out);
  }
});

test('leaves a name that is already short untouched', () => {
  for (const n of ['Hammer', 'Milk', 'Cordless Drill', 'Winter Coat', 'Clear Tape', 'Hand Cream']) {
    assert.equal(simplifyProductName(n), n);
  }
});

test('is deterministic and idempotent', () => {
  const corpus = [
    CREST,
    'LANEIGE Lip Sleeping Mask Intense Hydration Lip Treatment',
    'ULTRAMEGASUPERLONGPRODUCTMODELNUMBERWITHOUTANYSPACES1234567890',
    'Samsung 65-Inch Class QLED 4K Q60D Series Quantum HDR Smart TV (QN65Q60DAFXZA, 2024 Model)',
    'Apple iPhone 13 Pro 128GB (Refurbished)',
    'NESTLÉ NESQUIK CHOCOLATE POWDER',
    'Craftsman Socket Wrench 1/2 in',
  ];
  for (const raw of corpus) {
    const once = simplifyProductName(raw);
    assert.equal(simplifyProductName(raw), once);
    assert.equal(simplifyProductName(once), once, `not idempotent: ${raw}`);
  }
});

test('returns empty for anything with nothing in it', () => {
  for (const bad of ['', '   ', null, undefined, 42, {}, '(((...)))', '()', ',,,', '- - -', '(Pack of 3)']) {
    assert.equal(simplifyProductName(bad), '');
  }
});

test('does not delete a name that is only a measurement', () => {
  assert.equal(simplifyProductName('12 fl oz'), '12 fl oz');
});

// url-extractor sets product.name from an un-truncated page <title>; the tail
// rules are unanchored on the left, so without an input cap this is quadratic.
test('a pathological title stays linear', () => {
  for (const evil of [', '.repeat(200000) + '1 strips', 'A '.repeat(400) + '1 '.repeat(400) + 'fl oz']) {
    const t0 = Date.now();
    simplifyProductName(evil);
    assert.ok(Date.now() - t0 < 250, 'simplifyProductName must stay linear');
  }
});

// A heuristic that can invent a word is one that can label the wrong box.
test('every word in the output came from the input', () => {
  const corpus = [
    CREST,
    'LANEIGE Lip Sleeping Mask Intense Hydration Lip Treatment',
    'Sony WH-1000XM5 Wireless Industry Leading Noise Canceling Headphones, Black',
    'Kirkland Signature Ultra Clean Laundry Detergent Pacs, 152-count',
    'Bounty Quick-Size Paper Towels, White, 8 Family Rolls = 20 Regular Rolls',
    'Apple iPhone 13 Pro 128GB (Refurbished)',
  ];
  for (const raw of corpus) {
    const source = new Set(
      raw.toLowerCase().replace(/[^a-z0-9\s'-]/g, ' ').split(/\s+/).filter(Boolean),
    );
    for (const w of simplifyProductName(raw).toLowerCase().replace(/[()]/g, ' ').split(/\s+/).filter(Boolean)) {
      assert.ok(source.has(w), `invented "${w}" from "${raw}"`);
    }
  }
});

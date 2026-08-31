const test = require('node:test');
const assert = require('node:assert');
const storage = require('../src/infrastructure/storage');
const disclosure = require('../src/modules/sharing/sharing.disclosure');

/**
 * What a public share link is allowed to publish (#298).
 *
 * `GET /api/sharing/_x_/view/:token` is the only endpoint in tally that answers
 * with no session at all, so everything the payload carries is readable by
 * anyone holding the URL — rendered or not. Two separate claims are pinned
 * here, and they must not be confused with each other:
 *
 *  1. FIELDS NOTHING SHOWS ARE GONE. Not a policy change — a field no consumer
 *     reads is pure exposure, so it is removed outright.
 *  2. EVERYTHING ELSE STILL SHIPS BY DEFAULT. The per-link disclosure choice
 *     starts fully on, a NULL column means "everything", and a link created
 *     before this feature publishes exactly what it published before. What a
 *     share SHOULD publish by default was Luke's call to make on #298: both
 *     the property address and the purchase price default to on, same as
 *     every other category.
 */

const logger = { info() {}, warn() {}, error() {}, debug() {} };

/** Rows for a fully-populated entity of every type — nothing is null-by-omission. */
function rowsFor(sql) {
  if (/TALLY\.condition_snapshots/i.test(sql)) {
    return [{
      ID: 5,
      CONDITION: 'good',
      PHOTO_KEY: 'snap/5.jpg',
      NOTES: 'small scuff on the lid',
      CREATED_AT: '2026-08-01T00:00:00.000Z',
      // Still selected by the fake DB so the mapper has every chance to leak it.
      RECORDED_BY_NAME: 'Household Member',
    }];
  }
  if (/TALLY\.item_files/i.test(sql)) {
    return [{ ID: 3, FILE_TYPE: 'receipt', FILE_KEY: 'f/3.pdf', FILE_NAME: 'receipt.pdf', MIME_TYPE: 'application/pdf', FILE_SIZE: 12, CREATED_AT: '2026-08-01T00:00:00.000Z' }];
  }
  if (/TALLY\.item_dates/i.test(sql)) {
    return [{ ID: 2, DATE_TYPE: 'Warranty expiry', DATE_VALUE: '2027-01-01', NOTES: 'boxed receipt' }];
  }
  if (/FROM TALLY\.items/i.test(sql)) {
    return [{
      ID: 9,
      CONTAINER_ID: 3,
      NAME: 'Drill',
      DESCRIPTION: 'cordless',
      QUANTITY: 1,
      PURCHASE_PRICE: '149.99',
      CONDITION: 'good',
      STATUS: 'active',
      QR_CODE: 'TLY-I-ABC123',
      CREATED_AT: '2026-08-01T00:00:00.000Z',
      UPDATED_AT: '2026-08-02T00:00:00.000Z',
      DEPRECIATION_ENABLED: 1,
      DEPRECIATION_RATE: '0.2000',
      PRODUCT_NAME: 'DCD777',
      PRODUCT_BRAND: 'DeWalt',
      PRODUCT_IMAGE_URL: 'https://example/img.png',
      PRODUCT_DESCRIPTION: '20V drill',
      PRODUCT_SPECS: { voltage: '20V' },
      CONTAINER_NAME: 'Tote',
      AREA_ID: 7,
      AREA_NAME: 'Garage',
      PROPERTY_ID: 1,
      PROPERTY_NAME: 'Home',
    }];
  }
  if (/FROM TALLY\.container_paths/i.test(sql)) {
    return [{ ID: 4, AREA_ID: 7, PARENT_CONTAINER_ID: 3, NAME: 'Small box', TYPE: 'box', DEPTH: 1 }];
  }
  if (/FROM TALLY\.containers/i.test(sql)) {
    return [{ ID: 3, AREA_ID: 7, PARENT_CONTAINER_ID: null, NAME: 'Tote', TYPE: 'tote', QR_CODE: 'TLY-C-1', AREA_NAME: 'Garage', PROPERTY_ID: 1, PROPERTY_NAME: 'Home' }];
  }
  if (/FROM TALLY\.areas/i.test(sql)) {
    return [{ ID: 7, PROPERTY_ID: 1, NAME: 'Garage', QR_CODE: 'TLY-A-1', PROPERTY_NAME: 'Home' }];
  }
  if (/FROM TALLY\.properties/i.test(sql)) {
    return [{ ID: 1, NAME: 'Home', ADDRESS: '221B Baker Street', DESCRIPTION: 'the house' }];
  }
  return [];
}

/** The service wired to those rows, with signing stubbed. Returns [service, seenSql]. */
function serviceWith(t) {
  t.mock.method(storage, 'getPresignedUrl', async () => 'https://signed.example/object');
  const seen = [];
  const Sharing = require('../src/modules/sharing/sharing.service');
  Sharing.init({
    db: { query: async (sql) => { seen.push(sql); return rowsFor(sql); } },
    logger,
    config: {},
  });
  return [Sharing, seen];
}

// ── 1. Removed outright: nothing renders these ──────────────────────────────

test('an item share no longer names the household member who recorded a condition check', async (t) => {
  const [Sharing, seen] = serviceWith(t);
  const env = await Sharing.getEntityForShare('item', 9);

  assert.equal(env.conditionSnapshots.length, 1, 'the snapshot itself still ships');
  assert.ok(!('recordedByName' in env.conditionSnapshots[0]), 'recordedByName must be gone');
  assert.ok(
    !/recordedByName/.test(JSON.stringify(env)),
    'and gone from the whole payload, not just moved',
  );

  const snapshotSql = seen.find((s) => /TALLY\.condition_snapshots/i.test(s));
  assert.ok(
    !/JOIN TALLY\.users/i.test(snapshotSql),
    'the public route should not read TALLY.users for snapshots at all any more',
  );
});

test('a property, area or container share no longer prices every item in it', async (t) => {
  const [Sharing, seen] = serviceWith(t);

  for (const type of ['property', 'area', 'container']) {
    const env = await Sharing.getEntityForShare(type, 1);
    assert.ok(env.items.length, `${type} share still lists its items`);
    assert.ok(
      !('purchasePrice' in env.items[0]),
      `${type} share must not carry a purchase price per item — nothing renders one`,
    );
  }

  assert.ok(
    !seen.some((s) => /PURCHASE_PRICE/i.test(s) && /JOIN TALLY\.containers|JOIN TALLY\.areas|JOIN TALLY\.container_paths/i.test(s)),
    'and the list queries should not select it either',
  );
});

test('an item share still carries its own purchase price — that one is rendered', async (t) => {
  const [Sharing] = serviceWith(t);
  const env = await Sharing.getEntityForShare('item', 9);
  assert.equal(env.item.purchasePrice, 149.99, 'ItemView shows this; it is a policy question, not dead weight');
});

test('an item share drops the depreciation model and the raw product spec blob', async (t) => {
  const [Sharing] = serviceWith(t);
  const env = await Sharing.getEntityForShare('item', 9);
  for (const key of ['depreciationEnabled', 'depreciationRate', 'productSpecs']) {
    assert.ok(!(key in env.item), `${key} is never read by share-view.tsx`);
  }
  assert.equal(env.item.productName, 'DCD777', 'the catalogue fields the page does read stay');
});

// ── 2. Defaults are exactly today's behaviour ───────────────────────────────

test('with no disclosure stored, a share publishes everything it can', async (t) => {
  const [Sharing] = serviceWith(t);

  const property = await Sharing.getEntityForShare('property', 1);
  assert.equal(property.property.address, '221B Baker Street');

  const item = await Sharing.getEntityForShare('item', 9);
  assert.equal(item.files.length, 1);
  assert.equal(item.dates.length, 1);
  assert.equal(item.conditionSnapshots.length, 1);
  assert.equal(item.item.purchasePrice, 149.99);
  assert.equal(item.item.breadcrumb.length, 3);
});

test('a NULL, empty or unreadable DISCLOSURE all mean "share everything"', () => {
  for (const stored of [null, undefined, '', 'not json', '[]', '{}']) {
    const resolved = disclosure.resolve(stored, 'item');
    assert.ok(Object.keys(resolved).length, 'item has optional categories');
    assert.ok(
      Object.values(resolved).every((v) => v === true),
      `${JSON.stringify(stored)} must not narrow what an existing link publishes`,
    );
  }
});

test('a stored choice that predates a category keeps that category on', () => {
  const resolved = disclosure.resolve({ files: false }, 'item');
  assert.equal(resolved.files, false, 'the explicit no is honoured');
  assert.equal(resolved.purchasePrice, true, 'a key that is simply absent stays on');
});

test('an untouched dialog stores NULL — a row indistinguishable from a pre-#298 link', () => {
  assert.equal(disclosure.normalizeChoice(null, 'item'), null);
  assert.equal(disclosure.normalizeChoice({}, 'item'), null);
  assert.deepEqual(
    disclosure.normalizeChoice({ files: false, nonsense: true }, 'item'),
    { files: false },
    'only real categories for this entity type are stored',
  );
  assert.equal(
    disclosure.normalizeChoice({ address: false }, 'item'),
    null,
    'a category that does not apply to this type is not a choice',
  );
});

// ── 3. The catalogue is derived from the payload, not decorative ────────────

test('every optional category actually removes something from a real payload', async (t) => {
  const [Sharing] = serviceWith(t);

  for (const type of disclosure.ENTITY_TYPES) {
    const optional = disclosure.categoriesFor(type).filter((c) => c.optional);
    assert.ok(optional.length, `${type} shares must offer at least one choice`);

    const all = JSON.stringify(await Sharing.getEntityForShare(type, 1));
    for (const cat of optional) {
      const stripped = JSON.stringify(
        await Sharing.getEntityForShare(type, 1, { [cat.key]: false }),
      );
      assert.notEqual(
        stripped,
        all,
        `"${cat.label}" is offered on a ${type} share but turning it off changes nothing — ` +
          'the dialog would be describing data it cannot actually withhold',
      );
    }
  }
});

test('a category the sharer turned off is absent from the public payload', async (t) => {
  const [Sharing] = serviceWith(t);

  const property = await Sharing.getEntityForShare('property', 1, { address: false });
  assert.equal(property.property.address, null, 'the street address is withheld');
  assert.equal(property.property.name, 'Home', 'the rest of the share is untouched');

  const item = await Sharing.getEntityForShare('item', 9, {
    files: false,
    dates: false,
    conditionHistory: false,
    purchasePrice: false,
    location: false,
  });
  assert.deepEqual(item.files, [], 'no presigned receipt URLs travel');
  assert.deepEqual(item.dates, []);
  assert.deepEqual(item.conditionSnapshots, []);
  assert.equal(item.item.purchasePrice, null);
  assert.deepEqual(item.item.breadcrumb, []);
  assert.equal(item.item.name, 'Drill', 'the item itself is still the point of the link');
});

test('the catalogue the dialog reads names only categories that apply to that type', () => {
  const cat = disclosure.catalogue();
  assert.deepEqual(Object.keys(cat).sort(), ['area', 'container', 'item', 'property']);
  assert.ok(cat.property.some((c) => c.key === 'address'), 'only a property share has an address');
  assert.ok(!cat.item.some((c) => c.key === 'address'));
  assert.ok(
    cat.container.every((c) => c.key !== 'purchasePrice'),
    'a container share no longer carries prices, so it must not offer to hide them',
  );
  for (const rows of Object.values(cat)) {
    for (const row of rows) {
      assert.equal(row.defaultValue, true, 'every category defaults to on — today\'s behaviour');
      assert.ok(row.label && row.detail, 'a category with no plain-language text tells the sharer nothing');
      assert.equal(typeof row.strip, 'undefined', 'no functions may cross the wire');
    }
  }
});

// ── 4. Defaults are declared per category, not implied by the enforcement ───
//
// Before this, "on" was simply what the absence of a decision meant: the strip
// ran when a stored key was explicitly `false`, and nothing else. There was no
// default to change, so changing one meant a four-part edit across server and
// client. Each optional category now states its own, and the resolver consults
// it — but only ever for a NEW link (see section 5).

test('every optional category declares an explicit boolean default', () => {
  for (const cat of disclosure.CATEGORIES) {
    if (!cat.optional) {
      assert.equal(
        cat.defaultOn,
        undefined,
        `"${cat.key}" cannot be turned off, so it has no default to state`,
      );
      continue;
    }
    assert.equal(
      typeof cat.defaultOn,
      'boolean',
      `"${cat.key}" must state defaultOn explicitly — an undefined default reads ` +
        'as falsy and would ship the category OFF by accident, which is the whole ' +
        'class of bug this module exists to prevent',
    );
  }
});

test('every default is ON, address and purchasePrice included — #298 decided both', () => {
  for (const type of disclosure.ENTITY_TYPES) {
    for (const [key, on] of Object.entries(disclosure.defaultChoice(type))) {
      assert.equal(
        on,
        true,
        `${type}.${key} must default to on — a category flipping off is a separate, ` +
          'deliberate decision, not something this test should let slide by silently',
      );
    }
  }
});

// #298 named two categories as genuinely undecided while every other category
// shipped on by default without controversy: `address` (a property's street
// address) and `purchasePrice` (what an item cost). Luke's answer was on for
// both — a share defaults to disclosing, and a sharer who wants either
// withheld opts out per link. This pins that specific decision, separately
// from "every default is on" above, so a future edit to just these two lines
// fails a test with #298's reasoning attached, not a generic assertion.
test('address and purchasePrice default ON — the #298 decision, not a placeholder', () => {
  const address = disclosure.CATEGORIES.find((c) => c.key === 'address');
  const purchasePrice = disclosure.CATEGORIES.find((c) => c.key === 'purchasePrice');
  assert.equal(address.defaultOn, true, 'a property share publishes the address by default');
  assert.equal(purchasePrice.defaultOn, true, 'an item share publishes the purchase price by default');
});

test('the catalogue the dialog pre-ticks from reports the server\'s actual default', async () => {
  await withDefaults({ address: false }, () => {
    const cat = disclosure.catalogue();
    assert.equal(
      cat.property.find((c) => c.key === 'address').defaultValue,
      false,
      'a changed default must reach the dialog, or the sharer sees a tick that lies ' +
        'about what the server is going to publish',
    );
    assert.equal(
      cat.item.find((c) => c.key === 'files').defaultValue,
      true,
      'and only that one moves',
    );
  });
});

// ── 5. THE INVARIANT: a default change never reaches a link that exists ─────
//
// Share URLs are in other people's hands. A link issued as "here is the
// address" must not silently become one that is not — and, far worse, a link
// issued while a category was off must never start publishing it. So a default
// applies at CREATE time only: resolve() never consults one, which makes a
// stored NULL (every link from before the column existed) permanently mean
// "everything".
//
// These tests flip every default to false — the most aggressive answer #298
// could give — and require that nothing already issued moves. They are what
// makes the eventual decision safe to take.

/** Runs `fn` with the named categories' defaults overridden, then restores. */
async function withDefaults(overrides, fn) {
  const saved = new Map();
  for (const cat of disclosure.CATEGORIES) {
    if (cat.optional && overrides[cat.key] !== undefined) {
      saved.set(cat, cat.defaultOn);
      cat.defaultOn = overrides[cat.key];
    }
  }
  try {
    return await fn();
  } finally {
    for (const [cat, was] of saved) cat.defaultOn = was;
  }
}

/** Every optional category off. */
function allDefaultsOff() {
  return Object.fromEntries(
    disclosure.CATEGORIES.filter((c) => c.optional).map((c) => [c.key, false]),
  );
}

/** Every shape a DISCLOSURE column can already hold on a link that is live. */
const EXISTING_LINKS = [
  ['a pre-#298 row, DISCLOSURE NULL', null],
  ['a column that was never written', undefined],
  ['an empty string', ''],
  ['an unreadable value', 'not json'],
  ['a JSON array', '[]'],
  ['an empty JSON object', '{}'],
  ['a parsed object with no keys', {}],
  ['a sharer who turned receipts off', { files: false }],
  ['a sharer who turned the location off', { location: false }],
];

test('resolve() never consults a default — absence is a settled yes, forever', async () => {
  await withDefaults(allDefaultsOff(), () => {
    assert.ok(
      Object.values(disclosure.defaultChoice('item')).every((v) => v === false),
      'the override did not apply — everything below would pass for the wrong reason',
    );

    for (const [label, stored] of EXISTING_LINKS.slice(0, 7)) {
      const resolved = disclosure.resolve(stored, 'item');
      assert.ok(Object.keys(resolved).length, 'item shares have optional categories');
      assert.ok(
        Object.values(resolved).every((v) => v === true),
        `${label}: must still publish everything with every default off`,
      );
    }

    const partial = disclosure.resolve({ files: false }, 'item');
    assert.equal(partial.files, false, 'the sharer\'s explicit no is still honoured');
    assert.equal(
      partial.purchasePrice,
      true,
      'a key absent from a stored object stays ON even though its default is now OFF — ' +
        'that link was issued under a catalogue where it was on',
    );
  });
});

test('flipping every default cannot change what an already-issued link publishes', async (t) => {
  const [Sharing] = serviceWith(t);
  const idFor = (type) => (type === 'item' ? 9 : 1);

  // What each of those links publishes today, with defaults as shipped.
  const before = [];
  for (const type of disclosure.ENTITY_TYPES) {
    for (const [, stored] of EXISTING_LINKS) {
      before.push(JSON.stringify(await Sharing.getEntityForShare(type, idFor(type), stored)));
    }
  }

  await withDefaults(allDefaultsOff(), async () => {
    assert.ok(
      Object.values(disclosure.defaultChoice('property')).every((v) => v === false),
      'the override did not apply — everything below would pass for the wrong reason',
    );

    let n = 0;
    for (const type of disclosure.ENTITY_TYPES) {
      for (const [label, stored] of EXISTING_LINKS) {
        const after = JSON.stringify(await Sharing.getEntityForShare(type, idFor(type), stored));
        assert.equal(
          after,
          before[n++],
          `${type} share, ${label}: a default change leaked backwards into a link that ` +
            'already exists. Whoever holds that URL agreed to nothing of the sort.',
        );
      }
    }
  });
});

test('a NEW link does follow the default, even when the client sends nothing', async () => {
  await withDefaults({ address: false }, () => {
    assert.deepEqual(
      disclosure.normalizeChoice(null, 'property'),
      { address: false },
      'a create carrying no disclosure at all must still record the default — storing ' +
        'NULL would mean "publish everything", permanently, and quietly bypass the policy',
    );
    assert.deepEqual(
      disclosure.normalizeChoice({ address: true }, 'property'),
      { address: true },
      'a sharer who deliberately re-ticks it is recorded as having said yes',
    );
  });

  await withDefaults({ purchasePrice: false }, () => {
    assert.deepEqual(
      disclosure.normalizeChoice({ files: false }, 'item'),
      { purchasePrice: false, files: false },
      'a default the client never mentioned is still applied alongside the choice it did send',
    );
  });
});

// ── 6. Nothing a recipient can see has moved ───────────────────────────────

/**
 * The exact public payload this branch built for each entity type BEFORE
 * per-category defaults existed, captured from the same fake rows above and
 * checked in verbatim.
 *
 * Its whole job is to be boring: any change to what a share link publishes has
 * to surface here, as a diff a reviewer reads, instead of in a stranger's
 * browser. If a future PR does deliberately change the payload, this is the
 * fixture to update — in that PR, on purpose, not as a drive-by.
 */
const GOLDEN_PUBLIC_PAYLOAD = {
    "property": {
      "type": "property",
      "property": {
        "id": 1,
        "name": "Home",
        "address": "221B Baker Street",
        "description": "the house"
      },
      "areas": [
        {
          "id": 7,
          "name": "Garage",
          "description": null,
          "qrCode": "TLY-A-1"
        }
      ],
      "containers": [
        {
          "id": 3,
          "areaId": 7,
          "parentContainerId": null,
          "name": "Tote",
          "type": "tote",
          "description": null,
          "qrCode": "TLY-C-1"
        }
      ],
      "items": [
        {
          "id": 9,
          "containerId": 3,
          "name": "Drill",
          "description": "cordless",
          "quantity": 1,
          "condition": "good",
          "status": "active",
          "qrCode": "TLY-I-ABC123",
          "createdAt": "2026-08-01T00:00:00.000Z",
          "productName": "DCD777",
          "productBrand": "DeWalt",
          "productImageUrl": "https://example/img.png"
        }
      ]
    },
    "area": {
      "type": "area",
      "area": {
        "id": 7,
        "propertyId": 1,
        "propertyName": "Home",
        "name": "Garage",
        "description": null,
        "qrCode": "TLY-A-1"
      },
      "containers": [
        {
          "id": 3,
          "parentContainerId": null,
          "name": "Tote",
          "type": "tote",
          "description": null,
          "qrCode": "TLY-C-1"
        }
      ],
      "items": [
        {
          "id": 9,
          "containerId": 3,
          "name": "Drill",
          "description": "cordless",
          "quantity": 1,
          "condition": "good",
          "status": "active",
          "qrCode": "TLY-I-ABC123",
          "createdAt": "2026-08-01T00:00:00.000Z",
          "productName": "DCD777",
          "productBrand": "DeWalt",
          "productImageUrl": "https://example/img.png"
        }
      ]
    },
    "container": {
      "type": "container",
      "container": {
        "id": 3,
        "areaId": 7,
        "areaName": "Garage",
        "propertyId": 1,
        "propertyName": "Home",
        "parentContainerId": null,
        "name": "Tote",
        "type": "tote",
        "description": null,
        "qrCode": "TLY-C-1"
      },
      "nestedContainers": [
        {
          "id": 4,
          "areaId": 7,
          "parentContainerId": 3,
          "name": "Small box",
          "type": "box",
          "description": null,
          "qrCode": null,
          "depth": 1
        }
      ],
      "items": [
        {
          "id": 9,
          "containerId": 3,
          "name": "Drill",
          "description": "cordless",
          "quantity": 1,
          "condition": "good",
          "status": "active",
          "qrCode": "TLY-I-ABC123",
          "createdAt": "2026-08-01T00:00:00.000Z",
          "productName": "DCD777",
          "productBrand": "DeWalt",
          "productImageUrl": "https://example/img.png"
        }
      ]
    },
    "item": {
      "type": "item",
      "item": {
        "id": 9,
        "name": "Drill",
        "description": "cordless",
        "quantity": 1,
        "purchasePrice": 149.99,
        "condition": "good",
        "status": "active",
        "qrCode": "TLY-I-ABC123",
        "createdAt": "2026-08-01T00:00:00.000Z",
        "updatedAt": "2026-08-02T00:00:00.000Z",
        "productName": "DCD777",
        "productBrand": "DeWalt",
        "productImageUrl": "https://example/img.png",
        "productDescription": "20V drill",
        "breadcrumb": [
          {
            "id": 1,
            "name": "Home",
            "type": "property"
          },
          {
            "id": 7,
            "name": "Garage",
            "type": "area"
          },
          {
            "id": 3,
            "name": "Tote",
            "type": "container"
          }
        ]
      },
      "conditionSnapshots": [
        {
          "id": 5,
          "condition": "good",
          "notes": "small scuff on the lid",
          "createdAt": "2026-08-01T00:00:00.000Z",
          "photoUrl": "https://signed.example/object"
        }
      ],
      "files": [
        {
          "id": 3,
          "fileType": "receipt",
          "fileName": "receipt.pdf",
          "mimeType": "application/pdf",
          "fileSize": 12,
          "createdAt": "2026-08-01T00:00:00.000Z",
          "url": "https://signed.example/object"
        }
      ],
      "dates": [
        {
          "id": 2,
          "dateType": "Warranty expiry",
          "dateValue": "2027-01-01",
          "notes": "boxed receipt"
        }
      ]
    }
  };

test('with every default ON the public payload is byte-identical to the pre-defaults branch', async (t) => {
  const [Sharing] = serviceWith(t);

  for (const type of disclosure.ENTITY_TYPES) {
    const envelope = await Sharing.getEntityForShare(type, type === 'item' ? 9 : 1);
    assert.equal(
      JSON.stringify(envelope, null, 2),
      JSON.stringify(GOLDEN_PUBLIC_PAYLOAD[type], null, 2),
      `the ${type} share payload changed — this PR must alter nothing a recipient sees`,
    );
  }
});

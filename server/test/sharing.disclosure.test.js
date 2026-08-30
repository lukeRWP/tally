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
 *     share SHOULD publish by default is still Luke's call on #298.
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

const test = require('node:test');
const assert = require('node:assert');

// The share viewer renders off a discriminated envelope. It once branched on
// `data.entityType` — a key this service has never produced — so EVERY share
// link rendered a blank page. These tests pin the contract the client relies
// on: a `type` discriminator plus the nested payload key it names.
function fakeDb(handler) {
  return { query: async (sql, params) => handler(sql, params) };
}
const logger = { info() {}, warn() {}, error() {}, debug() {} };

function serviceWith(rows) {
  const Sharing = require('../src/modules/sharing/sharing.service');
  Sharing.init({ db: fakeDb((sql) => rows(sql)), logger, config: {} });
  return Sharing;
}

test('item share envelope carries type + nested item payload', async () => {
  const Sharing = serviceWith((sql) =>
    /FROM TALLY\.items/i.test(sql)
      ? [{ ID: 1, NAME: 'Exam Gloves', QUANTITY: 100, QR_CODE: 'TLY-I-59C8985A' }]
      : []);
  const env = await Sharing.getEntityForShare('item', 1);
  assert.equal(env.type, 'item', 'discriminator must be `type`');
  assert.equal(env.entityType, undefined, 'must NOT be `entityType` — the client bug');
  assert.ok(env.item && env.item.name === 'Exam Gloves', 'payload nests under `item`');
  assert.ok(Array.isArray(env.files) && Array.isArray(env.dates));
});

test('container share nests under `container` with nestedContainers + items', async () => {
  const Sharing = serviceWith((sql) =>
    /FROM TALLY\.containers/i.test(sql) ? [{ ID: 1, NAME: 'Tote', TYPE: 'Drawer' }] : []);
  const env = await Sharing.getEntityForShare('container', 1);
  assert.equal(env.type, 'container');
  assert.ok(env.container && env.container.name === 'Tote');
  assert.ok(Array.isArray(env.nestedContainers), '`nestedContainers`, not `children`');
  assert.ok(Array.isArray(env.items));
});

test('area shares are supported by the service (the client just never rendered them)', async () => {
  const Sharing = serviceWith((sql) =>
    /FROM TALLY\.areas/i.test(sql) ? [{ ID: 1, NAME: 'Coat Closet' }] : []);
  const env = await Sharing.getEntityForShare('area', 1);
  assert.equal(env.type, 'area');
  assert.ok(env.area && env.area.name === 'Coat Closet');
});

// ── Public framing (#282) ───────────────────────────────────────────────────
// The public page has to tell a stranger who shared this and when it stops
// working. Both come off the share_links row that validate() already reads, so
// the only new cost is a LEFT JOIN for the sharer's display name.

test('validate() returns the sharer name and expiry the public page frames itself with', async () => {
  const Sharing = serviceWith(() => [{
    ENTITY_TYPE: 'container',
    ENTITY_ID: 4,
    CREATED_BY: 1,
    CREATED_BY_NAME: 'Luke Turner',
    EXPIRES_AT: '2026-09-05T00:00:00.000Z',
    CREATED_AT: '2026-08-29T00:00:00.000Z',
  }]);
  const t = await Sharing.validate('tok');
  assert.equal(t.entityType, 'container');
  assert.equal(t.createdByName, 'Luke Turner');
  assert.equal(t.expiresAt, '2026-09-05T00:00:00.000Z');
});

test('validate() requires the creator to still be a member — a link does NOT outlive their standing', async () => {
  // Reversed by #349. This test used to pin a LEFT join on users so that a
  // link survived its creator's row going away; the deep dive found that the
  // same property let a removed editor's links keep opening the household's
  // inventory indefinitely. Now the link's property is resolved and its
  // creator must still hold a property_members row there. With that inner
  // join in place the users join can be inner too — every surviving row has
  // a sharer to name — and the mapper still tolerates a NULL name.
  let seen = '';
  const Sharing = serviceWith((sql) => {
    seen = sql;
    return [{ ENTITY_TYPE: 'item', ENTITY_ID: 9, CREATED_BY: 77, CREATED_BY_NAME: null, EXPIRES_AT: null, CREATED_AT: null }];
  });
  const t = await Sharing.validate('tok');
  assert.match(seen, /(?<!LEFT )JOIN TALLY\.property_members pm ON [\s\S]*?pm\.USER_ID = s\.CREATED_BY/i, 'membership recheck is an INNER join');
  assert.doesNotMatch(seen, /LEFT JOIN TALLY\.users/i);
  assert.equal(t.createdByName, null, 'null, not the string "null" — the page omits the line');
  assert.equal(t.expiresAt, null);
});

test('validate() still refuses an expired or unknown token', async () => {
  const Sharing = serviceWith(() => []);
  assert.equal(await Sharing.validate('nope'), null);
});

// ── No third-party names on a public page (#298) ────────────────────────────
// An item share used to map `u.DISPLAY_NAME AS RECORDED_BY_NAME` onto every
// condition snapshot: a SECOND household member's name, published to anyone
// holding the URL, on a page that has never rendered it. These tests are a
// privacy regression guard — they must fail loudly if the field, or the users
// join that feeds it, comes back.

const storage = require('../src/infrastructure/storage');

function itemShareDb(t, { snapshots = [], captureSql = null } = {}) {
  t.mock.method(storage, 'getPresignedUrl', async () => 'https://example.invalid/signed');
  return serviceWith((sql) => {
    if (captureSql) captureSql(sql);
    if (/FROM TALLY\.condition_snapshots/i.test(sql)) return snapshots;
    if (/FROM TALLY\.items/i.test(sql)) {
      return [{ ID: 9, NAME: 'Circular Saw', QUANTITY: 1, QR_CODE: 'TLY-I-1A2B3C' }];
    }
    return [];
  });
}

test('public item share publishes NO recordedByName on a condition snapshot', async (t) => {
  // The row still HAS the column shape a users join would have produced — the
  // guard is that the mapper refuses to carry it, not that the row lacks it.
  const Sharing = itemShareDb(t, {
    snapshots: [{
      ID: 3,
      CONDITION: 'good',
      PHOTO_KEY: 'cond/3.jpg',
      NOTES: 'Blade guard sticks a little',
      CREATED_AT: '2026-08-01T00:00:00.000Z',
      RECORDED_BY_NAME: 'Dana Turner',
      RECORDED_BY: 42,
    }],
  });

  const env = await Sharing.getEntityForShare('item', 9);
  const snap = env.conditionSnapshots[0];

  assert.ok(snap, 'the snapshot must still be published — only the name goes');
  assert.equal(snap.condition, 'good');
  assert.equal(snap.notes, 'Blade guard sticks a little');
  assert.ok(snap.photoUrl, 'the photo still gets a presigned URL');

  assert.ok(!('recordedByName' in snap), 'recordedByName must not be on a public snapshot');
  assert.ok(!('recordedBy' in snap), 'nor the user id it was derived from');

  // Belt and braces: no key anywhere on the snapshot may carry the name, under
  // any spelling. Re-adding it as `author`/`by`/`snapshotByName` fails here too.
  const serialised = JSON.stringify(snap);
  assert.ok(
    !/Dana Turner/.test(serialised),
    `a household member's name leaked onto the public payload: ${serialised}`
  );
});

test('the public snapshot query does not read TALLY.users at all', async (t) => {
  let snapshotSql = '';
  const Sharing = itemShareDb(t, {
    snapshots: [],
    captureSql: (sql) => {
      if (/FROM TALLY\.condition_snapshots/i.test(sql)) snapshotSql = sql;
    },
  });

  await Sharing.getEntityForShare('item', 9);

  assert.ok(snapshotSql, 'the snapshot query must have run');
  assert.ok(
    !/TALLY\.users/i.test(snapshotSql),
    'no users join on the public path — the name must be unreachable, not merely unmapped'
  );
});

test('no household-member name rides anywhere on the public item envelope', async (t) => {
  const Sharing = itemShareDb(t, {
    snapshots: [{
      ID: 3,
      CONDITION: 'fair',
      PHOTO_KEY: 'cond/3.jpg',
      NOTES: null,
      CREATED_AT: '2026-08-01T00:00:00.000Z',
      RECORDED_BY_NAME: 'Dana Turner',
    }],
  });

  const env = await Sharing.getEntityForShare('item', 9);
  assert.ok(
    !/Dana Turner/.test(JSON.stringify(env)),
    'a name from a users row must not appear anywhere in the public item envelope'
  );
});

test('property share sends FLAT child arrays that carry parent ids for stitching', async () => {
  const Sharing = serviceWith((sql) => {
    if (/FROM TALLY\.properties/i.test(sql)) return [{ ID: 1, NAME: "Luke's Apartment" }];
    if (/FROM TALLY\.areas/i.test(sql)) return [{ ID: 7, NAME: 'Coat Closet' }];
    if (/FROM TALLY\.containers/i.test(sql)) return [{ ID: 3, AREA_ID: 7, PARENT_CONTAINER_ID: null, NAME: 'Tote' }];
    if (/FROM TALLY\.items/i.test(sql)) return [{ ID: 9, CONTAINER_ID: 3, NAME: 'Gloves' }];
    return [];
  });
  const env = await Sharing.getEntityForShare('property', 1);
  assert.equal(env.type, 'property');
  assert.ok(env.property && env.property.name === "Luke's Apartment");
  // The client stitches the tree itself, so these ids are load-bearing.
  assert.equal(env.containers[0].areaId, 7, 'containers must expose areaId');
  assert.equal(env.items[0].containerId, 3, 'items must expose containerId');
  assert.ok('parentContainerId' in env.containers[0], 'containers must expose parentContainerId');
});

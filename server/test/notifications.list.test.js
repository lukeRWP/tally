const test = require('node:test');
const assert = require('node:assert');
const Notifications = require('../src/modules/notifications/notifications.service');

// Notification clicks were landing on Home (#237): item_date / item_lending
// notifications store the *source-row* id in ENTITY_ID (the dedup key needs
// it), which the client cannot navigate to. getForUser now resolves the
// owning item at read time via conditional LEFT JOINs and projects it as
// ITEM_ID → itemId. Creation/dedup live in notifications.dedupe.test.js.

const logger = { warn() {}, info() {}, error() {} };

test('getForUser joins the source rows read-time and stays user-scoped', async () => {
  let sql = '', params = null;
  Notifications.init({
    db: { query: async (s, p) => { sql = s; params = p; return []; } },
    logger,
  });
  await Notifications.getForUser(42);

  assert.match(sql, /LEFT JOIN TALLY\.item_dates d\s+ON n\.ENTITY_TYPE = 'item_date'\s+AND d\.ID\s+= n\.ENTITY_ID/, 'date join conditioned on entity type');
  assert.match(sql, /LEFT JOIN TALLY\.item_lending il ON n\.ENTITY_TYPE = 'item_lending' AND il\.ID = n\.ENTITY_ID/, 'lending join conditioned on entity type');
  assert.match(sql, /COALESCE\(d\.ITEM_ID, il\.ITEM_ID\) AS ITEM_ID/, 'one projected ITEM_ID');
  assert.match(sql, /WHERE n\.USER_ID = \? AND n\.DISMISSED_AT IS NULL/, 'scoped to the requesting user, dismissed rows hidden');
  assert.deepEqual(params, [42, 50, 0]);
});

test('getForUser keeps the unreadOnly filter on the aliased table', async () => {
  let sql = '';
  Notifications.init({
    db: { query: async (s) => { sql = s; return []; } },
    logger,
  });
  await Notifications.getForUser(42, { unreadOnly: true });
  assert.match(sql, /AND n\.READ_AT IS NULL/);
  assert.match(sql, /ORDER BY n\.CREATED_AT DESC/);
});

test('a date notification maps the joined item as itemId (ENTITY_ID stays the date row)', async () => {
  Notifications.init({
    db: {
      query: async () => [{
        ID: 1, USER_ID: 42, TYPE: 'custom_date', TITLE: 'Upcoming: Warranty',
        MESSAGE: 'Drill — Warranty on Sep 1, 2026', ENTITY_TYPE: 'item_date',
        ENTITY_ID: 9, ITEM_ID: 77, READ_AT: null, CREATED_AT: '2026-08-28',
      }],
    },
    logger,
  });
  const [n] = await Notifications.getForUser(42);
  assert.equal(n.itemId, 77);
  assert.equal(n.entityType, 'item_date');
  assert.equal(n.entityId, 9, 'dedup key untouched — still the item_dates row id');
});

test('a lending notification maps the joined item as itemId', async () => {
  Notifications.init({
    db: {
      query: async () => [{
        ID: 2, USER_ID: 42, TYPE: 'lending_due', TITLE: 'Overdue: Drill',
        MESSAGE: 'Drill lent to Bob was due Aug 1, 2026', ENTITY_TYPE: 'item_lending',
        ENTITY_ID: 5, ITEM_ID: 88, READ_AT: null, CREATED_AT: '2026-08-28',
      }],
    },
    logger,
  });
  const [n] = await Notifications.getForUser(42);
  assert.equal(n.itemId, 88);
  assert.equal(n.entityId, 5);
});

test('a deleted source row and a plain entity type both yield itemId null', async () => {
  Notifications.init({
    db: {
      query: async () => [
        // item_date whose item_dates row was deleted — LEFT JOIN missed.
        { ID: 3, USER_ID: 42, TYPE: 'custom_date', TITLE: 'Upcoming: Service',
          MESSAGE: 'gone', ENTITY_TYPE: 'item_date', ENTITY_ID: 999,
          ITEM_ID: null, READ_AT: null, CREATED_AT: '2026-08-28' },
        // ordinary item notification — joins never match.
        { ID: 4, USER_ID: 42, TYPE: 'item_moved', TITLE: 'Item moved',
          MESSAGE: 'moved', ENTITY_TYPE: 'item', ENTITY_ID: 12,
          ITEM_ID: null, READ_AT: null, CREATED_AT: '2026-08-28' },
      ],
    },
    logger,
  });
  const [gone, plain] = await Notifications.getForUser(42);
  assert.equal(gone.itemId, null);
  assert.equal(plain.itemId, null);
  assert.equal(plain.entityId, 12, 'plain entities still navigate by ENTITY_ID');
});

test('create() rows (no ITEM_ID column) map itemId null, not undefined', async () => {
  Notifications.init({
    db: {
      query: async (sql) => {
        if (/SELECT ENABLED/.test(sql)) return [{ ENABLED: 1 }];
        if (/INSERT INTO TALLY\.notifications/.test(sql)) return { insertId: 7 };
        return [{ ID: 7, USER_ID: 42, TYPE: 'custom_date', TITLE: 't', MESSAGE: 'm',
                  ENTITY_TYPE: 'item_date', ENTITY_ID: 9, READ_AT: null, CREATED_AT: '2026-08-28' }];
      },
    },
    logger,
  });
  const created = await Notifications.create(42, 'custom_date', 't', 'm', 'item_date', 9);
  assert.strictEqual(created.itemId, null);
});

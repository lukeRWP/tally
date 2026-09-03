const test = require('node:test');
const assert = require('node:assert');
const Notifications = require('../src/modules/notifications/notifications.service');
const { NOTIFICATION_TYPES, updatePreference } = require('../src/modules/notifications/notifications.schema');

// #348: a date inside its 30-day window notified every day (24h dedupe),
// dismiss was a hard DELETE so a dismissed one came straight back, deleted
// items kept notifying, and four of six preference toggles had no producer.

const silent = { warn() {}, info() {}, error() {} };

// A fake db that answers by regex, records every call, and can be told what a
// dedupe SELECT returns. `insert` is what the INSERT resolves/throws with.
function fakeDb({ upcoming = [], overdue = [], existing = [], insert = { insertId: 7 } } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM TALLY\.item_dates id/.test(sql)) return upcoming;
      if (/FROM TALLY\.item_lending il\s+JOIN/.test(sql)) return overdue;
      if (/SELECT ID FROM TALLY\.notifications/.test(sql)) return existing;
      if (/SELECT ENABLED/.test(sql)) return [{ ENABLED: 1 }];
      if (/INSERT INTO TALLY\.notifications/.test(sql)) {
        if (insert instanceof Error) throw insert;
        return insert;
      }
      if (/SELECT \* FROM TALLY\.notifications WHERE ID/.test(sql)) {
        return [{ ID: 7, USER_ID: 42, TYPE: 'custom_date', TITLE: 't', MESSAGE: 'm',
                  ENTITY_TYPE: 'item_date', ENTITY_ID: 9, DUE_ON: '2026-09-20', READ_AT: null, CREATED_AT: '2026-09-02' }];
      }
      return [];
    },
  };
}

const upcomingRow = { ID: 9, ITEM_ID: 77, DATE_TYPE: 'Warranty', DATE_VALUE: new Date('2026-09-20T00:00:00Z'), DUE_ON: '2026-09-20', ITEM_NAME: 'Drill' };
const overdueRow = { ID: 5, ITEM_ID: 88, DUE_AT: new Date('2026-08-01T12:00:00Z'), LENT_TO: 'Bob', DUE_ON: '2026-08-01', ITEM_NAME: 'Ladder' };

test('upcoming dates: dedupe key is (entity, due date), not a 24h window, and deleted items are excluded', async () => {
  const db = fakeDb({ upcoming: [upcomingRow] });
  Notifications.init({ db, logger: silent });
  await Notifications.checkDateNotifications(42);

  const source = db.calls.find((c) => /FROM TALLY\.item_dates id/.test(c.sql));
  assert.match(source.sql, /i\.DELETED_AT IS NULL/, 'soft-deleted items do not notify');
  assert.match(source.sql, /BETWEEN CURDATE\(\) AND DATE_ADD\(CURDATE\(\), INTERVAL 30 DAY\)/, 'a date due today is still upcoming');
  assert.match(source.sql, /DATE_FORMAT\(id\.DATE_VALUE, '%Y-%m-%d'\) AS DUE_ON/);

  const dedupe = db.calls.find((c) => /SELECT ID FROM TALLY\.notifications/.test(c.sql));
  assert.match(dedupe.sql, /AND DUE_ON = \?/);
  assert.doesNotMatch(dedupe.sql, /INTERVAL 24 HOUR/, 'no time window — once per due date');
  assert.doesNotMatch(dedupe.sql, /DISMISSED_AT/, 'a dismissed row still counts as sent');
  assert.deepEqual(dedupe.params, [42, 9, '2026-09-20']);

  const insert = db.calls.find((c) => /INSERT INTO TALLY\.notifications/.test(c.sql));
  assert.match(insert.sql, /ENTITY_ID, DUE_ON\)/);
  assert.equal(insert.params.at(-1), '2026-09-20', 'the same DUE_ON string the dedupe checked');
});

test('overdue lendings: same key, same filters', async () => {
  const db = fakeDb({ overdue: [overdueRow] });
  Notifications.init({ db, logger: silent });
  await Notifications.checkDateNotifications(42);

  const source = db.calls.find((c) => /FROM TALLY\.item_lending il\s+JOIN/.test(c.sql));
  assert.match(source.sql, /i\.DELETED_AT IS NULL/);
  assert.match(source.sql, /DATE_FORMAT\(il\.DUE_AT, '%Y-%m-%d'\) AS DUE_ON/);

  const dedupe = db.calls.find((c) => /SELECT ID FROM TALLY\.notifications/.test(c.sql));
  assert.deepEqual(dedupe.params, [42, 5, '2026-08-01']);
  const insert = db.calls.find((c) => /INSERT INTO TALLY\.notifications/.test(c.sql));
  assert.deepEqual(insert.params, [42, 'lending_due', 'Overdue: Ladder', 'Ladder lent to Bob was due Aug 1, 2026', 'item_lending', 5, '2026-08-01']);
});

test('an existing row for the due date means no insert', async () => {
  const db = fakeDb({ upcoming: [upcomingRow], overdue: [overdueRow], existing: [{ ID: 1 }] });
  Notifications.init({ db, logger: silent });
  await Notifications.checkDateNotifications(42);
  assert.equal(db.calls.filter((c) => /INSERT/.test(c.sql)).length, 0);
});

test('a race that loses to the unique key is silent; any other insert failure warns', async () => {
  const dup = Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });
  let warned = [];
  const logger = { ...silent, warn: (msg, meta) => warned.push({ msg, meta }) };

  Notifications.init({ db: fakeDb({ upcoming: [upcomingRow], insert: dup }), logger });
  await Notifications.checkDateNotifications(42);
  assert.deepEqual(warned, [], 'ER_DUP_ENTRY is "already there", not a failure');

  const boom = Object.assign(new Error('connection lost'), { code: 'PROTOCOL_CONNECTION_LOST' });
  Notifications.init({ db: fakeDb({ upcoming: [upcomingRow], insert: boom }), logger });
  await Notifications.checkDateNotifications(42);
  assert.equal(warned.length, 1);
  assert.equal(warned[0].meta.error, 'connection lost');
});

test('dismiss is soft: an UPDATE scoped to the user, never a DELETE', async () => {
  let sql = '', params = null;
  Notifications.init({ db: { query: async (s, p) => { sql = s; params = p; return {}; } }, logger: silent });
  await Notifications.dismiss(7, 42);
  assert.match(sql, /^\s*UPDATE TALLY\.notifications SET DISMISSED_AT = NOW\(\)/);
  assert.match(sql, /WHERE ID = \? AND USER_ID = \? AND DISMISSED_AT IS NULL/);
  assert.doesNotMatch(sql, /DELETE/);
  assert.deepEqual(params, [7, 42]);
});

test('reads hide dismissed rows: list, unread count, mark-all-read', async () => {
  const seen = [];
  Notifications.init({ db: { query: async (s) => { seen.push(s); return [{ cnt: 0 }]; } }, logger: silent });
  await Notifications.getForUser(42);
  await Notifications.getUnreadCount(42);
  await Notifications.markAllRead(42);
  for (const s of seen) assert.match(s, /DISMISSED_AT IS NULL/, s);
});

test('preferences: exactly the two producible types, and a lingering retired row is ignored', async () => {
  Notifications.init({
    db: { query: async () => [
      { NOTIFICATION_TYPE: 'custom_date', ENABLED: 1 },
      { NOTIFICATION_TYPE: 'item_moved', ENABLED: 1 },
    ] },
    logger: silent,
  });
  const prefs = await Notifications.getPreferences(42);
  assert.deepEqual(prefs, { lending_due: false, custom_date: true });
  assert.deepEqual(NOTIFICATION_TYPES, ['lending_due', 'custom_date']);
});

test('the preference schema rejects a retired type', () => {
  assert.equal(updatePreference.validate({ type: 'custom_date', enabled: true }).error, undefined);
  assert.equal(updatePreference.validate({ type: 'lending_due', enabled: false }).error, undefined);
  for (const dead of ['warranty_expiry', 'item_moved', 'item_removed', 'share_expiring']) {
    assert.ok(updatePreference.validate({ type: dead, enabled: true }).error, `${dead} must be rejected`);
  }
});

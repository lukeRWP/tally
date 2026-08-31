/**
 * The daily vision cap, now that it lives in the database (#340).
 *
 * The behaviour worth pinning is not "it counts" — it is the two decisions
 * that make this different from an ordinary limiter:
 *
 *   1. It must FAIL OPEN. A spend guard that blocks the feature when the
 *      database hiccups is a worse outcome than one that lets a call through;
 *      the burst limiter still bounds damage per minute. This is deliberately
 *      the opposite of the auth path's fail-closed rule.
 *   2. It must reset on a UTC calendar boundary, not 24h after first use,
 *      because that is what VISION_DAILY_PER_USER already implies.
 */

const test = require('node:test');
const assert = require('node:assert');
const { makeVisionDailyLimit, utcDay } = require('../src/modules/products/vision-daily-limit');

const silent = { error: () => {}, warn: () => {} };

/** Minimal res double capturing status + body. */
function makeRes() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

/** db double: `select` returns the SELECT rows, and writes are recorded. */
function makeDb({ select = [], throwOn = null } = {}) {
  const writes = [];
  return {
    writes,
    query: async (sql, params) => {
      if (throwOn && new RegExp(throwOn, 'i').test(sql)) throw new Error('db down');
      if (/^\s*SELECT/i.test(sql)) return select;
      writes.push({ sql, params });
      return { affectedRows: 1 };
    },
  };
}

const AT_NOON = Date.parse('2026-08-30T12:00:00Z');

test('utcDay is a calendar day, and rolls at midnight UTC not 24h after first use', () => {
  assert.equal(utcDay(Date.parse('2026-08-30T00:00:00Z')), '2026-08-30');
  assert.equal(utcDay(Date.parse('2026-08-30T23:59:59Z')), '2026-08-30');
  assert.equal(utcDay(Date.parse('2026-08-31T00:00:00Z')), '2026-08-31');
});

test('under the cap: the request proceeds and the day is incremented', async () => {
  const db = makeDb({ select: [{ CALL_COUNT: 4 }] });
  const mw = makeVisionDailyLimit({ db, logger: silent, max: 250, clock: () => AT_NOON });
  const res = makeRes();
  let nexted = false;

  await mw({ user: { id: 7 } }, res, () => { nexted = true; });

  assert.equal(nexted, true, 'under the cap the request must proceed');
  assert.equal(res.statusCode, null, 'nothing should be sent');
  assert.equal(db.writes.length, 1, 'the call must be counted');
  assert.match(db.writes[0].sql, /ON DUPLICATE KEY UPDATE/i,
    'the counter must upsert — the first call of a day has no row yet');
  assert.deepEqual(db.writes[0].params, [7, '2026-08-30']);
});

test('at the cap: 429, and nothing further is counted', async () => {
  const db = makeDb({ select: [{ CALL_COUNT: 250 }] });
  const mw = makeVisionDailyLimit({ db, logger: silent, max: 250, clock: () => AT_NOON });
  const res = makeRes();
  let nexted = false;

  await mw({ user: { id: 7 } }, res, () => { nexted = true; });

  assert.equal(nexted, false, 'at the cap the request must not proceed');
  assert.equal(res.statusCode, 429, 'the client branches on 429 — that contract must not change');
  assert.equal(res.body.success, false);
  assert.match(res.body.message, /limit reached/i,
    'the message is user-facing: it must say what happened, not just fail');
  assert.equal(db.writes.length, 0, 'a rejected request must not consume more quota');
});

test('FAIL OPEN: a database failure allows the request rather than blocking the feature', async () => {
  const db = makeDb({ throwOn: 'SELECT' });
  const mw = makeVisionDailyLimit({ db, logger: silent, max: 250, clock: () => AT_NOON });
  const res = makeRes();
  let nexted = false;

  await mw({ user: { id: 7 } }, res, () => { nexted = true; });

  assert.equal(nexted, true,
    'the cap guards a bill, not data — it must never be the reason vision stops working');
  assert.equal(res.statusCode, null, 'no 429, no 500: the request simply proceeds');
});

test('FAIL OPEN also when the increment fails, not just the read', async () => {
  const db = makeDb({ select: [{ CALL_COUNT: 1 }], throwOn: 'INSERT' });
  const mw = makeVisionDailyLimit({ db, logger: silent, max: 250, clock: () => AT_NOON });
  const res = makeRes();
  let nexted = false;

  await mw({ user: { id: 7 } }, res, () => { nexted = true; });

  assert.equal(nexted, true, 'a write failure must not block the request either');
  assert.equal(res.statusCode, null);
});

test('a failure is logged at error, so failing open is visible rather than silent', async () => {
  const seen = [];
  const db = makeDb({ throwOn: 'SELECT' });
  const mw = makeVisionDailyLimit({
    db, logger: { error: (m, meta) => seen.push({ m, meta }) }, max: 250, clock: () => AT_NOON,
  });

  await mw({ user: { id: 7 } }, makeRes(), () => {});

  assert.equal(seen.length, 1, 'failing open silently would hide a broken spend guard');
  assert.match(seen[0].m, /allowing the request/i);
  assert.equal(seen[0].meta.userId, 7);
});

test('no user id: the burst limiter owns it, this one abstains', async () => {
  const db = makeDb({ select: [{ CALL_COUNT: 999 }] });
  const mw = makeVisionDailyLimit({ db, logger: silent, max: 1, clock: () => AT_NOON });
  let nexted = false;

  await mw({}, makeRes(), () => { nexted = true; });

  assert.equal(nexted, true, 'there is nobody to count against');
  assert.equal(db.writes.length, 0);
});

test('the counter is per user AND per day, so yesterday does not spend today', async () => {
  const db = makeDb({ select: [] });     // no row for today
  const mw = makeVisionDailyLimit({
    db, logger: silent, max: 250, clock: () => Date.parse('2026-08-31T00:00:01Z'),
  });
  let nexted = false;

  await mw({ user: { id: 7 } }, makeRes(), () => { nexted = true; });

  assert.equal(nexted, true, 'a new day starts empty');
  assert.deepEqual(db.writes[0].params, [7, '2026-08-31'],
    'the row must be keyed on the new calendar day');
});

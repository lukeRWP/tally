const test = require('node:test');
const assert = require('node:assert');
const Matches = require('../src/modules/products/matches.service');

// Same fakeDb shape as lending.test.js: a scriptable query() that both
// captures SQL and returns whatever the case needs, plus a withTransaction
// that runs its callback against the SAME handler — resolve()'s writes now go
// through tx.query() instead of db.query() directly, and this keeps every
// existing SQL-matching branch working without caring which one it came from.
function fakeDb(handler) {
  const db = {
    query: async (sql, params) => handler(sql, params),
    withTransaction: async (fn) => fn({ query: db.query }),
  };
  return db;
}
const logger = { warn() {}, info() {}, error() {} };
const config = {
  vision: { apiKey: 'test-key' },
  match: {
    model: 'claude-sonnet-5', enabled: true, timeoutMs: 1000,
    dailyPerUser: 100, maxCandidates: 3, staleMinutes: 5, maxAttempts: 3,
  },
};

// ── IMPORTANT 4: the daily cap counts spend, not rows ────────────────────────

test('countToday sums SEARCH_COUNT, not COUNT(*) of rows', async () => {
  // A re-queue upserts the same row (UNIQUE on ITEM_ID) and fires another
  // paid search without inserting a new one — counting rows undercounts the
  // actual spend. This asserts the SQL shape directly rather than just the
  // returned number, so a regression back to COUNT(*) would fail even if it
  // happened to return the same value in a test with one row.
  let sql = '';
  let params = null;
  Matches.init({
    db: fakeDb((s, p) => { sql = s; params = p; return [{ N: 7 }]; }),
    logger, config,
  });
  const n = await Matches.countToday(42);
  assert.equal(n, 7);
  assert.match(sql, /SUM\(SEARCH_COUNT\)/, 'sums the paid-search counter, not COUNT(*)');
  assert.match(sql, /UPDATED_AT > DATE_SUB/, 'a re-queue that fires a new search touches UPDATED_AT');
  assert.match(sql, /CREATED_BY = \?/);
  assert.ok(params.includes(42));
});

test('queue verifies item ownership through property_members', async () => {
  const seen = [];
  Matches.init({
    db: fakeDb((sql, params) => {
      seen.push({ sql, params });
      if (/SELECT/i.test(sql) && /property_members/.test(sql)) return [{ ID: 7 }];
      if (/INSERT/i.test(sql)) return { insertId: 1, affectedRows: 1 };
      // countToday's COUNT and the post-upsert status readback both land here.
      return [{ N: 0, STATUS: 'queued' }];
    }),
    logger, config,
  });

  await Matches.queue({ itemId: 7, brand: 'DeWalt', name: 'Drill' }, 42);

  const guard = seen.find((q) => /property_members/.test(q.sql));
  assert.ok(guard, 'ownership is checked before insert');
  assert.match(guard.sql, /pm\.USER_ID = \?/);
  assert.ok(guard.params.includes(42), 'the caller id is bound');
});

test('queue excludes items under a soft-deleted container, area or property', async () => {
  let guardSql = '';
  Matches.init({
    db: fakeDb((sql) => {
      if (/property_members/.test(sql)) { guardSql = sql; return []; }
      return [];
    }),
    logger, config,
  });

  await assert.rejects(
    () => Matches.queue({ itemId: 7, brand: 'X', name: 'Y' }, 42),
    /not found/i
  );
  assert.match(guardSql, /c\.DELETED_AT IS NULL/, 'container soft-delete is checked');
  assert.match(guardSql, /a\.DELETED_AT IS NULL/, 'area soft-delete is checked');
  assert.match(guardSql, /p\.DELETED_AT IS NULL/, 'property soft-delete is checked');
});

test('queue refuses an item the caller cannot reach', async () => {
  Matches.init({ db: fakeDb(() => []), logger, config });
  await assert.rejects(
    () => Matches.queue({ itemId: 999, brand: 'X', name: 'Y' }, 42),
    /not found/i
  );
});

test('queue refuses when the daily cap is reached', async () => {
  Matches.init({
    db: fakeDb((sql) => {
      if (/COUNT/i.test(sql)) return [{ N: 100 }];
      if (/property_members/.test(sql)) return [{ ID: 7 }];
      return { insertId: 1 };
    }),
    logger, config,
  });
  await assert.rejects(
    () => Matches.queue({ itemId: 7, brand: 'X', name: 'Y' }, 42),
    /daily/i
  );
});

test('queue re-queuing a resolved row keeps its status and its LAST_ERROR untouched', async () => {
  let insertSql = '';
  Matches.init({
    db: fakeDb((sql) => {
      if (/property_members/.test(sql)) return [{ ID: 7 }];
      if (/INSERT/i.test(sql)) { insertSql = sql; return { insertId: 9, affectedRows: 1 }; }
      if (/SELECT STATUS/i.test(sql)) return [{ STATUS: 'resolved' }];
      return [{ N: 0 }]; // countToday
    }),
    logger, config,
  });

  const result = await Matches.queue({ itemId: 7, brand: 'DeWalt', name: 'Drill' }, 42);

  assert.equal(result.status, 'resolved',
    'the caller sees the row\'s real status, not a hardcoded queued');
  assert.match(insertSql, /STATUS = CASE WHEN STATUS IN \('resolved', 'dismissed'\) THEN STATUS/,
    'a terminal row is not blindly reset to queued');
  assert.match(insertSql, /LAST_ERROR = CASE WHEN STATUS IN \('resolved', 'dismissed'\) THEN LAST_ERROR ELSE NULL END/,
    'a terminal row keeps whatever LAST_ERROR it had');
});

test('queue re-queuing a failed row resets to queued, zeroes attempts, clears LAST_ERROR, and refreshes the query', async () => {
  let insertSql = '';
  let insertParams = [];
  Matches.init({
    db: fakeDb((sql, params) => {
      if (/property_members/.test(sql)) return [{ ID: 7 }];
      if (/INSERT/i.test(sql)) { insertSql = sql; insertParams = params; return { insertId: 9, affectedRows: 1 }; }
      if (/SELECT STATUS/i.test(sql)) return [{ STATUS: 'queued' }];
      return [{ N: 0 }]; // countToday
    }),
    logger, config,
  });

  const result = await Matches.queue({ itemId: 7, brand: 'Makita', name: 'Impact Driver' }, 42);

  assert.equal(result.status, 'queued');
  assert.match(insertSql, /SEARCH_QUERY = VALUES\(SEARCH_QUERY\)/,
    'the new query overwrites the stale one');
  assert.match(insertSql, /ATTEMPTS = CASE WHEN STATUS IN \('resolved', 'dismissed'\) THEN ATTEMPTS ELSE 0 END/,
    'attempts are zeroed for a non-terminal re-queue');
  assert.match(insertSql, /LAST_ERROR = CASE WHEN STATUS IN \('resolved', 'dismissed'\) THEN LAST_ERROR ELSE NULL END/,
    'a row coming back to queued starts with a clean LAST_ERROR, not a stale one');
  assert.ok(insertParams.some((p) => typeof p === 'string' && /Makita/.test(p)),
    'the refreshed brand/name reaches the stored query');
});

test('sweepStale requeues under the cap and fails at it, scoped to one property', async () => {
  let sql = '';
  let params = null;
  Matches.init({
    db: fakeDb((s, p) => { sql = s; params = p; return { affectedRows: 2 }; }),
    logger, config,
  });
  const n = await Matches.sweepStale(9);
  assert.equal(n, 2);
  assert.match(sql, /STATUS = 'searching'/, 'only sweeps rows left mid-search');
  assert.match(sql, /ATTEMPTS \+ 1 >= \?/, 'the attempts cap is applied in the sweep');
  assert.match(sql, /SEARCH_STARTED_AT < DATE_SUB/, 'only rows past the timeout');
  // MINOR 6: an unscoped UPDATE across every user's rows on every worklist GET
  // has no reason to exist — this must join down to the property being listed.
  assert.match(sql, /PROPERTY_ID = \?/, 'scoped to one property, not every row');
  assert.ok(params.includes(9), 'the property id is actually bound');
});

test('runNow writes ready with candidates on success', async () => {
  const writes = [];
  Matches.init({
    db: fakeDb((sql, params) => {
      if (/SELECT/i.test(sql)) {
        return [{ ID: 5, SEARCH_QUERY: JSON.stringify({ brand: 'DeWalt', name: 'Drill' }) }];
      }
      writes.push({ sql, params });
      return { affectedRows: 1 };
    }),
    logger, config,
    searcher: async () => ({ candidates: [{ name: 'DeWalt DCD771C2', sourceUrl: 'https://e.com/a', sourceDomain: 'e.com', brand: 'DeWalt', model: null, upc: null, priceUsd: null, imageUrl: null }] }),
  });

  await Matches.runNow(5);

  const final = writes[writes.length - 1];
  assert.match(final.sql, /STATUS = 'ready'/);
  assert.match(final.params[0], /DCD771C2/, 'candidates are stored as JSON');
});

test('runNow writes none when the search finds nothing', async () => {
  const writes = [];
  Matches.init({
    db: fakeDb((sql, params) => {
      if (/SELECT/i.test(sql)) return [{ ID: 5, SEARCH_QUERY: '{"name":"Mug"}' }];
      writes.push({ sql, params });
      return { affectedRows: 1 };
    }),
    logger, config,
    searcher: async () => ({ candidates: [] }),
  });

  await Matches.runNow(5);
  assert.match(writes[writes.length - 1].sql, /STATUS = 'none'/);
});

test('runNow never throws when the search does, and records the error', async () => {
  const writes = [];
  Matches.init({
    db: fakeDb((sql, params) => {
      if (/SELECT/i.test(sql)) return [{ ID: 5, SEARCH_QUERY: '{"name":"X"}' }];
      writes.push({ sql, params });
      return { affectedRows: 1 };
    }),
    logger, config,
    searcher: async () => { throw new Error('upstream exploded'); },
  });

  await Matches.runNow(5);   // must not reject: it is fire-and-forget

  // CRITICAL 1: ATTEMPTS now moves on the 'searching' transition (every
  // attempt), not only in the failure branch — otherwise the cap is never
  // reached and 'failed' is unreachable. That means it is the FIRST write
  // here, not necessarily the last.
  const searching = writes.find((w) => /STATUS = 'searching'/.test(w.sql));
  assert.ok(searching, 'the run must move to searching before calling the searcher');
  assert.match(searching.sql, /ATTEMPTS = ATTEMPTS \+ 1/, 'the attempt is counted up front');
  assert.match(searching.sql, /SEARCH_COUNT = SEARCH_COUNT \+ 1/,
    'IMPORTANT 4: the paid attempt is counted for the daily cost cap too');

  // The failure write must NOT increment ATTEMPTS a second time — it was
  // already spent above — so it compares the column as-is, not ATTEMPTS + 1.
  const final = writes[writes.length - 1];
  assert.match(final.sql, /STATUS = CASE WHEN ATTEMPTS >= \? THEN 'failed' ELSE 'queued' END/);
  assert.ok(!/ATTEMPTS = ATTEMPTS \+ 1/.test(final.sql),
    'ATTEMPTS must not be bumped twice for one failed attempt');
  assert.ok(final.params.some((p) => typeof p === 'string' && /exploded/.test(p)),
    'the error text is recorded for the worklist to show');
});

test('runNow counts a failure that happens before the searching transition as one attempt', async () => {
  // The initial read (or the cap check) can itself fail — e.g. a DB blip —
  // before ATTEMPTS is ever bumped. That failure still has to count, exactly
  // as the pre-fix code always did, or a row that keeps failing at that early
  // point never reaches the attempts cap.
  const writes = [];
  let selects = 0;
  Matches.init({
    db: fakeDb((sql, params) => {
      if (/SELECT/i.test(sql)) {
        selects++;
        if (selects === 1) return [{ ID: 5, SEARCH_QUERY: '{"name":"X"}', CREATED_BY: 1 }];
        throw new Error('db blipped');   // the countToday SELECT this time
      }
      writes.push({ sql, params });
      return { affectedRows: 1 };
    }),
    logger, config,
  });

  await Matches.runNow(5);
  assert.equal(writes.length, 1, 'only the failure-recording write happens — searching is never reached');
  assert.match(writes[0].sql, /ATTEMPTS = ATTEMPTS \+ 1/,
    'a failure before the searching transition still spends an attempt');
  assert.match(writes[0].sql, /CASE WHEN ATTEMPTS \+ 1 >= \?/);
});

test('runNow never rejects even when the failure-recording write also throws', async () => {
  // The searcher fails AND every write fails, including the one inside the
  // catch that tries to record the failure. This is the scenario the
  // never-reject invariant actually depends on: runNow is called without
  // await, so a rejection here would be an unhandled rejection with nobody
  // left to catch it.
  Matches.init({
    db: fakeDb((sql) => {
      if (/SELECT/i.test(sql)) return [{ ID: 5, SEARCH_QUERY: '{"name":"X"}' }];
      throw new Error('db is down');
    }),
    logger, config,
    searcher: async () => { throw new Error('upstream exploded'); },
  });

  await assert.doesNotReject(() => Matches.runNow(5));
});

// ── IMPORTANT 4: the daily cap is enforced in runNow too, not only queue() ───

test('runNow refuses to search once the daily cap is reached, and ends failed', async () => {
  const writes = [];
  let searcherCalled = false;
  Matches.init({
    db: fakeDb((sql, params) => {
      if (/SELECT ID, SEARCH_QUERY/i.test(sql)) {
        return [{ ID: 5, SEARCH_QUERY: '{"name":"X"}', CREATED_BY: 42 }];
      }
      if (/SUM\(SEARCH_COUNT\)/.test(sql)) return [{ N: 100 }];   // already at the cap
      writes.push({ sql, params });
      return { affectedRows: 1 };
    }),
    logger, config,
    searcher: async () => { searcherCalled = true; return { candidates: [] }; },
  });

  await Matches.runNow(5);

  assert.equal(searcherCalled, false, 'a capped run must not spend a paid search');
  assert.equal(writes.length, 1, 'only the refusal write happens — no searching transition');
  assert.match(writes[0].sql, /STATUS = 'failed'/,
    'terminal rather than left queued, or list()\'s batch retry would hit the cap forever');
  assert.ok(writes[0].params.some((p) => /daily/i.test(String(p))),
    'LAST_ERROR names the cap so the worklist shows why, per IMPORTANT 4');
});

test('runNow under the cap proceeds to search normally', async () => {
  const writes = [];
  Matches.init({
    db: fakeDb((sql, params) => {
      if (/SELECT ID, SEARCH_QUERY/i.test(sql)) {
        return [{ ID: 5, SEARCH_QUERY: '{"name":"X"}', CREATED_BY: 42 }];
      }
      if (/SUM\(SEARCH_COUNT\)/.test(sql)) return [{ N: 99 }];   // one under the cap
      writes.push({ sql, params });
      return { affectedRows: 1 };
    }),
    logger, config,
    searcher: async () => ({ candidates: [] }),
  });

  await Matches.runNow(5);
  assert.ok(writes.some((w) => /STATUS = 'searching'/.test(w.sql)), 'a run under the cap still searches');
  assert.ok(writes.some((w) => /STATUS = 'none'/.test(w.sql)), 'and completes normally');
});

// ── CRITICAL 1: a queued row must eventually reach failed ────────────────────

test('a row that fails MATCH_MAX_ATTEMPTS times ends failed with LAST_ERROR set', async () => {
  // A small stateful fake standing in for one row across three separate
  // runNow() calls — this is the scenario the whole fix exists for: nothing
  // else in the real system ever calls runNow on a 'queued' row except
  // list()'s own retry (tested separately below), so this proves the
  // increment-on-every-attempt logic actually gets a row to 'failed' rather
  // than looping at 'queued' forever.
  const row = { ATTEMPTS: 0, STATUS: 'queued', LAST_ERROR: null };
  Matches.init({
    db: fakeDb((sql, params) => {
      if (/SELECT ID, SEARCH_QUERY/i.test(sql)) {
        return [{ ID: 5, SEARCH_QUERY: '{"name":"X"}', CREATED_BY: 42 }];
      }
      if (/SUM\(SEARCH_COUNT\)/.test(sql)) return [{ N: 0 }];   // never capped here
      if (/STATUS = 'searching'/.test(sql)) {
        row.ATTEMPTS += 1;
        row.STATUS = 'searching';
        return { affectedRows: 1 };
      }
      // the failure-recording write, evaluated against the CURRENT (already
      // incremented) ATTEMPTS — exactly what the real CASE expression reads.
      row.STATUS = row.ATTEMPTS >= config.match.maxAttempts ? 'failed' : 'queued';
      row.LAST_ERROR = params[1];
      return { affectedRows: 1 };
    }),
    logger, config,
    searcher: async () => { throw new Error('upstream exploded'); },
  });

  await Matches.runNow(5);
  assert.deepEqual([row.STATUS, row.ATTEMPTS], ['queued', 1]);

  await Matches.runNow(5);
  assert.deepEqual([row.STATUS, row.ATTEMPTS], ['queued', 2]);

  await Matches.runNow(5);
  assert.equal(row.STATUS, 'failed', 'the third failure reaches MATCH_MAX_ATTEMPTS (3)');
  assert.equal(row.ATTEMPTS, 3);
  assert.match(row.LAST_ERROR, /exploded/, 'LAST_ERROR records what actually failed');
});

test('list scopes to the caller via property_members', async () => {
  let sql = '';
  let params = null;
  Matches.init({
    db: fakeDb((s, p) => {
      if (/UPDATE/i.test(s)) return { affectedRows: 0 };   // the sweep
      sql = s; params = p; return [];
    }),
    logger, config,
  });
  await Matches.list(1, 42);
  assert.match(sql, /property_members/);
  assert.match(sql, /pm\.USER_ID = \?/);
  assert.ok(params.includes(42));
});

test('list sweeps before reading', async () => {
  const order = [];
  Matches.init({
    db: fakeDb((s) => {
      order.push(/UPDATE/i.test(s) ? 'sweep' : 'read');
      return /UPDATE/i.test(s) ? { affectedRows: 0 } : [];
    }),
    logger, config,
  });
  await Matches.list(1, 42);
  assert.equal(order[0], 'sweep', 'a stranded row is recovered before it is listed');
});

// ── CRITICAL 1: list() is the recovery trigger for a 'queued' row ────────────
//
// runNow's only other caller is the queue route, on a fresh row, and the
// sweep only reaches 'searching' — so without this, a row a failed run set
// back to 'queued' is never picked up again. These monkeypatch
// MatchesService.runNow itself (the same self-reference list() calls through,
// like sweepStale already does) so the assertion is "was it fired", not a
// second copy of runNow's own behaviour.

test('list() fires runNow for a queued row under the attempts cap', async () => {
  Matches.init({
    db: fakeDb((s) => {
      if (/UPDATE/i.test(s)) return { affectedRows: 0 };   // the sweep
      return [{ ID: 11, ITEM_ID: 1, STATUS: 'queued', CANDIDATES: null, LAST_ERROR: null,
                ATTEMPTS: 1, CREATED_AT: new Date(), ITEM_NAME: 'Drill', CONTAINER_NAME: 'Shelf' }];
    }),
    logger, config,
  });

  const ran = [];
  const original = Matches.runNow;
  Matches.runNow = async (id) => { ran.push(id); };
  try {
    await Matches.list(1, 42);
  } finally {
    Matches.runNow = original;
  }
  assert.deepEqual(ran, [11], 'a queued row under the cap (ATTEMPTS 1 < maxAttempts 3) is re-run');
});

test('list() does not fire runNow for a queued row already at the attempts cap', async () => {
  Matches.init({
    db: fakeDb((s) => {
      if (/UPDATE/i.test(s)) return { affectedRows: 0 };
      return [{ ID: 12, ITEM_ID: 1, STATUS: 'queued', CANDIDATES: null, LAST_ERROR: 'boom',
                ATTEMPTS: 3, CREATED_AT: new Date(), ITEM_NAME: 'Drill', CONTAINER_NAME: 'Shelf' }];
    }),
    logger, config,
  });

  const ran = [];
  const original = Matches.runNow;
  Matches.runNow = async (id) => { ran.push(id); };
  try {
    await Matches.list(1, 42);
  } finally {
    Matches.runNow = original;
  }
  assert.deepEqual(ran, [], 'a row already at the cap is left for the sweep to fail, not retried here');
});

test('list() only retries queued rows, never searching/ready/none/failed', async () => {
  Matches.init({
    db: fakeDb((s) => {
      if (/UPDATE/i.test(s)) return { affectedRows: 0 };
      const base = { ITEM_ID: 1, CANDIDATES: null, LAST_ERROR: null, ATTEMPTS: 0,
                     CREATED_AT: new Date(), ITEM_NAME: 'X', CONTAINER_NAME: 'S' };
      return [
        { ...base, ID: 1, STATUS: 'searching' },
        { ...base, ID: 2, STATUS: 'ready', CANDIDATES: '[]' },
        { ...base, ID: 3, STATUS: 'none' },
        { ...base, ID: 4, STATUS: 'failed', ATTEMPTS: 3, LAST_ERROR: 'x' },
      ];
    }),
    logger, config,
  });

  const ran = [];
  const original = Matches.runNow;
  Matches.runNow = async (id) => { ran.push(id); };
  try {
    await Matches.list(1, 42);
  } finally {
    Matches.runNow = original;
  }
  assert.deepEqual(ran, [], 'only queued rows are ever retried from list()');
});

test('list() retries at most 5 queued rows per call', async () => {
  const eleven = Array.from({ length: 11 }, (_, i) => ({
    ID: i + 1, ITEM_ID: i + 1, STATUS: 'queued', CANDIDATES: null, LAST_ERROR: null,
    ATTEMPTS: 0, CREATED_AT: new Date(), ITEM_NAME: `Item ${i}`, CONTAINER_NAME: 'Shelf',
  }));
  Matches.init({
    db: fakeDb((s) => {
      if (/UPDATE/i.test(s)) return { affectedRows: 0 };
      return eleven;
    }),
    logger, config,
  });

  const ran = [];
  const original = Matches.runNow;
  Matches.runNow = async (id) => { ran.push(id); };
  try {
    await Matches.list(1, 42);
  } finally {
    Matches.runNow = original;
  }
  assert.equal(ran.length, 5,
    'a big backlog must not fire dozens of concurrent runner calls from one GET');
});

// Distinguishes the two products.BARCODE lookups resolve itself issues
// ('SELECT ID, NAME, BRAND FROM TALLY.products WHERE BARCODE...') from the
// same substring appearing inside checkDuplicate's subquery
// ('i.PRODUCT_ID = (SELECT ID FROM TALLY.products WHERE BARCODE...)') —
// the two must route to different mock branches.
const BARCODE_LOOKUP = /SELECT ID, NAME, BRAND FROM TALLY\.products WHERE BARCODE/;
const CHECK_DUPLICATE = /i\.PRODUCT_ID = \(SELECT ID FROM TALLY\.products WHERE BARCODE/;

test('resolve links the existing catalog row when the UPC is known', async () => {
  const writes = [];
  Matches.init({
    db: fakeDb((sql, params) => {
      if (/FROM TALLY\.product_matches/.test(sql) && /SELECT/i.test(sql)) {
        return [{ ID: 5, ITEM_ID: 7, STATUS: 'ready',
                  CANDIDATES: JSON.stringify([{ name: 'Drill', brand: 'DeWalt',
                    upc: '885911474764', sourceUrl: 'https://e.com/a',
                    sourceDomain: 'e.com', model: null, priceUsd: null, imageUrl: null }]) }];
      }
      if (BARCODE_LOOKUP.test(sql)) {
        // Deliberately different from the candidate's guess: proves the
        // response echoes the catalog row, not the candidate.
        return [{ ID: 99, NAME: 'DeWalt 20V MAX Drill/Driver Kit', BRAND: 'DeWalt' }];
      }
      if (CHECK_DUPLICATE.test(sql)) return [];              // checkDuplicate
      writes.push({ sql, params });
      return { affectedRows: 1, insertId: 0 };
    }),
    logger, config,
  });

  const out = await Matches.resolve(5, 42, { candidateIndex: 0 });
  assert.equal(out.product.id, 99, 'links the existing product, does not insert');
  assert.equal(out.product.name, 'DeWalt 20V MAX Drill/Driver Kit',
    'returns the catalog row\'s own stored name, not the candidate\'s guess');
  assert.ok(!writes.some((w) => /INSERT INTO TALLY\.products/.test(w.sql)),
    'no second catalog row for a barcode that already exists');
  assert.ok(writes.some((w) => /UPDATE TALLY\.items/.test(w.sql) && w.params.includes(99)),
    'the item is linked to the product');
});

test('resolve inserts a new product with vision_match provenance', async () => {
  const writes = [];
  Matches.init({
    db: fakeDb((sql, params) => {
      if (/FROM TALLY\.product_matches/.test(sql) && /SELECT/i.test(sql)) {
        return [{ ID: 5, ITEM_ID: 7, STATUS: 'ready',
                  CANDIDATES: JSON.stringify([{ name: 'Drill', brand: 'DeWalt',
                    upc: null, sourceUrl: 'https://e.com/a', sourceDomain: 'e.com',
                    model: null, priceUsd: 129.99, imageUrl: null }]) }];
      }
      if (BARCODE_LOOKUP.test(sql)) return [];
      if (CHECK_DUPLICATE.test(sql)) return [];
      writes.push({ sql, params });
      return { affectedRows: 1, insertId: 123 };
    }),
    logger, config,
  });

  const out = await Matches.resolve(5, 42, { candidateIndex: 0 });
  assert.equal(out.product.id, 123);
  assert.equal(out.product.name, 'Drill', 'a freshly inserted row echoes what was just written');
  const insert = writes.find((w) => /INSERT INTO TALLY\.products/.test(w.sql));
  assert.ok(insert, 'a new catalog row is created');
  assert.ok(insert.params.includes('vision_match'), 'provenance is recorded honestly');
  // {url, domain} was dead on arrival: item-detail.tsx and scan-result.tsx
  // read {retailer, url, price} (see products.schema.js's Joi shape), so
  // assert the actual keys rather than just that the URL string appears
  // somewhere in the stringified param.
  const retailLinksParam = insert.params.find((p) => typeof p === 'string' && p.startsWith('['));
  assert.deepEqual(JSON.parse(retailLinksParam), [
    { retailer: 'e.com', url: 'https://e.com/a', price: 129.99 },
  ], 'RETAIL_LINKS is written in the {retailer, url, price} shape the client reads');
});

test('resolve recovers when a concurrent resolve wins the insert race on the same UPC', async () => {
  const writes = [];
  let barcodeLookups = 0;
  const barcodeLookupSql = [];
  Matches.init({
    db: fakeDb((sql, params) => {
      if (/FROM TALLY\.product_matches/.test(sql) && /SELECT/i.test(sql)) {
        return [{ ID: 5, ITEM_ID: 7, STATUS: 'ready',
                  CANDIDATES: JSON.stringify([{ name: 'Drill', brand: 'DeWalt',
                    upc: '885911474764', sourceUrl: 'https://e.com/a',
                    sourceDomain: 'e.com', model: null, priceUsd: null, imageUrl: null }]) }];
      }
      if (BARCODE_LOOKUP.test(sql)) {
        barcodeLookups += 1;
        barcodeLookupSql.push(sql);
        // First look misses — nobody has inserted the barcode yet. The
        // re-select after the duplicate-key error finds the row a
        // concurrent resolve just won.
        if (barcodeLookups === 1) return [];
        return [{ ID: 77, NAME: 'DeWalt Drill (won by concurrent resolve)', BRAND: 'DeWalt' }];
      }
      if (CHECK_DUPLICATE.test(sql)) return [];
      if (/INSERT INTO TALLY\.products/.test(sql)) {
        const err = new Error("Duplicate entry '885911474764' for key 'uq_products_barcode'");
        err.code = 'ER_DUP_ENTRY';
        throw err;
      }
      writes.push({ sql, params });
      return { affectedRows: 1 };
    }),
    logger, config,
  });

  const out = await Matches.resolve(5, 42, { candidateIndex: 0 });
  assert.equal(out.product.id, 77, 'links the row the concurrent resolve created');
  assert.equal(out.product.name, 'DeWalt Drill (won by concurrent resolve)');
  assert.ok(writes.some((w) => /UPDATE TALLY\.items/.test(w.sql) && w.params.includes(77)),
    'the loser still ends up linked to the winning row, not stuck on an unhandled error');

  // Regression guard: the transaction runs at REPEATABLE READ, so a plain
  // SELECT for the recovery read would see the snapshot from before the
  // winner committed and miss forever — the duplicate-key error would
  // re-throw instead of converging. FOR UPDATE forces a read of the latest
  // committed row. Only the RECOVERY read needs it — the first, pre-insert
  // lookup is untouched.
  assert.equal(barcodeLookupSql.length, 2);
  assert.ok(!/FOR UPDATE/.test(barcodeLookupSql[0]),
    'the first, pre-insert lookup is a plain read — no reason to lock before we know we need to');
  assert.match(barcodeLookupSql[1], /FOR UPDATE/,
    'the post-duplicate-key recovery read must not be a stale snapshot read');
});

test('resolve refuses a match the caller cannot reach', async () => {
  Matches.init({ db: fakeDb(() => []), logger, config });
  await assert.rejects(
    () => Matches.resolve(5, 999, { candidateIndex: 0 }),
    /not found/i
  );
});

test('resolve refuses to resolve an already-resolved match', async () => {
  Matches.init({
    db: fakeDb((sql) => {
      if (/FROM TALLY\.product_matches/.test(sql) && /SELECT/i.test(sql)) {
        return [{ ID: 5, ITEM_ID: 7, STATUS: 'resolved', CANDIDATES: '[]' }];
      }
      return { affectedRows: 1 };
    }),
    logger, config,
  });
  await assert.rejects(
    () => Matches.resolve(5, 42, { candidateIndex: 0 }),
    (err) => {
      assert.match(err.message, /already resolved/i);
      assert.equal(err.status, 409);
      return true;
    }
  );
});

test('resolve refuses to dismiss an already-resolved match', async () => {
  Matches.init({
    db: fakeDb((sql) => {
      if (/FROM TALLY\.product_matches/.test(sql) && /SELECT/i.test(sql)) {
        return [{ ID: 5, ITEM_ID: 7, STATUS: 'resolved', CANDIDATES: '[]' }];
      }
      return { affectedRows: 1 };
    }),
    logger, config,
  });
  await assert.rejects(
    () => Matches.resolve(5, 42, { dismiss: true }),
    (err) => {
      assert.match(err.message, /already resolved/i);
      assert.equal(err.status, 409);
      return true;
    },
    'dismissing after resolve would leave items.PRODUCT_ID pointing at the resolved product while STATUS says dismissed'
  );
});

test('dismiss writes no product', async () => {
  const writes = [];
  Matches.init({
    db: fakeDb((sql, params) => {
      if (/FROM TALLY\.product_matches/.test(sql) && /SELECT/i.test(sql)) {
        return [{ ID: 5, ITEM_ID: 7, STATUS: 'ready', CANDIDATES: '[]' }];
      }
      writes.push({ sql, params });
      return { affectedRows: 1 };
    }),
    logger, config,
  });

  const out = await Matches.resolve(5, 42, { dismiss: true });
  assert.equal(out.product, null);
  assert.ok(!writes.some((w) => /INSERT INTO TALLY\.products/.test(w.sql)));
  assert.ok(writes.some((w) => /STATUS = 'dismissed'/.test(w.sql)));
});

test('resolve\'s duplicates carry the full location chain duplicate-check.tsx renders', async () => {
  Matches.init({
    db: fakeDb((sql) => {
      if (/FROM TALLY\.product_matches/.test(sql) && /SELECT/i.test(sql)) {
        return [{ ID: 5, ITEM_ID: 7, STATUS: 'ready',
                  CANDIDATES: JSON.stringify([{ name: 'Drill', brand: 'DeWalt',
                    upc: '885911474764', sourceUrl: 'https://e.com/a',
                    sourceDomain: 'e.com', model: null, priceUsd: null, imageUrl: null }]) }];
      }
      if (BARCODE_LOOKUP.test(sql)) return [{ ID: 99, NAME: 'Drill', BRAND: 'DeWalt' }];
      if (CHECK_DUPLICATE.test(sql)) {
        return [{ ID: 3, NAME: 'Drill', CONTAINER_NAME: 'Garage Shelf',
                  AREA_NAME: 'Garage', PROPERTY_NAME: 'Home' }];
      }
      return { affectedRows: 1 };
    }),
    logger, config,
  });

  const out = await Matches.resolve(5, 42, { candidateIndex: 0 });
  assert.deepEqual(out.duplicates, [{
    id: 3, name: 'Drill', containerName: 'Garage Shelf',
    areaName: 'Garage', propertyName: 'Home',
  }], 'areaName/propertyName survive — duplicate-check.tsx renders propertyName > areaName > containerName');
});

test('resolve checks for duplicates before linking this item, so it cannot appear as its own duplicate', async () => {
  const order = [];
  Matches.init({
    db: fakeDb((sql) => {
      if (/FROM TALLY\.product_matches/.test(sql) && /SELECT/i.test(sql)) {
        return [{ ID: 5, ITEM_ID: 7, STATUS: 'ready',
                  CANDIDATES: JSON.stringify([{ name: 'Drill', brand: 'DeWalt',
                    upc: '885911474764', sourceUrl: 'https://e.com/a',
                    sourceDomain: 'e.com', model: null, priceUsd: null, imageUrl: null }]) }];
      }
      if (BARCODE_LOOKUP.test(sql)) return [{ ID: 99, NAME: 'Drill', BRAND: 'DeWalt' }];
      if (CHECK_DUPLICATE.test(sql)) { order.push('checkDuplicate'); return []; }
      if (/UPDATE TALLY\.items/.test(sql)) { order.push('linkItem'); return { affectedRows: 1 }; }
      return { affectedRows: 1 };
    }),
    logger, config,
  });

  await Matches.resolve(5, 42, { candidateIndex: 0 });
  assert.deepEqual(order, ['checkDuplicate', 'linkItem'],
    'checkDuplicate has no ID-exclusion param, so it must run before this item claims the product');
});

// ── IMPORTANT 5: resolve's write sequence is one transaction ────────────────

test('resolve wraps the catalog write, item link and match resolution in one transaction', async () => {
  let transactionCalls = 0;
  const dbHandler = (sql) => {
    if (/FROM TALLY\.product_matches/.test(sql) && /SELECT/i.test(sql)) {
      return [{ ID: 5, ITEM_ID: 7, STATUS: 'ready',
                CANDIDATES: JSON.stringify([{ name: 'Drill', brand: 'DeWalt',
                  upc: null, sourceUrl: 'https://e.com/a', sourceDomain: 'e.com',
                  model: null, priceUsd: null, imageUrl: null }]) }];
    }
    if (CHECK_DUPLICATE.test(sql)) return [];
    return { affectedRows: 1, insertId: 55 };
  };
  const db = {
    query: async (sql, params) => dbHandler(sql, params),
    withTransaction: async (fn) => {
      transactionCalls += 1;
      return fn({ query: db.query });
    },
  };
  Matches.init({ db, logger, config });

  const out = await Matches.resolve(5, 42, { candidateIndex: 0 });
  assert.equal(transactionCalls, 1,
    'the catalog write, the item link and the match resolution share one transaction');
  assert.equal(out.product.id, 55);
});

test('resolve does not touch the catalog, the item or the match outside the transaction', async () => {
  // A regression guard for the shape of the fix, not just its outcome: if a
  // future edit moved one of the three writes back onto db.query() directly,
  // this fails even though a happy-path result would still look correct.
  let outsideWrites = 0;
  let insideWrites = 0;
  const dbHandler = (sql) => {
    if (/FROM TALLY\.product_matches/.test(sql) && /SELECT/i.test(sql)) {
      return [{ ID: 5, ITEM_ID: 7, STATUS: 'ready',
                CANDIDATES: JSON.stringify([{ name: 'Drill', brand: 'DeWalt',
                  upc: null, sourceUrl: 'https://e.com/a', sourceDomain: 'e.com',
                  model: null, priceUsd: null, imageUrl: null }]) }];
    }
    if (CHECK_DUPLICATE.test(sql)) return [];
    return { affectedRows: 1, insertId: 55 };
  };
  const db = {
    query: async (sql, params) => {
      if (/INSERT INTO TALLY\.products/.test(sql) || /UPDATE TALLY\.items/.test(sql)
          || (/UPDATE TALLY\.product_matches/.test(sql) && /'resolved'/.test(sql))) {
        outsideWrites += 1;
      }
      return dbHandler(sql, params);
    },
    withTransaction: async (fn) => fn({
      query: async (sql, params) => {
        if (/INSERT INTO TALLY\.products/.test(sql) || /UPDATE TALLY\.items/.test(sql)
            || (/UPDATE TALLY\.product_matches/.test(sql) && /'resolved'/.test(sql))) {
          insideWrites += 1;
        }
        return dbHandler(sql, params);
      },
    }),
  };
  Matches.init({ db, logger, config });

  await Matches.resolve(5, 42, { candidateIndex: 0 });
  assert.equal(outsideWrites, 0, 'the catalog insert, item link and match resolve must not use db.query directly');
  assert.equal(insideWrites, 3, 'all three writes (insert, item link, match resolve) go through the transaction');
});

test('resolve propagates a failure inside the transaction instead of reporting success on a half-written row', async () => {
  // Simulates a failure between the items UPDATE and the product_matches
  // UPDATE — the exact gap the finding names. A real DB rolls the whole
  // transaction back; what this test proves is the failure actually reaches
  // resolve()'s caller (the route returns 500, the client is told it failed)
  // instead of being swallowed with a response that claims success while the
  // item is linked and the match still reads 'ready'.
  Matches.init({
    db: fakeDb((sql) => {
      if (/FROM TALLY\.product_matches/.test(sql) && /SELECT/i.test(sql)) {
        return [{ ID: 5, ITEM_ID: 7, STATUS: 'ready',
                  CANDIDATES: JSON.stringify([{ name: 'Drill', brand: 'DeWalt',
                    upc: null, sourceUrl: 'https://e.com/a', sourceDomain: 'e.com',
                    model: null, priceUsd: null, imageUrl: null }]) }];
      }
      if (CHECK_DUPLICATE.test(sql)) return [];
      if (/INSERT INTO TALLY\.products/.test(sql)) return { insertId: 55 };
      if (/UPDATE TALLY\.product_matches/.test(sql) && /'resolved'/.test(sql)) {
        throw new Error('connection dropped mid-transaction');
      }
      return { affectedRows: 1 };
    }),
    logger, config,
  });

  await assert.rejects(
    () => Matches.resolve(5, 42, { candidateIndex: 0 }),
    /connection dropped/,
  );
});


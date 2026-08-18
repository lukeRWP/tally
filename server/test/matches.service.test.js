const test = require('node:test');
const assert = require('node:assert');
const Matches = require('../src/modules/products/matches.service');

// Same fakeDb shape as labels.test.js / lending.test.js: a scriptable query()
// that both captures SQL and returns whatever the case needs.
function fakeDb(handler) {
  return { query: async (sql, params) => handler(sql, params) };
}
const logger = { warn() {}, info() {}, error() {} };
const config = {
  vision: { apiKey: 'test-key' },
  match: {
    model: 'claude-sonnet-5', enabled: true, timeoutMs: 1000,
    dailyPerUser: 100, maxCandidates: 3, staleMinutes: 5, maxAttempts: 3,
  },
};

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

test('sweepStale requeues under the cap and fails at it', async () => {
  let sql = '';
  Matches.init({
    db: fakeDb((s) => { sql = s; return { affectedRows: 2 }; }),
    logger, config,
  });
  const n = await Matches.sweepStale();
  assert.equal(n, 2);
  assert.match(sql, /STATUS = 'searching'/, 'only sweeps rows left mid-search');
  assert.match(sql, /ATTEMPTS \+ 1 >= \?/, 'the attempts cap is applied in the sweep');
  assert.match(sql, /SEARCH_STARTED_AT < DATE_SUB/, 'only rows past the timeout');
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
  const final = writes[writes.length - 1];
  assert.match(final.sql, /ATTEMPTS = ATTEMPTS \+ 1/);
  assert.ok(final.params.some((p) => typeof p === 'string' && /exploded/.test(p)),
    'the error text is recorded for the worklist to show');
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
      if (/FROM TALLY\.products WHERE BARCODE/.test(sql)) return [{ ID: 99 }];
      if (/SELECT i\.ID/.test(sql)) return [];              // checkDuplicate
      writes.push({ sql, params });
      return { affectedRows: 1, insertId: 0 };
    }),
    logger, config,
  });

  const out = await Matches.resolve(5, 42, { candidateIndex: 0 });
  assert.equal(out.product.id, 99, 'links the existing product, does not insert');
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
                    model: null, priceUsd: null, imageUrl: null }]) }];
      }
      if (/FROM TALLY\.products WHERE BARCODE/.test(sql)) return [];
      if (/SELECT i\.ID/.test(sql)) return [];
      writes.push({ sql, params });
      return { affectedRows: 1, insertId: 123 };
    }),
    logger, config,
  });

  const out = await Matches.resolve(5, 42, { candidateIndex: 0 });
  assert.equal(out.product.id, 123);
  const insert = writes.find((w) => /INSERT INTO TALLY\.products/.test(w.sql));
  assert.ok(insert, 'a new catalog row is created');
  assert.ok(insert.params.includes('vision_match'), 'provenance is recorded honestly');
  assert.ok(insert.params.some((p) => typeof p === 'string' && /e\.com/.test(p)),
    'the source URL is kept in RETAIL_LINKS');
});

test('resolve refuses a match the caller cannot reach', async () => {
  Matches.init({ db: fakeDb(() => []), logger, config });
  await assert.rejects(
    () => Matches.resolve(5, 999, { candidateIndex: 0 }),
    /not found/i
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

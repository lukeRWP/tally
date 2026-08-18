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
      return { insertId: 1, affectedRows: 1 };
    }),
    logger, config,
  });

  await Matches.queue({ itemId: 7, brand: 'DeWalt', name: 'Drill' }, 42);

  const guard = seen.find((q) => /property_members/.test(q.sql));
  assert.ok(guard, 'ownership is checked before insert');
  assert.match(guard.sql, /pm\.USER_ID = \?/);
  assert.ok(guard.params.includes(42), 'the caller id is bound');
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

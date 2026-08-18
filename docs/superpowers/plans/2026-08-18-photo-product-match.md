# Photo → Product Match Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A confident photo identification finds the real product — brand, model, UPC, price, image — with no barcode scanned, resolved later from a worklist instead of during capture.

**Architecture:** The capture flow queues a match after creating an item, passing the vision suggestion it already holds. A fire-and-forget runner makes one Claude call with the `web_search` server tool and stores up to three validated candidates on a `product_matches` row. A worklist page resolves them at a desk, converging on the existing product catalog through its `UNIQUE` barcode key.

**Tech Stack:** Express 4 (CommonJS), mysql2, Joi, `@anthropic-ai/sdk`, `node:test` + a local `fakeDb`; React 18 + TypeScript + Vite + TanStack Query v5, Tailwind v4.

Spec: `docs/superpowers/specs/2026-08-18-photo-product-match-design.md`

## Global Constraints

- Route prefixes: `_x_` GET, `_y_` POST. Response envelope: `{success, data, message}`.
- DB columns `UPPER_SNAKE_CASE`; API fields `camelCase`; services map before returning.
- **PRIVACY INVARIANT:** every match read and write joins `items → containers → areas → properties → property_members` with `pm.USER_ID = ?`. No exceptions.
- Migration DDL uses **unqualified** table names and `TABLE_SCHEMA = DATABASE()`. Service SQL uses `TALLY.` prefixes. Both conventions already exist; do not unify them.
- Migrations are idempotent (`information_schema` guard + prepared statement) and contain **no `USE` statement**.
- **Migration 008 is applied to prod BEFORE the code that needs it merges.** Merge-first caused a 14h17m outage on 2026-08-15.
- Server tests: `node --test`, run from `server/`. Each test file defines its own `fakeDb`.
- Client gates: `npx tsc --noEmit` and `npm run build`. **There is no client ESLint in this repo.**
- Server lint: `npm run lint` from `server/` (ESLint exists server-side and catches unexported-but-mocked functions).
- `master` is protected. This lands via PR on branch `feat/photo-product-match`.
- The runner must never register a `req.on('close')` abort handler. That exact pattern aborted every vision call at 0ms and cost a full debugging session.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `SQL/migrations/008_product_matches.sql` | `product_matches` table + `'vision_match'` enum value |
| `server/src/modules/products/lookup/product-match.js` | The Claude call and candidate validation. No SQL. |
| `server/src/modules/products/matches.service.js` | Queue, runner, sweep, list, resolve. All SQL. |
| `server/src/modules/products/matches.schema.js` | Joi schemas |
| `server/src/modules/products/matches.routes.js` | Three routes + limiters |
| `server/test/product-match.test.js` | Candidate validation (pure) |
| `server/test/matches.service.test.js` | Gate, sweep, cap, resolve, privacy |
| `client/src/hooks/use-matches.ts` | Query + mutations |
| `client/src/pages/matches.tsx` | The worklist page |

**Modified**

| File | Change |
|---|---|
| `server/src/config.js` | Add the `match` block |
| `server/index.js` | Register `matches.routes` |
| `client/src/App.tsx` | Add the `/matches` route |
| `client/src/pages/capture.tsx` | Skip step 2, show the pending chip, queue the match |
| `client/src/pages/notifications.tsx` | "N items need a product" entry |

`items.service.js` is **not** modified. The queue is its own route precisely so inventory stays free of a products concern.

---

## Task 1: Migration 008

**Files:**
- Create: `SQL/migrations/008_product_matches.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: table `product_matches` with columns `ID, ITEM_ID, CREATED_BY, STATUS, SEARCH_QUERY, CANDIDATES, SELECTED_PRODUCT_ID, ATTEMPTS, LAST_ERROR, SEARCH_STARTED_AT, CREATED_AT, UPDATED_AT, RESOLVED_AT`; `products.DATA_SOURCE` gains `'vision_match'`.

- [ ] **Step 1: Write the migration**

Create `SQL/migrations/008_product_matches.sql`:

```sql
-- Photo → product match: the worklist behind deferred product selection.
--
-- A match row is created when the capture flow queues one, worked by a
-- fire-and-forget runner, and resolved later from /matches.
--
-- IDEMPOTENT. The migrate-all playbook stops at the first error, so a
-- non-idempotent statement here blocks every later migration behind it (that
-- is exactly how 002 blocked 003 on 2026-08-05).
--
-- No `USE` statement — the playbook selects the app DB with -D TALLY, which is
-- also why table names below are unqualified and the guard reads DATABASE().

CREATE TABLE IF NOT EXISTS product_matches (
    ID                   INT           NOT NULL AUTO_INCREMENT,
    ITEM_ID              INT           NOT NULL,
    CREATED_BY           INT           NOT NULL,
    STATUS               ENUM('queued','searching','ready','none','failed','resolved','dismissed')
                                       NOT NULL DEFAULT 'queued',
    SEARCH_QUERY         JSON          NULL,
    CANDIDATES           JSON          NULL,
    SELECTED_PRODUCT_ID  INT           NULL,
    ATTEMPTS             INT           NOT NULL DEFAULT 0,
    LAST_ERROR           VARCHAR(500)  NULL,
    SEARCH_STARTED_AT    DATETIME      NULL,
    CREATED_AT           DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UPDATED_AT           DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    RESOLVED_AT          DATETIME      NULL,
    PRIMARY KEY (ID),
    -- One match per item: a double-fired queue call cannot create two.
    UNIQUE KEY uq_product_matches_item (ITEM_ID),
    KEY ix_product_matches_status (STATUS),
    -- Serves the per-user daily cap count.
    KEY ix_product_matches_creator (CREATED_BY, CREATED_AT),
    -- Items are soft-deleted normally, but the recycle bin's 30-day purge is a
    -- hard DELETE, and a match must not outlive its item.
    CONSTRAINT fk_product_matches_item
        FOREIGN KEY (ITEM_ID) REFERENCES items (ID) ON DELETE CASCADE,
    CONSTRAINT fk_product_matches_product
        FOREIGN KEY (SELECTED_PRODUCT_ID) REFERENCES products (ID)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- products.DATA_SOURCE gains 'vision_match'. MySQL 8 has no
-- "ADD VALUE IF NOT EXISTS", so read the current type and only ALTER when the
-- value is absent. COALESCE makes a missing column a no-op rather than a crash.
SET @col := (
  SELECT COLUMN_TYPE FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'products'
     AND COLUMN_NAME  = 'DATA_SOURCE'
);
SET @ddl := IF(LOCATE('vision_match', COALESCE(@col, 'vision_match')) = 0,
  "ALTER TABLE products MODIFY COLUMN DATA_SOURCE ENUM('upc_db','open_food_facts','scrape','manual','vision_match') NULL",
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
```

- [ ] **Step 2: Apply it locally and verify the schema**

```bash
cd /Users/luketurner/dev/tally
task db:reset
docker compose exec -T tally-db mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -D TALLY \
  -e "DESCRIBE product_matches; SHOW COLUMNS FROM products LIKE 'DATA_SOURCE';"
```

Expected: 13 columns on `product_matches`; `DATA_SOURCE` type includes `vision_match`.

- [ ] **Step 3: Prove idempotency by applying it twice**

```bash
docker compose exec -T tally-db mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -D TALLY \
  < SQL/migrations/008_product_matches.sql
echo "exit=$?"
```

Expected: `exit=0`, no error. A second run must be a silent no-op. If this errors, the migration will block every later one in prod — fix before continuing.

- [ ] **Step 4: Commit**

```bash
git add SQL/migrations/008_product_matches.sql
git commit -m "feat(db): migration 008 — product_matches table and vision_match source"
```

---

## Task 2: The match call and candidate validation

**Files:**
- Create: `server/src/modules/products/lookup/product-match.js`
- Create: `server/test/product-match.test.js`
- Modify: `server/src/config.js` (add the `match` block after the `vision` block, around line 117)

**Interfaces:**
- Consumes: `config.match` (added in this task).
- Produces:
  - `normaliseCandidates(raw, max) -> Candidate[]`
  - `search({brand, name, category, description}, {config, logger}) -> {candidates: Candidate[]}`
  - `Candidate = {name, brand, model, upc, priceUsd, imageUrl, sourceUrl, sourceDomain}` — every field a string or null except `priceUsd` (number or null); `name`, `sourceUrl`, `sourceDomain` are always non-null on a surviving candidate.

- [ ] **Step 1: Add the config block**

In `server/src/config.js`, immediately after the closing brace of the `vision` block:

```js
  match: {
    model: process.env.MATCH_MODEL || 'claude-sonnet-5',
    // Shares vision's key. Two ways off, same as vision: no key, or the flag.
    enabled: !!process.env.ANTHROPIC_API_KEY && process.env.MATCH_ENABLED !== 'false',
    // Far longer than vision's 12s: a call that runs several web searches
    // legitimately takes tens of seconds, and nobody is waiting on it.
    timeoutMs: parseInt(process.env.MATCH_TIMEOUT_MS || '45000', 10),
    dailyPerUser: parseInt(process.env.MATCH_DAILY_PER_USER || '100', 10),
    maxCandidates: parseInt(process.env.MATCH_MAX_CANDIDATES || '3', 10),
    staleMinutes: parseInt(process.env.MATCH_STALE_MINUTES || '5', 10),
    maxAttempts: parseInt(process.env.MATCH_MAX_ATTEMPTS || '3', 10),
  },
```

- [ ] **Step 2: Write the failing test**

Create `server/test/product-match.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { normaliseCandidates } = require('../src/modules/products/lookup/product-match');

test('drops a candidate with no name', () => {
  const out = normaliseCandidates([{ sourceUrl: 'https://example.com/a' }], 3);
  assert.equal(out.length, 0);
});

test('drops a candidate with no sourceUrl', () => {
  const out = normaliseCandidates([{ name: 'Drill' }], 3);
  assert.equal(out.length, 0);
});

test('rejects a non-https sourceUrl', () => {
  const out = normaliseCandidates(
    [{ name: 'Drill', sourceUrl: 'http://example.com/a' }], 3);
  assert.equal(out.length, 0);
});

test('keeps a valid UPC and nulls a malformed one', () => {
  const [good] = normaliseCandidates(
    [{ name: 'A', sourceUrl: 'https://e.com/a', upc: '885911474764' }], 3);
  assert.equal(good.upc, '885911474764');

  const [bad] = normaliseCandidates(
    [{ name: 'A', sourceUrl: 'https://e.com/a', upc: '12345' }], 3);
  assert.equal(bad.upc, null, 'a 5-digit UPC is not a UPC');
});

test('accepts every valid GTIN length', () => {
  for (const upc of ['12345678', '123456789012', '1234567890123', '12345678901234']) {
    const [c] = normaliseCandidates(
      [{ name: 'A', sourceUrl: 'https://e.com/a', upc }], 3);
    assert.equal(c.upc, upc, `${upc.length}-digit GTIN is valid`);
  }
});

test('derives sourceDomain from the URL, ignoring what the model claimed', () => {
  const [c] = normaliseCandidates([{
    name: 'A', sourceUrl: 'https://www.walmart.com/ip/123', sourceDomain: 'amazon.com',
  }], 3);
  assert.equal(c.sourceDomain, 'walmart.com', 'domain comes from the URL, not the model');
});

test('caps the list at max', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({
    name: `P${i}`, sourceUrl: `https://e.com/${i}`,
  }));
  assert.equal(normaliseCandidates(many, 3).length, 3);
});

test('a non-array is an empty list, not a throw', () => {
  assert.deepEqual(normaliseCandidates(null, 3), []);
  assert.deepEqual(normaliseCandidates({ candidates: [] }, 3), []);
});

test('drops a negative or non-numeric price', () => {
  const [c] = normaliseCandidates(
    [{ name: 'A', sourceUrl: 'https://e.com/a', priceUsd: -5 }], 3);
  assert.equal(c.priceUsd, null);
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd server && npm test -- test/product-match.test.js
```

Expected: FAIL — `Cannot find module '../src/modules/products/lookup/product-match'`.

- [ ] **Step 4: Implement**

Create `server/src/modules/products/lookup/product-match.js`:

```js
const SDK = require('@anthropic-ai/sdk');

// A GTIN is 8, 12, 13 or 14 digits. Anything else the model offers as a "UPC"
// is not one — and a wrong barcode is worse than no barcode, because resolve
// uses it to converge on a catalog row.
const GTIN = /^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/;

function str(v, max) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function httpsUrl(v) {
  const s = str(v, 2000);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' ? u : null;
  } catch { return null; }
}

/**
 * Validate whatever the model returned into candidates we are willing to store.
 *
 * Everything here is defensive on purpose: this is model output reaching a
 * table that resolve reads to write the product catalog.
 */
function normaliseCandidates(raw, max) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const name = str(c.name, 255);
    const source = httpsUrl(c.sourceUrl);
    if (!name || !source) continue;          // both are required
    const upc = str(c.upc, 14);
    const price = typeof c.priceUsd === 'number' && isFinite(c.priceUsd) && c.priceUsd > 0
      ? Math.round(c.priceUsd * 100) / 100 : null;
    out.push({
      name,
      brand: str(c.brand, 255),
      model: str(c.model, 255),
      upc: upc && GTIN.test(upc) ? upc : null,
      priceUsd: price,
      imageUrl: httpsUrl(c.imageUrl)?.toString() ?? null,
      sourceUrl: source.toString(),
      // Derived, never taken from the model: it is the one field a reader uses
      // to judge whether a source is credible, so it must match the real URL.
      sourceDomain: source.hostname.replace(/^www\./, ''),
    });
    if (out.length >= max) break;
  }
  return out;
}

const SYSTEM = [
  'You identify a specific consumer product from a short description taken from',
  'a photo, and return purchasable matches.',
  '',
  'Use web search to find the actual product. Return at most 3 candidates,',
  'best first. Prefer a manufacturer or major-retailer page.',
  '',
  'Return a UPC/EAN only when the page states one. Never construct, guess or',
  'infer a barcode — an invented one is worse than none, because it will be',
  'treated as an identity. The same applies to model numbers.',
  '',
  'If you cannot find the product, return an empty list. An empty list is a',
  'correct answer and is preferred over a plausible wrong one.',
].join('\n');

const SCHEMA = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          brand: { type: ['string', 'null'] },
          model: { type: ['string', 'null'] },
          upc: { type: ['string', 'null'] },
          priceUsd: { type: ['number', 'null'] },
          imageUrl: { type: ['string', 'null'] },
          sourceUrl: { type: 'string' },
        },
        required: ['name', 'sourceUrl'],
        additionalProperties: false,
      },
    },
  },
  required: ['candidates'],
  additionalProperties: false,
};

function queryText({ brand, name, category, description }) {
  return [
    brand ? `Brand: ${brand}` : null,
    name ? `Item: ${name}` : null,
    category ? `Category: ${category}` : null,
    description ? `Seen in photo: ${description}` : null,
  ].filter(Boolean).join('\n');
}

/**
 * One Claude call with web search. Resolves to {candidates}; an unusable
 * response resolves to an empty list rather than throwing, because "found
 * nothing" and "returned nonsense" are the same outcome to the caller.
 * Transport and auth failures DO throw — the runner distinguishes them so a
 * retry can happen.
 */
async function search(input, { config, logger }) {
  const client = new SDK({ apiKey: config.vision.apiKey });
  const res = await client.messages.create({
    model: config.match.model,
    max_tokens: 2000,
    thinking: { type: 'adaptive' },
    system: SYSTEM,
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }],
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: queryText(input) }],
  }, { timeout: config.match.timeoutMs });

  const text = (res.content || [])
    .filter((b) => b.type === 'text').map((b) => b.text).join('');
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {
    logger?.warn('product match returned non-JSON', { stopReason: res.stop_reason });
    return { candidates: [] };
  }
  return { candidates: normaliseCandidates(parsed?.candidates, config.match.maxCandidates) };
}

module.exports = { search, normaliseCandidates };
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd server && npm test -- test/product-match.test.js
```

Expected: all 9 PASS.

- [ ] **Step 6: Lint and commit**

```bash
cd server && npm run lint
git add server/src/config.js server/src/modules/products/lookup/product-match.js server/test/product-match.test.js
git commit -m "feat(products): product match search with validated candidates"
```

---

## Task 3: Queue, runner and sweep

**Files:**
- Create: `server/src/modules/products/matches.service.js`
- Create: `server/test/matches.service.test.js`

**Interfaces:**
- Consumes: `search(input, {config, logger})` and `normaliseCandidates` from Task 2.
- Produces:
  - `init({db, logger, config})`
  - `queue({itemId, brand, name, category, description}, userId) -> {id, status}`
  - `runNow(matchId) -> Promise<void>` — awaitable, so tests never depend on a floating promise
  - `sweepStale() -> number` (rows requeued or failed)
  - `countToday(userId) -> number`

- [ ] **Step 1: Write the failing test**

Create `server/test/matches.service.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && npm test -- test/matches.service.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `server/src/modules/products/matches.service.js`:

```js
const productMatch = require('./lookup/product-match');

let _db = null;
let _logger = null;
let _config = null;
let _search = null;

const MatchesService = {
  /** `searcher` is injectable so tests never reach the network. */
  init({ db, logger, config, searcher }) {
    _db = db;
    _logger = logger;
    _config = config;
    _search = searcher || ((input) => productMatch.search(input, { config, logger }));
  },

  async countToday(userId) {
    const rows = await _db.query(
      `SELECT COUNT(*) AS N FROM TALLY.product_matches
        WHERE CREATED_BY = ? AND CREATED_AT > DATE_SUB(NOW(), INTERVAL 1 DAY)`,
      [userId]
    );
    return rows[0]?.N ?? 0;
  },

  /**
   * Queue a match for an item the caller owns.
   *
   * The gate (high confidence + a brand) is applied by the client, which is the
   * only place the vision confidence exists. Ownership is NOT advisory and is
   * checked here through the membership join, like every other read.
   */
  async queue({ itemId, brand, name, category, description }, userId) {
    const owned = await _db.query(
      `SELECT i.ID
         FROM TALLY.items i
         JOIN TALLY.containers c ON i.CONTAINER_ID = c.ID
         JOIN TALLY.areas a ON c.AREA_ID = a.ID
         JOIN TALLY.properties p ON a.PROPERTY_ID = p.ID
         JOIN TALLY.property_members pm ON p.ID = pm.PROPERTY_ID
        WHERE i.ID = ? AND pm.USER_ID = ? AND i.DELETED_AT IS NULL`,
      [itemId, userId]
    );
    if (owned.length === 0) {
      const err = new Error('Item not found');
      err.status = 404;
      throw err;
    }

    if (await MatchesService.countToday(userId) >= _config.match.dailyPerUser) {
      const err = new Error('Daily product-match limit reached');
      err.status = 429;
      throw err;
    }

    const query = { brand: brand ?? null, name: name ?? null,
                    category: category ?? null, description: description ?? null };

    // ON DUPLICATE KEY: the UNIQUE on ITEM_ID makes a re-queue idempotent
    // rather than an error, which is what a retrying client should get.
    const res = await _db.query(
      `INSERT INTO TALLY.product_matches (ITEM_ID, CREATED_BY, STATUS, SEARCH_QUERY)
            VALUES (?, ?, 'queued', ?)
       ON DUPLICATE KEY UPDATE ID = LAST_INSERT_ID(ID)`,
      [itemId, userId, JSON.stringify(query)]
    );
    return { id: res.insertId, status: 'queued' };
  },

  /**
   * Work one match to completion.
   *
   * Awaitable for tests, but called without await in the route — this is the
   * fire-and-forget runner. It NEVER rejects: a rejection from an unawaited
   * promise is an unhandled rejection, and there is no caller left to see it.
   *
   * There is deliberately no abort-on-disconnect wiring here. A `req.on('close')`
   * handler aborted every vision call at 0ms; this runner outlives its request
   * by design.
   */
  async runNow(matchId) {
    try {
      const rows = await _db.query(
        `SELECT ID, SEARCH_QUERY FROM TALLY.product_matches WHERE ID = ?`, [matchId]
      );
      if (rows.length === 0) return;
      const input = typeof rows[0].SEARCH_QUERY === 'string'
        ? JSON.parse(rows[0].SEARCH_QUERY || '{}')
        : (rows[0].SEARCH_QUERY || {});

      await _db.query(
        `UPDATE TALLY.product_matches
            SET STATUS = 'searching', SEARCH_STARTED_AT = NOW()
          WHERE ID = ?`,
        [matchId]
      );

      const { candidates } = await _search(input);

      if (candidates.length === 0) {
        await _db.query(
          `UPDATE TALLY.product_matches SET STATUS = 'none', CANDIDATES = NULL WHERE ID = ?`,
          [matchId]
        );
        return;
      }
      await _db.query(
        `UPDATE TALLY.product_matches SET STATUS = 'ready', CANDIDATES = ? WHERE ID = ?`,
        [JSON.stringify(candidates), matchId]
      );
    } catch (err) {
      _logger?.warn('product match run failed', { matchId, error: err.message });
      try {
        // Back to 'queued' so the sweep retries, unless the cap is reached —
        // one statement so the decision cannot drift from the sweep's.
        await _db.query(
          `UPDATE TALLY.product_matches
              SET STATUS = CASE WHEN ATTEMPTS + 1 >= ? THEN 'failed' ELSE 'queued' END,
                  ATTEMPTS = ATTEMPTS + 1,
                  LAST_ERROR = ?
            WHERE ID = ?`,
          [_config.match.maxAttempts, String(err.message).slice(0, 500), matchId]
        );
      } catch (inner) {
        _logger?.error('could not record match failure', { matchId, error: inner.message });
      }
    }
  },

  /**
   * Lazy sweep, borrowed wholesale from print's sweepStaleClaims: a runner that
   * dies mid-search would otherwise strand its row in 'searching' forever, and
   * this app has nowhere to run a cron.
   */
  async sweepStale() {
    const res = await _db.query(
      `UPDATE TALLY.product_matches
          SET STATUS = CASE WHEN ATTEMPTS + 1 >= ? THEN 'failed' ELSE 'queued' END,
              LAST_ERROR = CASE WHEN ATTEMPTS + 1 >= ?
                                THEN 'Search stopped responding' ELSE LAST_ERROR END,
              ATTEMPTS = ATTEMPTS + 1
        WHERE STATUS = 'searching'
          AND SEARCH_STARTED_AT < DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
      [_config.match.maxAttempts, _config.match.maxAttempts, _config.match.staleMinutes]
    );
    return res.affectedRows;
  },
};

module.exports = MatchesService;
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd server && npm test -- test/matches.service.test.js
```

Expected: all 7 PASS.

- [ ] **Step 5: Lint and commit**

```bash
cd server && npm run lint
git add server/src/modules/products/matches.service.js server/test/matches.service.test.js
git commit -m "feat(products): queue, fire-and-forget runner and lazy stale sweep"
```

---

## Task 4: List and resolve

**Files:**
- Modify: `server/src/modules/products/matches.service.js` (add `list` and `resolve`)
- Modify: `server/test/matches.service.test.js` (add cases)

**Interfaces:**
- Consumes: everything from Task 3.
- Produces:
  - `list(propertyId, userId) -> Match[]` where `Match = {id, itemId, itemName, containerName, status, candidates, lastError, createdAt}`
  - `resolve(matchId, userId, {candidateIndex, dismiss}) -> {product, duplicates}` where `product` is `{id, name, brand, barcode}` or `null` on dismiss, and `duplicates` is the `checkDuplicate` array.

- [ ] **Step 1: Write the failing tests**

Append to `server/test/matches.service.test.js`:

```js
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
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd server && npm test -- test/matches.service.test.js
```

Expected: the 6 new cases FAIL — `Matches.list is not a function`.

- [ ] **Step 3: Implement**

Add to `matches.service.js`, before `module.exports`:

```js
  /**
   * The worklist. Sweeps first so a row stranded by a dead runner is recovered
   * before it is listed, rather than sitting in 'searching' forever.
   *
   * 'none' and 'failed' are included deliberately: if a failed lookup vanished
   * from the list, nobody would ever learn it failed.
   */
  async list(propertyId, userId) {
    await MatchesService.sweepStale();
    const rows = await _db.query(
      `SELECT m.ID, m.ITEM_ID, m.STATUS, m.CANDIDATES, m.LAST_ERROR, m.CREATED_AT,
              i.NAME AS ITEM_NAME, c.NAME AS CONTAINER_NAME
         FROM TALLY.product_matches m
         JOIN TALLY.items i ON m.ITEM_ID = i.ID
         JOIN TALLY.containers c ON i.CONTAINER_ID = c.ID
         JOIN TALLY.areas a ON c.AREA_ID = a.ID
         JOIN TALLY.properties p ON a.PROPERTY_ID = p.ID
         JOIN TALLY.property_members pm ON p.ID = pm.PROPERTY_ID
        WHERE pm.USER_ID = ? AND p.ID = ?
          AND i.DELETED_AT IS NULL
          AND m.STATUS IN ('queued','searching','ready','none','failed')
        ORDER BY m.CREATED_AT DESC`,
      [userId, propertyId]
    );
    return rows.map((r) => ({
      id: r.ID,
      itemId: r.ITEM_ID,
      itemName: r.ITEM_NAME,
      containerName: r.CONTAINER_NAME,
      status: r.STATUS,
      candidates: typeof r.CANDIDATES === 'string'
        ? JSON.parse(r.CANDIDATES || '[]') : (r.CANDIDATES || []),
      lastError: r.LAST_ERROR,
      createdAt: r.CREATED_AT,
    }));
  },

  /**
   * Attach a chosen candidate, or dismiss the match.
   *
   * Convergence: products.BARCODE is UNIQUE, so a known UPC links the existing
   * catalog row instead of racing the barcode path to create a second one.
   */
  async resolve(matchId, userId, { candidateIndex, dismiss }) {
    const rows = await _db.query(
      `SELECT m.ID, m.ITEM_ID, m.STATUS, m.CANDIDATES
         FROM TALLY.product_matches m
         JOIN TALLY.items i ON m.ITEM_ID = i.ID
         JOIN TALLY.containers c ON i.CONTAINER_ID = c.ID
         JOIN TALLY.areas a ON c.AREA_ID = a.ID
         JOIN TALLY.properties p ON a.PROPERTY_ID = p.ID
         JOIN TALLY.property_members pm ON p.ID = pm.PROPERTY_ID
        WHERE m.ID = ? AND pm.USER_ID = ? AND i.DELETED_AT IS NULL`,
      [matchId, userId]
    );
    if (rows.length === 0) {
      const err = new Error('Match not found');
      err.status = 404;
      throw err;
    }
    const match = rows[0];

    if (dismiss) {
      await _db.query(
        `UPDATE TALLY.product_matches
            SET STATUS = 'dismissed', RESOLVED_AT = NOW() WHERE ID = ?`,
        [matchId]
      );
      return { product: null, duplicates: [] };
    }

    const candidates = typeof match.CANDIDATES === 'string'
      ? JSON.parse(match.CANDIDATES || '[]') : (match.CANDIDATES || []);
    const chosen = candidates[candidateIndex];
    if (!chosen) {
      const err = new Error('No such candidate');
      err.status = 400;
      throw err;
    }

    // Converge on the catalog before inserting.
    let productId = null;
    if (chosen.upc) {
      const existing = await _db.query(
        'SELECT ID FROM TALLY.products WHERE BARCODE = ?', [chosen.upc]
      );
      if (existing.length > 0) productId = existing[0].ID;
    }

    if (productId == null) {
      const res = await _db.query(
        `INSERT INTO TALLY.products
           (BARCODE, NAME, BRAND, IMAGE_URL, RETAIL_PRICE, RETAIL_LINKS, DATA_SOURCE)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [chosen.upc, chosen.name, chosen.brand, chosen.imageUrl, chosen.priceUsd,
         JSON.stringify([{ url: chosen.sourceUrl, domain: chosen.sourceDomain }]),
         'vision_match']
      );
      productId = res.insertId;
    }

    await _db.query(
      'UPDATE TALLY.items SET PRODUCT_ID = ? WHERE ID = ?', [productId, match.ITEM_ID]
    );
    await _db.query(
      `UPDATE TALLY.product_matches
          SET STATUS = 'resolved', SELECTED_PRODUCT_ID = ?, RESOLVED_AT = NOW()
        WHERE ID = ?`,
      [productId, matchId]
    );

    // Duplicate detection lands HERE, not at capture: this is the first moment
    // a barcode exists to check against.
    let duplicates = [];
    if (chosen.upc) {
      const dupes = await _db.query(
        `SELECT i.ID, i.NAME, c.NAME AS CONTAINER_NAME
           FROM TALLY.items i
           JOIN TALLY.containers c ON i.CONTAINER_ID = c.ID
           JOIN TALLY.areas a ON c.AREA_ID = a.ID
           JOIN TALLY.properties p ON a.PROPERTY_ID = p.ID
           JOIN TALLY.property_members pm ON p.ID = pm.PROPERTY_ID
          WHERE i.PRODUCT_ID = ? AND pm.USER_ID = ?
            AND i.ID <> ? AND i.DELETED_AT IS NULL`,
        [productId, userId, match.ITEM_ID]
      );
      duplicates = dupes.map((d) => ({
        id: d.ID, name: d.NAME, containerName: d.CONTAINER_NAME,
      }));
    }

    return {
      product: { id: productId, name: chosen.name, brand: chosen.brand, barcode: chosen.upc },
      duplicates,
    };
  },
```

- [ ] **Step 4: Run to verify all pass**

```bash
cd server && npm test -- test/matches.service.test.js
```

Expected: all 13 PASS.

- [ ] **Step 5: Lint and commit**

```bash
cd server && npm run lint
git add server/src/modules/products/matches.service.js server/test/matches.service.test.js
git commit -m "feat(products): worklist read and resolve with catalog convergence"
```

---

## Task 5: Schema, routes and registration

**Files:**
- Create: `server/src/modules/products/matches.schema.js`
- Create: `server/src/modules/products/matches.routes.js`
- Modify: `server/index.js` (add the registration line next to the other products route)

**Interfaces:**
- Consumes: `MatchesService.{init,queue,list,resolve,runNow}` from Tasks 3–4.
- Produces: `POST /api/products/_y_/matches`, `GET /api/products/_x_/matches`, `POST /api/products/_y_/matches/:id/resolve`.

- [ ] **Step 1: Write the schema**

Create `server/src/modules/products/matches.schema.js`:

```js
const Joi = require('joi');

const queueSchema = Joi.object({
  itemId: Joi.number().integer().positive().required(),
  // A brand is what makes a search resolvable, so it is required here even
  // though the confidence half of the gate can only be applied client-side.
  brand: Joi.string().trim().max(255).required(),
  name: Joi.string().trim().max(255).required(),
  category: Joi.string().trim().max(100).allow(null, ''),
  description: Joi.string().trim().max(1000).allow(null, ''),
});

const listQuerySchema = Joi.object({
  propertyId: Joi.number().integer().positive().required(),
});

const resolveSchema = Joi.object({
  candidateIndex: Joi.number().integer().min(0).max(9),
  dismiss: Joi.boolean(),
}).xor('candidateIndex', 'dismiss');

module.exports = { queueSchema, listQuerySchema, resolveSchema };
```

- [ ] **Step 2: Write the routes**

Create `server/src/modules/products/matches.routes.js`:

```js
const rateLimit = require('express-rate-limit');
const MatchesService = require('./matches.service');
// success(res, data) and error(res, message, status) take res FIRST and send
// the response themselves — they do not return a body to be passed to json().
const { success, error } = require('../../utils/response');
const validate = require('../../middleware/validate');
const { queueSchema, listQuerySchema, resolveSchema } = require('./matches.schema');

module.exports = ({ app, db, logger, config }) => {
  MatchesService.init({ db, logger, config });

  const matchBurst = rateLimit({ windowMs: 60 * 1000, max: 30,
    message: { success: false, message: 'Too many product matches, slow down' } });
  const matchDaily = rateLimit({ windowMs: 24 * 60 * 60 * 1000, max: config.match.dailyPerUser,
    message: { success: false, message: 'Daily product-match limit reached' } });

  // POST /api/products/_y_/matches — queue and return immediately.
  app.post('/api/products/_y_/matches',
    app.locals.requireAuth, matchBurst, matchDaily, validate(queueSchema),
    async (req, res) => {
      if (!config.match.enabled) {
        return error(res, 'Product matching is disabled', 503);
      }
      try {
        const out = await MatchesService.queue(req.body, req.user.id);
        // Fire and forget. NOT awaited: the client must not wait for a web
        // search, and there is deliberately no abort-on-disconnect wiring —
        // that pattern aborted every vision call at 0ms.
        void MatchesService.runNow(out.id);
        return success(res, out);
      } catch (err) {
        logger.warn('queue match failed', { error: err.message });
        return error(res, err.message, err.status || 500);
      }
    });

  // GET /api/products/_x_/matches?propertyId=1
  app.get('/api/products/_x_/matches',
    app.locals.requireAuth, validate(listQuerySchema, 'query'),
    async (req, res) => {
      try {
        const matches = await MatchesService.list(
          Number(req.query.propertyId), req.user.id);
        return success(res, matches);
      } catch (err) {
        logger.error('list matches failed', { error: err.message });
        return error(res, 'Could not load product matches', 500);
      }
    });

  // POST /api/products/_y_/matches/:id/resolve
  app.post('/api/products/_y_/matches/:id/resolve',
    app.locals.requireAuth, validate(resolveSchema),
    async (req, res) => {
      try {
        const out = await MatchesService.resolve(
          Number(req.params.id), req.user.id, req.body);
        return success(res, out);
      } catch (err) {
        logger.warn('resolve match failed', { error: err.message });
        return error(res, err.message, err.status || 500);
      }
    });
};
```

- [ ] **Step 3: Register in `server/index.js`**

Immediately after the existing products route registration:

```js
require('./src/modules/products/matches.routes')({ app, db, logger, config });
```

- [ ] **Step 4: Verify the server boots and the routes exist**

```bash
cd server && node -e "require('./src/modules/products/matches.routes'); console.log('loads')"
npm test
npm run lint
```

Expected: `loads`, the whole suite green, lint clean.

`validate(schema, source = 'body')` already takes a source argument, so
`validate(listQuerySchema, 'query')` is correct as written — it also coerces
and strips, so `req.query.propertyId` arrives as a number.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/products/matches.schema.js server/src/modules/products/matches.routes.js server/index.js
git commit -m "feat(products): match routes — queue, worklist, resolve"
```

---

## Task 6: The worklist page

**Files:**
- Create: `client/src/hooks/use-matches.ts`
- Create: `client/src/pages/matches.tsx`
- Modify: `client/src/App.tsx`

**Interfaces:**
- Consumes: the three routes from Task 5.
- Produces: `useMatches(propertyId)`, `useResolveMatch()`, and the `/matches` route.

- [ ] **Step 1: Write the hook**

Create `client/src/hooks/use-matches.ts`:

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface MatchCandidate {
  name: string;
  brand: string | null;
  model: string | null;
  upc: string | null;
  priceUsd: number | null;
  imageUrl: string | null;
  sourceUrl: string;
  sourceDomain: string;
}

export type MatchStatus = 'queued' | 'searching' | 'ready' | 'none' | 'failed';

export interface ProductMatch {
  id: number;
  itemId: number;
  itemName: string;
  containerName: string;
  status: MatchStatus;
  candidates: MatchCandidate[];
  lastError: string | null;
  createdAt: string;
}

export const matchKeys = {
  list: (propertyId: number) => ['matches', propertyId] as const,
};

export function useMatches(propertyId?: number) {
  return useQuery({
    queryKey: matchKeys.list(propertyId ?? 0),
    queryFn: () => api.get<ProductMatch[]>(`/api/products/_x_/matches?propertyId=${propertyId}`),
    enabled: !!propertyId,
    // Poll only while something is still being worked. A worklist of settled
    // rows is static, and polling it forever is just noise on the server.
    refetchInterval: (query) => {
      const rows = query.state.data as ProductMatch[] | undefined;
      const working = rows?.some((m) => m.status === 'queued' || m.status === 'searching');
      return working ? 5000 : false;
    },
  });
}

export function useResolveMatch(propertyId?: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: number; candidateIndex?: number; dismiss?: boolean }) =>
      api.post(`/api/products/_y_/matches/${vars.id}/resolve`,
        vars.dismiss ? { dismiss: true } : { candidateIndex: vars.candidateIndex }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: matchKeys.list(propertyId ?? 0) });
      // The item now has a product; anything showing items is stale.
      qc.invalidateQueries({ queryKey: ['items'] });
    },
  });
}

export function useQueueMatch() {
  return useMutation({
    mutationFn: (vars: {
      itemId: number; brand: string; name: string;
      category?: string | null; description?: string | null;
    }) => api.post('/api/products/_y_/matches', vars),
  });
}
```

- [ ] **Step 2: Write the page**

Create `client/src/pages/matches.tsx`. It uses the existing `SplitView` (`{list, detail}`) and `SplitEmpty` (`{children, hint}`) from `@/components/layout/split-view`, `useLayoutMode()` from `@/hooks/use-layout-mode`, `RuledRow` from `@/components/ui/ruled-row`, `ColHead`, `Button` and `Badge`.

Structure:

```tsx
export default function MatchesPage() {
  // Same pattern as print-queue.tsx: the first property the user belongs to.
  const { data: properties } = useProperties();
  const propertyId = properties?.[0]?.id;
  const { data: matches, isLoading } = useMatches(propertyId);
  const [selected, setSelected] = React.useState<number | null>(null);
  const resolve = useResolveMatch(propertyId);
  const split = useLayoutMode() === 'sidebar';

  const rows = matches ?? [];
  const current = rows.find((m) => m.id === selected) ?? null;

  const list = (
    <div>
      <ColHead>{rows.length} awaiting a product</ColHead>
      {rows.map((m) => (
        <RuledRow
          key={m.id}
          title={m.itemName}
          meta={m.containerName}
          trailing={<StatusBadge status={m.status} count={m.candidates.length} />}
          onNavigate={() => setSelected(m.id)}
        />
      ))}
    </div>
  );

  const detail = current
    ? <CandidatePanel match={current} onPick={(i) => resolve.mutate({ id: current.id, candidateIndex: i })}
                      onDismiss={() => resolve.mutate({ id: current.id, dismiss: true })} />
    : <SplitEmpty hint="the list stays put while you look">Pick an item to see its matches.</SplitEmpty>;

  if (!split) return current ? detail : list;    // phone: list, then detail
  return <SplitView list={list} detail={detail} />;
}
```

`StatusBadge` maps status to words, never a bare code: `queued`/`searching` → "Looking…", `ready` → "N found", `none` → "No match", `failed` → "Couldn't look up".

`CandidatePanel` renders each candidate as a card — image (or a placeholder), name, brand, model, UPC in mono, price — with a **Use this** button, and below them a **None of these** button wired to `onDismiss`. For `none`/`failed` it renders `match.lastError` (when present) plus two links: *Scan barcode* → `/capture`, *Search manually* → `/search`.

- [ ] **Step 3: Add the route**

In `client/src/App.tsx`, alongside the other authenticated routes:

```tsx
<Route path="/matches" element={<MatchesPage />} />
```

- [ ] **Step 4: Verify**

```bash
cd client && npx tsc --noEmit && npm run build
```

Expected: both clean. (There is no client ESLint.)

- [ ] **Step 5: Screenshot at all three widths**

Add matches fixtures to `scratchpad/uiharness/server.js` — a `/api/products/_x_/matches` route returning rows in `ready`, `queued` and `none` states, so all three renderings are exercised. Remember these fixture endpoints return the array **as `data`**.

```bash
cd scratchpad/uiharness
SCHEME=dark WIDTHS='{"phone":[390,844],"tablet":[768,1024],"desk":[1600,1000]}' \
  node shoot.js http://localhost:4178 shots matches /matches
```

Look at all three. A layout bug here is invisible to `tsc` and to the build.

- [ ] **Step 6: Commit**

```bash
git add client/src/hooks/use-matches.ts client/src/pages/matches.tsx client/src/App.tsx
git commit -m "feat(client): product match worklist"
```

---

## Task 7: Capture flow and the Alerts entry

**Files:**
- Modify: `client/src/pages/capture.tsx`
- Modify: `client/src/pages/notifications.tsx`

**Interfaces:**
- Consumes: `useQueueMatch()` and `useMatches(propertyId)` from Task 6.
- Produces: no new exports.

- [ ] **Step 1: Queue the match after the item is created**

In `capture.tsx`, where the item create mutation succeeds, add:

```ts
// The gate: high confidence AND a brand. The brand is the real signal — the
// vision prompt forbids inventing one, so a brand coming back means text was
// legible on the object, which is exactly when a search can resolve to one
// product. An unbranded mug never searches.
const canMatch = suggestion?.confidence === 'high' && !!suggestion?.brand;
if (canMatch && createdItem?.id) {
  queueMatch.mutate({
    itemId: createdItem.id,
    brand: suggestion.brand!,
    name: suggestion.name ?? draft.name,
    category: suggestion.category,
    description: suggestion.description,
  });
}
```

Failures are ignored on purpose — a queue that did not take must never block the capture. The item exists either way and can still be scanned later.

- [ ] **Step 2: Skip step 2 and show the pending chip**

Where step 2 (the barcode scanner) is rendered, render the chip instead when `canMatch` is true, keeping the manual entry escape hatch:

```tsx
{canMatch ? (
  <div className="flex items-center gap-2 border border-[var(--color-rule)] rounded-[var(--radius-sm)] px-3 py-2">
    <Sparkles className="h-4 w-4 text-[var(--color-primary)]" />
    <span className="text-sm">Finding this product — pick it later in Alerts</span>
  </div>
) : (
  /* the existing step 2 barcode UI, unchanged */
)}
```

- [ ] **Step 3: Add the Alerts entry**

In `notifications.tsx`, add a row when there are pending matches:

```tsx
{pendingMatches > 0 && (
  <RuledRow
    title={`${pendingMatches} item${pendingMatches === 1 ? '' : 's'} need a product`}
    meta="Pick from photo matches"
    onNavigate={() => navigate('/matches')}
  />
)}
```

where `pendingMatches` counts rows whose status is `ready`, `none` or `failed` — the ones a person can actually act on. Rows still `queued`/`searching` are not yet actionable and must not be advertised as work.

- [ ] **Step 4: Verify**

```bash
cd client && npx tsc --noEmit && npm run build
```

Then shoot `/capture` and `/notifications` at all three widths and look at them.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/capture.tsx client/src/pages/notifications.tsx
git commit -m "feat(client): skip the barcode step on a confident match, surface the worklist in Alerts"
```

---

## Task 8: Ship it

- [ ] **Step 1: Full gates**

```bash
cd server && npm test && npm run lint
cd ../client && npx tsc --noEmit && npm run build
```

Expected: all green.

- [ ] **Step 2: Apply migration 008 to production BEFORE merging**

From a host on the management VLAN (10.0.5.0/24):

```bash
curl -X POST http://10.0.5.42:8500/api/_y_/apps/tally/envs/prod/db/migrate-all \
  -H "Authorization: Bearer $ORCHESTRATOR_API_KEY" \
  -H 'Content-Type: application/json' -d '{"ref":"feat/photo-product-match"}'
```

**Do not merge until this returns success.** Deploy does not run migrations; merging first ships code whose table does not exist, which is exactly the 14h17m outage of 2026-08-15.

- [ ] **Step 3: Open the PR**

Body must state: migration 008 applied first (with the timestamp), the three new routes, the gate, and that `MATCH_ENABLED=false` disables the feature without a deploy.

- [ ] **Step 4: Merge on green, then verify the deploy**

```bash
curl -s https://tally.razorwire-productions.com | grep -oE 'index-[A-Za-z0-9._-]+\.js'
```

Compare against the local `client/dist/assets/index-*.js`.

---

## Self-Review

**Spec coverage:** §5 → Task 1. §6 + §8.1 → Task 2. §4 gate → Task 7 (client) with the brand half enforced in Task 5's schema. §7 runner + sweep → Task 3. §8 caps → Tasks 2, 3, 5. §9 failure states → Task 3 (`none`/`failed` writes), Task 4 (listed), Task 6 (rendered). §10 resolve → Task 4. §11 routes → Task 5. §12 client → Tasks 6–7. §13 tests → Tasks 2–4 server, 6–7 client. §14 omissions respected: no extractor, no cache, no retailer link, no auto-apply.

**Placeholders:** none. Every code step carries real code. The one conditional instruction (Task 5 Step 4, `validate`'s signature) names the file to read and both branches.

**Type consistency:** `Candidate` fields in Task 2 match `MatchCandidate` in Task 6 (`name, brand, model, upc, priceUsd, imageUrl, sourceUrl, sourceDomain`). `Match` from `list` in Task 4 matches `ProductMatch` in Task 6. `resolve`'s `{candidateIndex, dismiss}` matches the Joi `xor` in Task 5 and the mutation in Task 6.

**Verified against the codebase while reviewing:** `validate(schema, source)`
does take a source argument (Task 5 relies on it); `success`/`error` take `res`
first and send the response themselves (Task 5's handlers were corrected to
match — the earlier `res.json(success(out))` form would have serialised the
Response object); and `propertyId` comes from `useProperties()?.[0]?.id`, the
pattern `print-queue.tsx` uses, not an invented `usePropertyId()` hook.

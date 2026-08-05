# Auto-Print (Phase 2) — tally-side Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the tally half of the auto-print pipeline — a property-scoped print-job queue, a hashed-token agent API with an atomic self-healing claim, roll-state hold/release, printer telemetry, and the client UX to drive it.

**Architecture:** A new `print` module (routes/service/schema + its own agent-auth middleware) alongside the existing `labels` module. Jobs store *parameters*, not bytes: the PDF is rendered on demand at fetch time by reusing Phase 1's `LabelsService` renderers unchanged. The agent authenticates with a Bearer token whose SHA-256 hash is stored, and its entire authority is derived server-side from that token's row.

**Tech Stack:** Express 4 (CommonJS) + mysql2 + Joi; `node:test` + fakeDb for server tests. Client: React 18 + TS + Vite + TanStack Query.

**Spec:** `docs/superpowers/specs/2026-08-04-auto-print-design.md`

**Out of scope for this plan** (deferred until the Cycle 1 hardware bring-up resolves the print backend): the Python agent, the CUPS/`pdf2tspl` backends, and the pi-gen appliance image. Those get their own plan in the `tally-printer` repo.

## Global Constraints

- **PRIVACY INVARIANT:** every query is scoped by `USER_ID` via `property_members` (user endpoints) or by the authenticated agent's `PROPERTY_ID` (agent endpoints). No exceptions.
- **Agent authority is server-derived.** `PROPERTY_ID` and `PRESET` for a claim come from the agent row resolved by the token — **never** from the request body.
- **One vocabulary:** Phase 1's preset names are the identifiers everywhere. `print_jobs.PRESET` and `printer_agents.LOADED_MEDIA` are `small` | `medium` | `large` only — `sheet` exists solely as a Phase 1 label preset and never enters the print queue. Inches never appear server-side.
- **`sheet` is download-only** — `POST /api/print/_y_/jobs` rejects it (it is a Letter-size 30-up laser sheet, meaningless on a 4-inch thermal roll). `LOADED_MEDIA` has no `sheet` value.
- **Token:** `crypto.randomBytes(32).toString('hex')` with a `tp_` prefix, returned in plaintext **exactly once** at creation, stored only as SHA-256. Compared in constant time.
- **Delivery is at-least-once.** Ack is the commit point.
- Migrations contain **no `USE` statement** — the migrate playbook selects the DB with `-D TALLY`.
- Route prefixes: `_x_` GET, `_y_` POST, `_u_` PUT, `_p_` PATCH, `_d_` DELETE. Envelope `{success, data, message}`. DB columns UPPER_SNAKE, API fields camelCase.
- `db.query()` returns rows **directly** (never `[rows]`).
- Server tests: `cd server && node --test test/print.test.js`. Client gates: `cd client && ./node_modules/.bin/tsc --noEmit && npm run build` — **there is no client ESLint in this repo**; audit unused imports by hand.

---

## File Structure

**Server**
- Create `SQL/migrations/003_print_jobs.sql` — the two tables.
- Create `server/src/modules/print/print.schema.js` — Joi for every endpoint.
- Create `server/src/modules/print/agent.middleware.js` — Bearer-token auth; attaches `req.agent`.
- Create `server/src/modules/print/print.service.js` — all SQL + business logic.
- Create `server/src/modules/print/print.routes.js` — thin routes.
- Modify `server/index.js` — register the module + a dedicated agent rate limiter.
- Create `server/test/print.test.js` — fakeDb tests.

**Client**
- Create `client/src/hooks/use-print.ts` — queries/mutations.
- Modify `client/src/components/labels/label-print-dialog.tsx` — "Send to printer".
- Create `client/src/components/print/printer-settings.tsx` — Settings → Printing.
- Modify `client/src/pages/settings.tsx` — mount the section.

**Integration facts already verified (do not re-derive):**
- CSRF middleware **skips validation when there is no session cookie**, so Bearer-token agent requests pass through with no exemption needed. Do not add an `EXEMPT_PATHS` entry.
- `app.set('trust proxy', 1)` is set, so rate limiting keys on the real client IP. The global limiter is **200 req/min**; a 50-label burst is ~150 agent requests, so a dedicated agent limiter is required (Task 6).

---

## Task 1: Migration + Joi schemas

**Files:**
- Create: `SQL/migrations/003_print_jobs.sql`
- Create: `server/src/modules/print/print.schema.js`
- Test: `server/test/print.test.js`

**Interfaces:**
- Produces: tables `printer_agents`, `print_jobs`. Joi objects `createJob`, `setLoadedMedia`, `createAgent`, `agentClaim`, `agentAck` exported from `print.schema.js`.

- [ ] **Step 1: Write the failing tests** — create `server/test/print.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const schema = require('../src/modules/print/print.schema');

// ── schema ──────────────────────────────────────────────────────────────────

test('createJob accepts the three printable presets', () => {
  for (const preset of ['small', 'medium', 'large']) {
    const r = schema.createJob.validate({ entityType: 'container', entityIds: [1], preset });
    assert.equal(r.error, undefined, `${preset} should be accepted`);
  }
});

test('createJob rejects the sheet preset — Avery is download-only', () => {
  const r = schema.createJob.validate({ entityType: 'container', entityIds: [1], preset: 'sheet' });
  assert.ok(r.error, 'sheet must be rejected at queue time');
});

test('createJob requires at least one id and caps at 100', () => {
  assert.ok(schema.createJob.validate({ entityType: 'item', entityIds: [], preset: 'small' }).error);
  const many = Array.from({ length: 101 }, (_, i) => i + 1);
  assert.ok(schema.createJob.validate({ entityType: 'item', entityIds: many, preset: 'small' }).error);
});

test('setLoadedMedia accepts only the three roll sizes (never sheet)', () => {
  for (const media of ['small', 'medium', 'large']) {
    assert.equal(schema.setLoadedMedia.validate({ loadedMedia: media }).error, undefined);
  }
  assert.ok(schema.setLoadedMedia.validate({ loadedMedia: 'sheet' }).error);
});

test('agentClaim tolerates a missing telemetry body and defaults to unknown', () => {
  const r = schema.agentClaim.validate({});
  assert.equal(r.error, undefined, 'a claim with no telemetry must still be valid');
  assert.equal(r.value.printerState, 'unknown');
  assert.deepEqual(r.value.printerStateReasons, []);
});

test('agentClaim rejects an unknown printer state', () => {
  assert.ok(schema.agentClaim.validate({ printerState: 'on fire' }).error);
});

test('agentAck requires ok and carries an optional error string', () => {
  assert.equal(schema.agentAck.validate({ ok: true }).error, undefined);
  assert.equal(schema.agentAck.validate({ ok: false, error: 'media-empty' }).error, undefined);
  assert.ok(schema.agentAck.validate({}).error);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && node --test test/print.test.js`
Expected: FAIL — cannot find module `print.schema`.

- [ ] **Step 3: Write the migration** — create `SQL/migrations/003_print_jobs.sql`:

```sql
-- Phase 2 auto-print: the job queue and the Pi agents that drain it.
--
-- printer_agents: one row per Raspberry Pi. TOKEN_HASH is the SHA-256 of the
-- agent's bearer token — the plaintext is shown once at creation and never
-- stored, because this is a long-lived credential that prints on a user's
-- behalf (unlike share_links, whose 7-day plaintext token is acceptable).
-- LOADED_MEDIA is the roll physically in the printer; tally is the single
-- source of truth for it (the Pi cannot sense roll size and does not store it).
-- It has no 'sheet' value: Avery sheets are Letter-size laser output.
--
-- print_jobs: stores the PARAMETERS of a print, not the rendered bytes — the
-- PDF is rendered on demand at fetch time from the Phase 1 renderers.
--
-- No `USE` statement — the migrate playbook selects the app DB (-D TALLY).

CREATE TABLE IF NOT EXISTS printer_agents (
    ID                    INT          NOT NULL AUTO_INCREMENT,
    PROPERTY_ID           INT          NOT NULL,
    NAME                  VARCHAR(100) NOT NULL,
    TOKEN_HASH            CHAR(64)     NOT NULL,
    LOADED_MEDIA          ENUM('small','medium','large') NOT NULL DEFAULT 'large',
    PRINTER_STATE         ENUM('idle','printing','stopped','unknown') NOT NULL DEFAULT 'unknown',
    PRINTER_STATE_REASONS JSON         NULL,
    LAST_SEEN_AT          DATETIME     NULL,
    CREATED_AT            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (ID),
    UNIQUE KEY uq_printer_agents_token (TOKEN_HASH),
    KEY idx_printer_agents_property (PROPERTY_ID),
    CONSTRAINT fk_printer_agents_property FOREIGN KEY (PROPERTY_ID) REFERENCES properties (ID)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS print_jobs (
    ID          INT NOT NULL AUTO_INCREMENT,
    PROPERTY_ID INT NOT NULL,
    CREATED_BY  INT NOT NULL,
    ENTITY_TYPE ENUM('item','container','area') NOT NULL,
    ENTITY_IDS  JSON NOT NULL,
    PRESET      ENUM('small','medium','large') NOT NULL,
    STATUS      ENUM('queued','held','claimed','done','failed','canceled') NOT NULL DEFAULT 'queued',
    ATTEMPTS    INT NOT NULL DEFAULT 0,
    LAST_ERROR  VARCHAR(500) NULL,
    CLAIM_ID    CHAR(36) NULL,
    CLAIMED_BY  INT NULL,
    CLAIMED_AT  DATETIME NULL,
    PRINTED_AT  DATETIME NULL,
    CREATED_AT  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UPDATED_AT  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (ID),
    -- the claim query seeks on (PROPERTY_ID, STATUS, PRESET) ordered by CREATED_AT
    KEY idx_print_jobs_claim (PROPERTY_ID, STATUS, PRESET, CREATED_AT),
    KEY idx_print_jobs_claim_id (CLAIM_ID),
    CONSTRAINT fk_print_jobs_property FOREIGN KEY (PROPERTY_ID) REFERENCES properties (ID),
    CONSTRAINT fk_print_jobs_user     FOREIGN KEY (CREATED_BY)  REFERENCES users (ID)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- [ ] **Step 4: Write the schemas** — create `server/src/modules/print/print.schema.js`:

```js
const Joi = require('joi');

// The three printable rolls. 'sheet' is deliberately absent: an Avery 5160
// 30-up Letter page is laser output and cannot be printed on a label roll.
const PRINTABLE_PRESETS = ['small', 'medium', 'large'];

const createJob = Joi.object({
  entityType: Joi.string().valid('item', 'container', 'area').required(),
  entityIds: Joi.array().items(Joi.number().integer()).min(1).max(100).required(),
  preset: Joi.string().valid(...PRINTABLE_PRESETS).required().messages({
    'any.only': 'Avery sheets are for a laser printer — use Download PDF instead',
  }),
});

const setLoadedMedia = Joi.object({
  loadedMedia: Joi.string().valid(...PRINTABLE_PRESETS).required(),
});

const createAgent = Joi.object({
  propertyId: Joi.number().integer().required(),
  name: Joi.string().trim().min(1).max(100).required(),
});

// Telemetry rides the claim request. A malformed or absent payload must never
// break the claim — it degrades to 'unknown' rather than erroring.
const agentClaim = Joi.object({
  printerState: Joi.string().valid('idle', 'printing', 'stopped', 'unknown').default('unknown'),
  printerStateReasons: Joi.array().items(Joi.string().max(64)).max(10).default([]),
});

const agentAck = Joi.object({
  ok: Joi.boolean().required(),
  error: Joi.string().max(500).allow('').optional(),
});

module.exports = { createJob, setLoadedMedia, createAgent, agentClaim, agentAck, PRINTABLE_PRESETS };
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd server && node --test test/print.test.js`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add SQL/migrations/003_print_jobs.sql server/src/modules/print/print.schema.js server/test/print.test.js
git commit -m "feat(print): migration 003 + Joi schemas for the print queue"
```

---

## Task 2: Agent token auth middleware

**Files:**
- Create: `server/src/modules/print/agent.middleware.js`
- Test: `server/test/print.test.js` (append)

**Interfaces:**
- Produces:
  - `hashToken(plaintext) => string` — SHA-256 hex.
  - `generateToken() => string` — `tp_` + 64 hex chars.
  - `requireAgent(deps) => middleware` — reads `Authorization: Bearer <token>`, looks the agent up by hash, attaches `req.agent = { id, propertyId, loadedMedia, name }`, else 401.

- [ ] **Step 1: Write the failing tests** — append to `server/test/print.test.js`:

```js
const crypto = require('crypto');
const { hashToken, generateToken, requireAgent } = require('../src/modules/print/agent.middleware');

function fakeRes() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

test('generateToken is prefixed and hashToken is a stable sha256', () => {
  const t = generateToken();
  assert.match(t, /^tp_[0-9a-f]{64}$/);
  assert.equal(hashToken(t), crypto.createHash('sha256').update(t).digest('hex'));
  assert.equal(hashToken(t), hashToken(t), 'hashing is deterministic');
  assert.notEqual(hashToken(t), t, 'the plaintext is never the stored value');
});

test('requireAgent looks the agent up BY HASH, never by plaintext', async () => {
  const token = generateToken();
  let boundParam = null;
  const db = { query: async (sql, params) => {
    boundParam = params[0];
    return [{ ID: 7, PROPERTY_ID: 3, LOADED_MEDIA: 'large', NAME: 'Garage Pi' }];
  } };
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = fakeRes();
  let nexted = false;
  await requireAgent({ db })(req, res, () => { nexted = true; });

  assert.ok(nexted, 'a valid token calls next()');
  assert.equal(boundParam, hashToken(token), 'the query binds the HASH');
  assert.notEqual(boundParam, token, 'the plaintext token is never sent to the db');
  assert.deepEqual(req.agent, { id: 7, propertyId: 3, loadedMedia: 'large', name: 'Garage Pi' });
});

test('requireAgent rejects a missing, malformed, or unknown token with 401', async () => {
  const db = { query: async () => [] }; // no agent matches
  const mw = requireAgent({ db });

  for (const headers of [{}, { authorization: 'Bearer' }, { authorization: 'Basic abc' }]) {
    const res = fakeRes();
    let nexted = false;
    await mw({ headers }, res, () => { nexted = true; });
    assert.equal(nexted, false, 'malformed auth must not call next()');
    assert.equal(res.statusCode, 401);
  }

  const res = fakeRes();
  let nexted = false;
  await mw({ headers: { authorization: `Bearer ${generateToken()}` } }, res, () => { nexted = true; });
  assert.equal(nexted, false, 'an unknown token must not call next()');
  assert.equal(res.statusCode, 401);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && node --test test/print.test.js`
Expected: FAIL — cannot find module `agent.middleware`.

- [ ] **Step 3: Implement** — create `server/src/modules/print/agent.middleware.js`:

```js
const crypto = require('crypto');
const { error } = require('../../utils/response');

/**
 * Bearer-token auth for the Pi print agent.
 *
 * The agent is not a browser: no session cookie, no CSRF. (The global CSRF
 * middleware already skips requests without a session cookie, and bearer auth
 * is CSRF-immune by construction, so no exemption is needed.)
 *
 * Only the SHA-256 hash of a token is stored, so a database leak does not hand
 * an attacker a working printing credential. Lookup is BY HASH — the plaintext
 * never reaches a query.
 */

function hashToken(plaintext) {
  return crypto.createHash('sha256').update(String(plaintext)).digest('hex');
}

function generateToken() {
  return `tp_${crypto.randomBytes(32).toString('hex')}`;
}

function requireAgent({ db }) {
  return async (req, res, next) => {
    const header = req.headers?.authorization || '';
    const match = /^Bearer\s+(\S+)$/.exec(header);
    if (!match) return error(res, 'Agent authentication required', 401);

    // A unique index on TOKEN_HASH makes this an equality seek. Comparing the
    // hash (not the token) in SQL is itself the constant-time-safe path: the
    // hash is a fixed-length digest and reveals nothing about the plaintext.
    const rows = await db.query(
      `SELECT ID, PROPERTY_ID, LOADED_MEDIA, NAME
         FROM TALLY.printer_agents
        WHERE TOKEN_HASH = ?`,
      [hashToken(match[1])]
    );
    if (rows.length === 0) return error(res, 'Invalid agent token', 401);

    req.agent = {
      id: rows[0].ID,
      propertyId: rows[0].PROPERTY_ID,
      loadedMedia: rows[0].LOADED_MEDIA,
      name: rows[0].NAME,
    };
    next();
  };
}

module.exports = { hashToken, generateToken, requireAgent };
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && node --test test/print.test.js`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/print/agent.middleware.js server/test/print.test.js
git commit -m "feat(print): hashed bearer-token auth middleware for the Pi agent"
```

---

## Task 3: Service — user-side job operations

**Files:**
- Create: `server/src/modules/print/print.service.js`
- Test: `server/test/print.test.js` (append)

**Interfaces:**
- Consumes: `hashToken`/`generateToken` (Task 2).
- Produces, on `PrintService`:
  - `init({ db, logger, config })`
  - `resolveProperty(entityType, entityIds, userId)` → `{ propertyId }` | `{ error: 'not_found' | 'mixed' }` — membership-scoped.
  - `createJob({ entityType, entityIds, preset, userId })` → `{ id, status }` | `{ error }`. Status is `queued` when the property's agent has `LOADED_MEDIA === preset`, else `held`. With **no agent registered**, jobs are created `queued` (they wait for an agent to appear).
  - `listJobs(propertyId, userId, limit)` → job rows (camelCase), newest first.
  - `cancelJob(id, userId)` / `retryJob(id, userId)` → `true` | `false`.

- [ ] **Step 1: Write the failing tests** — append to `server/test/print.test.js`:

```js
const PrintService = require('../src/modules/print/print.service');
function fakeDb(handler) { return { query: async (sql, params) => handler(sql, params) }; }
const logger = { warn() {}, info() {}, error() {} };
const config = { clientUrl: 'https://tally.example' };

test('resolveProperty is membership-scoped and binds userId first', async () => {
  let sql = '', params = null;
  PrintService.init({ db: fakeDb((s, p) => { sql = s; params = p; return [{ PROPERTY_ID: 3 }]; }), logger, config });
  const out = await PrintService.resolveProperty('container', [5, 6], 42);
  assert.deepEqual(out, { propertyId: 3 });
  assert.match(sql, /property_members/i, 'must join property_members');
  assert.match(sql, /pm\.USER_ID = \?/i);
  assert.equal(params[0], 42, 'userId is bound first');
  assert.deepEqual(params.slice(1), [5, 6], 'entity ids follow');
});

test('resolveProperty refuses entities the caller cannot see, and mixed properties', async () => {
  PrintService.init({ db: fakeDb(() => []), logger, config });
  assert.deepEqual(await PrintService.resolveProperty('item', [999], 42), { error: 'not_found' });

  PrintService.init({ db: fakeDb(() => [{ PROPERTY_ID: 3 }, { PROPERTY_ID: 4 }]), logger, config });
  assert.deepEqual(await PrintService.resolveProperty('item', [1, 2], 42), { error: 'mixed' });
});

test('createJob queues when the loaded roll matches and holds when it does not', async () => {
  const mk = (loaded) => fakeDb((sql) => {
    if (/property_members/i.test(sql) && /SELECT DISTINCT/i.test(sql)) return [{ PROPERTY_ID: 3 }];
    if (/FROM TALLY\.printer_agents/i.test(sql)) return [{ LOADED_MEDIA: loaded }];
    if (/INSERT INTO TALLY\.print_jobs/i.test(sql)) return { insertId: 11 };
    return [];
  });

  PrintService.init({ db: mk('large'), logger, config });
  assert.deepEqual(
    await PrintService.createJob({ entityType: 'container', entityIds: [5], preset: 'large', userId: 42 }),
    { id: 11, status: 'queued' });

  PrintService.init({ db: mk('large'), logger, config });
  assert.deepEqual(
    await PrintService.createJob({ entityType: 'container', entityIds: [5], preset: 'medium', userId: 42 }),
    { id: 11, status: 'held' }, 'a 3x3 job while 4x6 is loaded must be held');
});

test('createJob queues normally when no agent is registered yet', async () => {
  PrintService.init({ db: fakeDb((sql) => {
    if (/SELECT DISTINCT/i.test(sql)) return [{ PROPERTY_ID: 3 }];
    if (/FROM TALLY\.printer_agents/i.test(sql)) return [];      // no agent
    if (/INSERT INTO TALLY\.print_jobs/i.test(sql)) return { insertId: 12 };
    return [];
  }), logger, config });
  const out = await PrintService.createJob({ entityType: 'item', entityIds: [1], preset: 'small', userId: 42 });
  assert.equal(out.status, 'queued', 'without an agent a job waits as queued, not held');
});

test('createJob propagates the not_found error instead of inserting', async () => {
  let inserted = false;
  PrintService.init({ db: fakeDb((sql) => {
    if (/INSERT/i.test(sql)) { inserted = true; return { insertId: 1 }; }
    return [];
  }), logger, config });
  const out = await PrintService.createJob({ entityType: 'item', entityIds: [999], preset: 'small', userId: 42 });
  assert.deepEqual(out, { error: 'not_found' });
  assert.equal(inserted, false, 'an unauthorized entity must never create a job');
});

test('listJobs, cancelJob and retryJob are all membership-scoped', async () => {
  for (const call of [
    (s) => s.listJobs(3, 42, 50),
    (s) => s.cancelJob(11, 42),
    (s) => s.retryJob(11, 42),
  ]) {
    let sql = '', params = null;
    PrintService.init({ db: fakeDb((s2, p) => { sql = s2; params = p; return []; }), logger, config });
    await call(PrintService);
    assert.match(sql, /property_members/i, `query must join property_members: ${sql.slice(0, 60)}`);
    assert.ok(params.includes(42), 'userId must be bound');
  }
});

test('retryJob only revives a failed job and resets its attempts', async () => {
  let sql = '';
  PrintService.init({ db: fakeDb((s) => { sql = s; return { affectedRows: 1 }; }), logger, config });
  assert.equal(await PrintService.retryJob(11, 42), true);
  assert.match(sql, /STATUS\s*=\s*'queued'/i);
  assert.match(sql, /ATTEMPTS\s*=\s*0/i, 'retry resets the attempt counter');
  assert.match(sql, /STATUS\s*=\s*'failed'/i, 'only a failed job may be retried');
});

test('cancelJob refuses to cancel a job already in a terminal state', async () => {
  let sql = '';
  PrintService.init({ db: fakeDb((s) => { sql = s; return { affectedRows: 0 }; }), logger, config });
  assert.equal(await PrintService.cancelJob(11, 42), false);
  assert.match(sql, /STATUS\s+IN\s*\(/i, 'the update is guarded by a non-terminal status set');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && node --test test/print.test.js`
Expected: FAIL — cannot find module `print.service`.

- [ ] **Step 3: Implement** — create `server/src/modules/print/print.service.js`:

```js
const crypto = require('crypto');   // used by claimNext's randomUUID in Task 4

let _db = null;
let _logger = null;

// Membership-scoped property resolution per entity type. Every branch INNER
// JOINs property_members, so an entity the caller cannot see simply yields no
// row — the caller then 404s and never learns whether the id exists.
const PROPERTY_SQL = {
  item: `SELECT i.ID AS ENTITY_ID, a.PROPERTY_ID
           FROM TALLY.items i
           JOIN TALLY.containers c ON i.CONTAINER_ID = c.ID
           JOIN TALLY.areas a ON c.AREA_ID = a.ID
           JOIN TALLY.property_members pm ON pm.PROPERTY_ID = a.PROPERTY_ID AND pm.USER_ID = ?
          WHERE i.ID IN (:ids) AND i.DELETED_AT IS NULL`,
  container: `SELECT c.ID AS ENTITY_ID, a.PROPERTY_ID
           FROM TALLY.containers c
           JOIN TALLY.areas a ON c.AREA_ID = a.ID
           JOIN TALLY.property_members pm ON pm.PROPERTY_ID = a.PROPERTY_ID AND pm.USER_ID = ?
          WHERE c.ID IN (:ids) AND c.DELETED_AT IS NULL`,
  area: `SELECT a.ID AS ENTITY_ID, a.PROPERTY_ID
           FROM TALLY.areas a
           JOIN TALLY.property_members pm ON pm.PROPERTY_ID = a.PROPERTY_ID AND pm.USER_ID = ?
          WHERE a.ID IN (:ids) AND a.DELETED_AT IS NULL`,
};

const PrintService = {
  init({ db, logger }) {
    _db = db;
    _logger = logger;
  },

  _mapJob(row) {
    return {
      id: row.ID,
      propertyId: row.PROPERTY_ID,
      createdBy: row.CREATED_BY,
      entityType: row.ENTITY_TYPE,
      entityIds: typeof row.ENTITY_IDS === 'string' ? JSON.parse(row.ENTITY_IDS) : row.ENTITY_IDS,
      preset: row.PRESET,
      status: row.STATUS,
      attempts: row.ATTEMPTS,
      lastError: row.LAST_ERROR,
      printedAt: row.PRINTED_AT,
      createdAt: row.CREATED_AT,
    };
  },

  // ── User-side ─────────────────────────────────────────────────────────────

  async resolveProperty(entityType, entityIds, userId) {
    const template = PROPERTY_SQL[entityType];
    if (!template) return { error: 'not_found' };

    // Dedupe first so a caller passing e.g. [5,5] isn't penalized by the
    // "every id resolved" check below — it's still one entity, not two.
    const uniqueIds = [...new Set(entityIds)];
    // Guard before building SQL: an empty array would otherwise produce an
    // invalid `IN ()` clause. Joi guards the route, but this method is
    // exported and called directly elsewhere.
    if (uniqueIds.length === 0) return { error: 'not_found' };

    const sql = template.replace(':ids', uniqueIds.map(() => '?').join(', '));
    const rows = await _db.query(sql, [userId, ...uniqueIds]);

    // Every requested id must resolve. Checking only that the *matched* rows
    // share one property would silently accept a partially-visible batch —
    // the user asks for 2 labels, one id is foreign, and they get 1 with no
    // error. It would also leave correctness resting on the downstream
    // render re-scoping, which is fragile.
    const resolvedIds = new Set(rows.map(r => r.ENTITY_ID));
    if (resolvedIds.size !== uniqueIds.length) return { error: 'not_found' };

    const propertyIds = new Set(rows.map(r => r.PROPERTY_ID));
    if (propertyIds.size > 1) return { error: 'mixed' };
    return { propertyId: rows[0].PROPERTY_ID };
  },

  async createJob({ entityType, entityIds, preset, userId }) {
    const resolved = await PrintService.resolveProperty(entityType, entityIds, userId);
    if (resolved.error) return { error: resolved.error };
    const { propertyId } = resolved;

    // Hold the job when a roll is loaded that does not match. With no agent
    // registered yet the job simply waits as `queued`.
    const agents = await _db.query(
      // ORDER BY ID: the UI assumes one printer per property, but there is no
      // uniqueness constraint — this keeps the choice stable if a second is added.
      'SELECT LOADED_MEDIA FROM TALLY.printer_agents WHERE PROPERTY_ID = ? ORDER BY ID LIMIT 1',
      [propertyId]
    );
    const status = agents.length > 0 && agents[0].LOADED_MEDIA !== preset ? 'held' : 'queued';

    const result = await _db.query(
      `INSERT INTO TALLY.print_jobs (PROPERTY_ID, CREATED_BY, ENTITY_TYPE, ENTITY_IDS, PRESET, STATUS)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [propertyId, userId, entityType, JSON.stringify(entityIds), preset, status]
    );
    return { id: result.insertId, status };
  },

  async listJobs(propertyId, userId, limit = 50) {
    const rows = await _db.query(
      `SELECT j.* FROM TALLY.print_jobs j
         JOIN TALLY.property_members pm ON pm.PROPERTY_ID = j.PROPERTY_ID AND pm.USER_ID = ?
        WHERE j.PROPERTY_ID = ?
        ORDER BY j.CREATED_AT DESC
        LIMIT ?`,
      [userId, propertyId, limit]
    );
    return rows.map(PrintService._mapJob);
  },

  async cancelJob(id, userId) {
    const result = await _db.query(
      `UPDATE TALLY.print_jobs j
         JOIN TALLY.property_members pm ON pm.PROPERTY_ID = j.PROPERTY_ID AND pm.USER_ID = ?
          SET j.STATUS = 'canceled'
        WHERE j.ID = ? AND j.STATUS IN ('queued', 'held', 'claimed')`,
      [userId, id]
    );
    return result.affectedRows > 0;
  },

  async retryJob(id, userId) {
    const result = await _db.query(
      `UPDATE TALLY.print_jobs j
         JOIN TALLY.property_members pm ON pm.PROPERTY_ID = j.PROPERTY_ID AND pm.USER_ID = ?
          SET j.STATUS = 'queued', j.ATTEMPTS = 0, j.LAST_ERROR = NULL,
              j.CLAIM_ID = NULL, j.CLAIMED_BY = NULL, j.CLAIMED_AT = NULL
        WHERE j.ID = ? AND j.STATUS = 'failed'`,
      [userId, id]
    );
    return result.affectedRows > 0;
  },
};

module.exports = PrintService;
```

> `crypto` is imported here but first used in Task 4 (`crypto.randomUUID()` for the claim id). That is intentional — do not remove it.

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && node --test test/print.test.js`
Expected: PASS (18 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/print/print.service.js server/test/print.test.js
git commit -m "feat(print): user-side job operations with membership-scoped property resolution"
```

---

## Task 4: Service — agent-side claim, render, ack

**Files:**
- Modify: `server/src/modules/print/print.service.js`
- Test: `server/test/print.test.js` (append)

**Interfaces:**
- Consumes: `PrintService._mapJob` (Task 3); Phase 1's `LabelsService.getEntityData(type, ids, userId)`, `LabelsService.getManifest(entityType, id, userId)`, `LabelsService.renderLabelPdf(entities, preset)`, `LabelsService.renderManifestBundle(manifests, preset)`.
- Produces:
  - `sweepStaleClaims(propertyId)` → number requeued. Claims older than `STALE_CLAIM_MINUTES` (5) go back to `queued` with `ATTEMPTS + 1`.
  - `claimNext(agent, telemetry)` → job | `null`. Updates `LAST_SEEN_AT`/`PRINTER_STATE`/`PRINTER_STATE_REASONS`, sweeps, then claims atomically.
  - `renderJobPdf(job)` → `Buffer`. Renders as the job's `CREATED_BY` user, so Phase 1's membership scoping still applies.
  - `getClaimedJob(jobId, agentId)` → job | `null` — the job must be currently claimed *by this agent*.
  - `ackJob(jobId, agentId, ok, errorText)` → `'done' | 'queued' | 'failed' | null`.

- [ ] **Step 1: Write the failing tests** — append to `server/test/print.test.js`:

```js
test('claimNext persists telemetry and derives property/preset from the AGENT, not the request', async () => {
  const seen = [];
  PrintService.init({ db: fakeDb((sql, params) => {
    seen.push({ sql, params });
    if (/UPDATE TALLY\.printer_agents/i.test(sql)) return { affectedRows: 1 };
    if (/SET STATUS\s*=\s*'queued'/i.test(sql)) return { affectedRows: 0 };   // stale sweep
    if (/SET STATUS\s*=\s*'claimed'/i.test(sql)) return { affectedRows: 1 };  // claim
    if (/SELECT .* FROM TALLY\.print_jobs/i.test(sql)) {
      return [{ ID: 11, PROPERTY_ID: 3, CREATED_BY: 42, ENTITY_TYPE: 'container',
                ENTITY_IDS: '[5]', PRESET: 'large', STATUS: 'claimed', ATTEMPTS: 0 }];
    }
    return [];
  }), logger, config });

  const agent = { id: 7, propertyId: 3, loadedMedia: 'large' };
  const job = await PrintService.claimNext(agent, { printerState: 'idle', printerStateReasons: ['media-empty'] });

  assert.equal(job.id, 11);
  const telem = seen.find(s => /UPDATE TALLY\.printer_agents/i.test(s.sql));
  assert.ok(telem, 'telemetry must be written on every claim');
  assert.ok(telem.params.includes('idle'), 'printerState persisted');
  assert.match(telem.sql, /LAST_SEEN_AT/i, 'liveness is refreshed on the claim');

  const claim = seen.find(s => /SET STATUS\s*=\s*'claimed'/i.test(s.sql));
  assert.ok(claim.params.includes(3), 'propertyId comes from the agent row');
  assert.ok(claim.params.includes('large'), 'preset comes from the agent LOADED_MEDIA');
  assert.match(claim.sql, /STATUS\s*=\s*'queued'/i, 'only queued jobs are claimable');
  assert.match(claim.sql, /LIMIT 1/i);
});

test('claimNext returns null when nothing is claimable', async () => {
  PrintService.init({ db: fakeDb((sql) => {
    if (/UPDATE/i.test(sql)) return { affectedRows: 0 };
    return [];
  }), logger, config });
  assert.equal(await PrintService.claimNext({ id: 7, propertyId: 3, loadedMedia: 'small' }, {}), null);
});

test('sweepStaleClaims requeues abandoned claims and increments attempts', async () => {
  let sql = '';
  PrintService.init({ db: fakeDb((s) => { sql = s; return { affectedRows: 2 }; }), logger, config });
  assert.equal(await PrintService.sweepStaleClaims(3), 2);
  assert.match(sql, /STATUS\s*=\s*'claimed'/i, 'only claimed rows are swept');
  assert.match(sql, /ATTEMPTS\s*=\s*ATTEMPTS\s*\+\s*1/i);
  assert.match(sql, /CLAIMED_AT\s*<\s*DATE_SUB/i, 'swept by claim age');
});

test('getClaimedJob refuses a job this agent does not currently hold', async () => {
  let params = null;
  PrintService.init({ db: fakeDb((sql, p) => { params = p; return []; }), logger, config });
  assert.equal(await PrintService.getClaimedJob(11, 7), null);
  assert.deepEqual(params, [11, 7], 'both the job id AND the agent id are bound');
});

test('ackJob(ok) marks done; ack(fail) requeues until the attempt cap then fails', async () => {
  // ok -> done
  let sql = '';
  PrintService.init({ db: fakeDb((s) => { sql = s; return { affectedRows: 1 }; }), logger, config });
  assert.equal(await PrintService.ackJob(11, 7, true, null), 'done');
  assert.match(sql, /STATUS\s*=\s*'done'/i);
  assert.match(sql, /PRINTED_AT/i);

  // fail below the cap -> queued
  PrintService.init({ db: fakeDb((s) => {
    if (/SELECT/i.test(s)) return [{ ATTEMPTS: 1 }];
    return { affectedRows: 1 };
  }), logger, config });
  assert.equal(await PrintService.ackJob(11, 7, false, 'media-empty'), 'queued');

  // fail at the cap -> failed
  PrintService.init({ db: fakeDb((s) => {
    if (/SELECT/i.test(s)) return [{ ATTEMPTS: 2 }];   // this ack makes 3
    return { affectedRows: 1 };
  }), logger, config });
  assert.equal(await PrintService.ackJob(11, 7, false, 'media-empty'), 'failed');
});

test('renderJobPdf renders as the queuing user so Phase 1 scoping still applies', async () => {
  const Labels = require('../src/modules/labels/labels.service');
  const calls = [];
  const origGet = Labels.getEntityData;
  const origRender = Labels.renderLabelPdf;
  Labels.getEntityData = async (type, ids, userId) => { calls.push({ type, ids, userId }); return [{ name: 'x', qrCode: 'TLY-C-1' }]; };
  Labels.renderLabelPdf = async () => Buffer.from('%PDF-fake');
  try {
    PrintService.init({ db: fakeDb(() => []), logger, config });
    const buf = await PrintService.renderJobPdf({ id: 11, createdBy: 42, entityType: 'container', entityIds: [5], preset: 'medium' });
    assert.ok(Buffer.isBuffer(buf));
    assert.deepEqual(calls[0], { type: 'container', ids: [5], userId: 42 },
      'the job is rendered as its CREATED_BY user, never unscoped');
  } finally {
    Labels.getEntityData = origGet;
    Labels.renderLabelPdf = origRender;
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && node --test test/print.test.js`
Expected: FAIL — `PrintService.claimNext is not a function`.

- [ ] **Step 3: Implement** — add to `print.service.js`. Put `const LabelsService = require('../labels/labels.service');` at the top with the other requires, add `const STALE_CLAIM_MINUTES = 5;` and `const MAX_ATTEMPTS = 3;` next to the other constants, then add these methods to the `PrintService` object:

```js
  // ── Agent-side ────────────────────────────────────────────────────────────

  async sweepStaleClaims(propertyId) {
    // An agent that dies mid-job would otherwise strand its row in `claimed`
    // forever. Lazy sweep on each claim — no cron, no scheduler.
    const result = await _db.query(
      `UPDATE TALLY.print_jobs
          SET STATUS = 'queued', ATTEMPTS = ATTEMPTS + 1,
              CLAIM_ID = NULL, CLAIMED_BY = NULL, CLAIMED_AT = NULL
        WHERE PROPERTY_ID = ? AND STATUS = 'claimed'
          AND CLAIMED_AT < DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
      [propertyId, STALE_CLAIM_MINUTES]
    );
    return result.affectedRows;
  },

  async claimNext(agent, telemetry = {}) {
    // Telemetry rides the claim: liveness + printer state in one write.
    await _db.query(
      `UPDATE TALLY.printer_agents
          SET LAST_SEEN_AT = NOW(), PRINTER_STATE = ?, PRINTER_STATE_REASONS = ?
        WHERE ID = ?`,
      [telemetry.printerState || 'unknown',
       JSON.stringify(telemetry.printerStateReasons || []),
       agent.id]
    );

    await PrintService.sweepStaleClaims(agent.propertyId);

    // PROPERTY_ID and PRESET come from the agent row — never from the request,
    // so an agent cannot reach another property or pull a roll it hasn't loaded.
    const claimId = crypto.randomUUID();
    const claimed = await _db.query(
      `UPDATE TALLY.print_jobs
          SET STATUS = 'claimed', CLAIM_ID = ?, CLAIMED_BY = ?, CLAIMED_AT = NOW()
        WHERE PROPERTY_ID = ? AND STATUS = 'queued' AND PRESET = ?
        ORDER BY CREATED_AT
        LIMIT 1`,
      [claimId, agent.id, agent.propertyId, agent.loadedMedia]
    );
    if (claimed.affectedRows === 0) return null;

    const rows = await _db.query(
      'SELECT * FROM TALLY.print_jobs WHERE CLAIM_ID = ?', [claimId]
    );
    return rows.length > 0 ? PrintService._mapJob(rows[0]) : null;
  },

  async getClaimedJob(jobId, agentId) {
    const rows = await _db.query(
      `SELECT * FROM TALLY.print_jobs
        WHERE ID = ? AND CLAIMED_BY = ? AND STATUS = 'claimed'`,
      [jobId, agentId]
    );
    return rows.length > 0 ? PrintService._mapJob(rows[0]) : null;
  },

  async renderJobPdf(job) {
    // Rendered AS THE QUEUING USER: Phase 1's renderers are membership-scoped,
    // so this inherits that scoping instead of inventing an unscoped path. If
    // the user has since lost access the render yields nothing and the job fails.
    if (job.preset === 'large') {
      const manifests = [];
      for (const id of job.entityIds) {
        const m = await LabelsService.getManifest(job.entityType, id, job.createdBy);
        if (m) manifests.push(m);
      }
      if (manifests.length === 0) return null;
      return LabelsService.renderManifestBundle(manifests, 'large');
    }

    const entities = await LabelsService.getEntityData(job.entityType, job.entityIds, job.createdBy);
    if (entities.length === 0) return null;
    return LabelsService.renderLabelPdf(entities, job.preset);
  },

  async ackJob(jobId, agentId, ok, errorText) {
    if (ok) {
      const result = await _db.query(
        `UPDATE TALLY.print_jobs
            SET STATUS = 'done', PRINTED_AT = NOW(), LAST_ERROR = NULL
          WHERE ID = ? AND CLAIMED_BY = ? AND STATUS = 'claimed'`,
        [jobId, agentId]
      );
      return result.affectedRows > 0 ? 'done' : null;
    }

    const rows = await _db.query(
      `SELECT ATTEMPTS FROM TALLY.print_jobs
        WHERE ID = ? AND CLAIMED_BY = ? AND STATUS = 'claimed'`,
      [jobId, agentId]
    );
    if (rows.length === 0) return null;

    const nextAttempts = rows[0].ATTEMPTS + 1;
    const nextStatus = nextAttempts >= MAX_ATTEMPTS ? 'failed' : 'queued';
    // Re-assert STATUS = 'claimed' here, not just in the SELECT above: a
    // concurrent claimNext() can sweep this very claim as stale in between,
    // which already requeues the row and clears CLAIMED_BY. Without this guard
    // the UPDATE silently matches nothing while we return a status the row
    // never took. Report null instead so the caller knows the ack didn't land.
    const written = await _db.query(
      `UPDATE TALLY.print_jobs
          SET STATUS = ?, ATTEMPTS = ?, LAST_ERROR = ?,
              CLAIM_ID = NULL, CLAIMED_BY = NULL, CLAIMED_AT = NULL
        WHERE ID = ? AND CLAIMED_BY = ? AND STATUS = 'claimed'`,
      [nextStatus, nextAttempts, errorText || null, jobId, agentId]
    );
    return written.affectedRows > 0 ? nextStatus : null;
  },
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && node --test test/print.test.js`
Expected: PASS (24 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/print/print.service.js server/test/print.test.js
git commit -m "feat(print): atomic claim, stale-claim sweep, telemetry and on-demand render"
```

---

## Task 5: Service — agent registration & roll release

**Files:**
- Modify: `server/src/modules/print/print.service.js`
- Test: `server/test/print.test.js` (append)

**Interfaces:**
- Consumes: `generateToken`/`hashToken` (Task 2).
- Produces:
  - `createAgent({ propertyId, name, userId })` → `{ id, name, token }` (plaintext token, **returned once**) | `{ error: 'not_found' }`
  - `listAgents(propertyId, userId)` → agents without any token field
  - `revokeAgent(id, userId)` → boolean
  - `setLoadedMedia(agentId, loadedMedia, userId)` → `{ released: n }` | `null` — flips matching `held` jobs to `queued`.

- [ ] **Step 1: Write the failing tests** — append to `server/test/print.test.js`:

```js
test('createAgent stores only a hash and returns the plaintext token once', async () => {
  let insertParams = null;
  PrintService.init({ db: fakeDb((sql, params) => {
    if (/FROM TALLY\.property_members/i.test(sql)) return [{ PROPERTY_ID: 3 }];
    if (/INSERT INTO TALLY\.printer_agents/i.test(sql)) { insertParams = params; return { insertId: 7 }; }
    return [];
  }), logger, config });

  const out = await PrintService.createAgent({ propertyId: 3, name: 'Garage Pi', userId: 42 });
  assert.equal(out.id, 7);
  assert.match(out.token, /^tp_[0-9a-f]{64}$/, 'plaintext is returned to the caller');
  assert.ok(insertParams.includes(hashToken(out.token)), 'the HASH is what gets stored');
  assert.ok(!insertParams.includes(out.token), 'the plaintext must never be stored');
});

test('createAgent refuses a property the caller is not a member of', async () => {
  let inserted = false;
  PrintService.init({ db: fakeDb((sql) => {
    if (/INSERT/i.test(sql)) { inserted = true; return { insertId: 1 }; }
    return [];   // membership check finds nothing
  }), logger, config });
  assert.deepEqual(await PrintService.createAgent({ propertyId: 999, name: 'x', userId: 42 }), { error: 'not_found' });
  assert.equal(inserted, false);
});

test('listAgents never returns a token or its hash', async () => {
  PrintService.init({ db: fakeDb(() => [{
    ID: 7, PROPERTY_ID: 3, NAME: 'Garage Pi', TOKEN_HASH: 'deadbeef',
    LOADED_MEDIA: 'large', PRINTER_STATE: 'idle', PRINTER_STATE_REASONS: '[]', LAST_SEEN_AT: null,
  }]), logger, config });
  const [agent] = await PrintService.listAgents(3, 42);
  assert.equal(agent.name, 'Garage Pi');
  assert.equal(agent.token, undefined);
  assert.equal(agent.tokenHash, undefined);
  assert.ok(!JSON.stringify(agent).includes('deadbeef'), 'no hash may leak to the client');
});

test('setLoadedMedia releases exactly the held jobs matching the new roll', async () => {
  const seen = [];
  PrintService.init({ db: fakeDb((sql, params) => {
    seen.push({ sql, params });
    if (/UPDATE TALLY\.printer_agents/i.test(sql)) return { affectedRows: 1 };
    return { affectedRows: 4 };
  }), logger, config });

  const out = await PrintService.setLoadedMedia(7, 'medium', 42);
  assert.deepEqual(out, { released: 4 });

  const release = seen.find(s => /STATUS\s*=\s*'queued'/i.test(s.sql));
  assert.match(release.sql, /STATUS\s*=\s*'held'/i, 'only held jobs are released');
  assert.ok(release.params.includes('medium'), 'released only for the newly loaded roll');
});

test('setLoadedMedia is membership-scoped and returns null for a foreign agent', async () => {
  PrintService.init({ db: fakeDb(() => ({ affectedRows: 0 })), logger, config });
  assert.equal(await PrintService.setLoadedMedia(7, 'small', 42), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && node --test test/print.test.js`
Expected: FAIL — `PrintService.createAgent is not a function`.

- [ ] **Step 3: Implement** — add `const { generateToken, hashToken } = require('./agent.middleware');` to the requires at the top of `print.service.js`, then add these methods:

```js
  // ── Agent registration & roll state ───────────────────────────────────────

  async createAgent({ propertyId, name, userId }) {
    const member = await _db.query(
      'SELECT PROPERTY_ID FROM TALLY.property_members WHERE PROPERTY_ID = ? AND USER_ID = ?',
      [propertyId, userId]
    );
    if (member.length === 0) return { error: 'not_found' };

    // Plaintext is handed back exactly once and never persisted.
    const token = generateToken();
    const result = await _db.query(
      'INSERT INTO TALLY.printer_agents (PROPERTY_ID, NAME, TOKEN_HASH) VALUES (?, ?, ?)',
      [propertyId, name, hashToken(token)]
    );
    return { id: result.insertId, name, token };
  },

  async listAgents(propertyId, userId) {
    const rows = await _db.query(
      `SELECT a.ID, a.PROPERTY_ID, a.NAME, a.LOADED_MEDIA, a.PRINTER_STATE,
              a.PRINTER_STATE_REASONS, a.LAST_SEEN_AT
         FROM TALLY.printer_agents a
         JOIN TALLY.property_members pm ON pm.PROPERTY_ID = a.PROPERTY_ID AND pm.USER_ID = ?
        WHERE a.PROPERTY_ID = ?`,
      [userId, propertyId]
    );
    // TOKEN_HASH is deliberately not selected — it must never reach the client.
    return rows.map(r => ({
      id: r.ID,
      propertyId: r.PROPERTY_ID,
      name: r.NAME,
      loadedMedia: r.LOADED_MEDIA,
      printerState: r.PRINTER_STATE,
      printerStateReasons: typeof r.PRINTER_STATE_REASONS === 'string'
        ? JSON.parse(r.PRINTER_STATE_REASONS || '[]')
        : (r.PRINTER_STATE_REASONS || []),
      lastSeenAt: r.LAST_SEEN_AT,
    }));
  },

  async revokeAgent(id, userId) {
    const result = await _db.query(
      `DELETE a FROM TALLY.printer_agents a
         JOIN TALLY.property_members pm ON pm.PROPERTY_ID = a.PROPERTY_ID AND pm.USER_ID = ?
        WHERE a.ID = ?`,
      [userId, id]
    );
    return result.affectedRows > 0;
  },

  async setLoadedMedia(agentId, loadedMedia, userId) {
    const updated = await _db.query(
      `UPDATE TALLY.printer_agents a
         JOIN TALLY.property_members pm ON pm.PROPERTY_ID = a.PROPERTY_ID AND pm.USER_ID = ?
          SET a.LOADED_MEDIA = ?
        WHERE a.ID = ?`,
      [userId, loadedMedia, agentId]
    );
    if (updated.affectedRows === 0) return null;

    // Loading a roll releases everything that was waiting on exactly that roll.
    const released = await _db.query(
      `UPDATE TALLY.print_jobs j
         JOIN TALLY.printer_agents a ON a.PROPERTY_ID = j.PROPERTY_ID
          SET j.STATUS = 'queued'
        WHERE a.ID = ? AND j.STATUS = 'held' AND j.PRESET = ?`,
      [agentId, loadedMedia]
    );
    return { released: released.affectedRows };
  },
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && node --test test/print.test.js`
Expected: PASS (29 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/print/print.service.js server/test/print.test.js
git commit -m "feat(print): agent registration, revocation and roll-state release"
```

---

## Task 6: Routes, registration & the agent rate limiter

**Files:**
- Create: `server/src/modules/print/print.routes.js`
- Modify: `server/index.js`
- Test: `server/test/print.test.js` (append)

**Interfaces:**
- Consumes: every `PrintService` method (Tasks 3–5), `requireAgent` (Task 2), the Joi schemas (Task 1).
- Produces: the endpoints in spec §5.

- [ ] **Step 1: Write the failing test** — append to `server/test/print.test.js`:

```js
test('the print module registers without throwing and wires both auth styles', () => {
  const routes = [];
  const app = {
    locals: { requireAuth: (req, res, next) => next() },
    get: (p) => routes.push(['GET', p]),
    post: (p) => routes.push(['POST', p]),
    put: (p) => routes.push(['PUT', p]),
    patch: (p) => routes.push(['PATCH', p]),
    delete: (p) => routes.push(['DELETE', p]),
  };
  require('../src/modules/print/print.routes')({ app, db: fakeDb(() => []), logger, config });

  const paths = routes.map(([m, p]) => `${m} ${p}`);
  for (const expected of [
    'POST /api/print/_y_/jobs',
    'GET /api/print/_x_/jobs',
    'PATCH /api/print/_p_/jobs/:id/cancel',
    'POST /api/print/_y_/jobs/:id/retry',
    'POST /api/print/_y_/agents',
    'GET /api/print/_x_/agents',
    'DELETE /api/print/_d_/agents/:id',
    'PUT /api/print/_u_/agents/:id/loaded-media',
    'POST /api/print/_y_/agent/claim',
    'GET /api/print/_x_/agent/jobs/:id/pdf',
    'POST /api/print/_y_/agent/jobs/:id/ack',
  ]) {
    assert.ok(paths.includes(expected), `missing route: ${expected}`);
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && node --test test/print.test.js`
Expected: FAIL — cannot find module `print.routes`.

- [ ] **Step 3: Implement** — create `server/src/modules/print/print.routes.js`:

```js
module.exports = function printRoutes({ app, db, logger, config }) {
  const PrintService = require('./print.service');
  PrintService.init({ db, logger, config });

  const { requireAgent } = require('./agent.middleware');
  const { createJob, setLoadedMedia, createAgent, agentClaim, agentAck } = require('./print.schema');
  const validate = require('../../middleware/validate');
  const { success, error } = require('../../utils/response');

  const { requireAuth } = app.locals;
  const agentAuth = requireAgent({ db });

  // ── User endpoints (session auth) ─────────────────────────────────────────

  // ── POST /api/print/_y_/jobs — queue a print ──────────────────────────────
  app.post('/api/print/_y_/jobs', requireAuth, validate(createJob, 'body'), async (req, res) => {
    const { entityType, entityIds, preset } = req.body;
    const out = await PrintService.createJob({ entityType, entityIds, preset, userId: req.user.id });
    if (out.error === 'not_found') return error(res, 'No entities found for the given IDs', 404);
    if (out.error === 'mixed') return error(res, 'All labels in one job must belong to the same property', 400);
    return success(res, out);
  });

  // ── GET /api/print/_x_/jobs — the queue for a property ────────────────────
  app.get('/api/print/_x_/jobs', requireAuth, async (req, res) => {
    const propertyId = Number(req.query.propertyId);
    if (!propertyId) return error(res, 'propertyId is required', 400);
    return success(res, await PrintService.listJobs(propertyId, req.user.id, 50));
  });

  // ── PATCH /api/print/_p_/jobs/:id/cancel ──────────────────────────────────
  app.patch('/api/print/_p_/jobs/:id/cancel', requireAuth, async (req, res) => {
    const ok = await PrintService.cancelJob(Number(req.params.id), req.user.id);
    return ok ? success(res, { canceled: true }) : error(res, 'Job not found or already finished', 404);
  });

  // ── POST /api/print/_y_/jobs/:id/retry ────────────────────────────────────
  app.post('/api/print/_y_/jobs/:id/retry', requireAuth, async (req, res) => {
    const ok = await PrintService.retryJob(Number(req.params.id), req.user.id);
    return ok ? success(res, { requeued: true }) : error(res, 'Job not found or not in a failed state', 404);
  });

  // ── POST /api/print/_y_/agents — register a printer ───────────────────────
  app.post('/api/print/_y_/agents', requireAuth, validate(createAgent, 'body'), async (req, res) => {
    const out = await PrintService.createAgent({
      propertyId: req.body.propertyId, name: req.body.name, userId: req.user.id,
    });
    if (out.error) return error(res, 'Property not found', 404);
    // The plaintext token appears in this response and nowhere else, ever.
    return success(res, out, 'Copy this token now — it will not be shown again');
  });

  // ── GET /api/print/_x_/agents ─────────────────────────────────────────────
  app.get('/api/print/_x_/agents', requireAuth, async (req, res) => {
    const propertyId = Number(req.query.propertyId);
    if (!propertyId) return error(res, 'propertyId is required', 400);
    return success(res, await PrintService.listAgents(propertyId, req.user.id));
  });

  // ── DELETE /api/print/_d_/agents/:id ──────────────────────────────────────
  app.delete('/api/print/_d_/agents/:id', requireAuth, async (req, res) => {
    const ok = await PrintService.revokeAgent(Number(req.params.id), req.user.id);
    return ok ? success(res, { revoked: true }) : error(res, 'Printer not found', 404);
  });

  // ── PUT /api/print/_u_/agents/:id/loaded-media ────────────────────────────
  app.put('/api/print/_u_/agents/:id/loaded-media', requireAuth, validate(setLoadedMedia, 'body'), async (req, res) => {
    const out = await PrintService.setLoadedMedia(Number(req.params.id), req.body.loadedMedia, req.user.id);
    return out ? success(res, out) : error(res, 'Printer not found', 404);
  });

  // ── Agent endpoints (bearer token; no session, no CSRF) ───────────────────

  // ── POST /api/print/_y_/agent/claim ───────────────────────────────────────
  app.post('/api/print/_y_/agent/claim', agentAuth, validate(agentClaim, 'body'), async (req, res) => {
    const job = await PrintService.claimNext(req.agent, req.body);
    if (!job) return res.status(204).end();   // idle — nothing to print
    return success(res, job);
  });

  // ── GET /api/print/_x_/agent/jobs/:id/pdf ─────────────────────────────────
  app.get('/api/print/_x_/agent/jobs/:id/pdf', agentAuth, async (req, res) => {
    // Only a job this agent currently holds — never an arbitrary id.
    const job = await PrintService.getClaimedJob(Number(req.params.id), req.agent.id);
    if (!job) return error(res, 'Job not found or not claimed by this agent', 404);

    const pdf = await PrintService.renderJobPdf(job);
    if (!pdf) return error(res, 'Nothing to render for this job', 404);

    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="job-${job.id}.pdf"`);
    return res.send(pdf);
  });

  // ── POST /api/print/_y_/agent/jobs/:id/ack ────────────────────────────────
  app.post('/api/print/_y_/agent/jobs/:id/ack', agentAuth, validate(agentAck, 'body'), async (req, res) => {
    const status = await PrintService.ackJob(
      Number(req.params.id), req.agent.id, req.body.ok, req.body.error
    );
    return status ? success(res, { status }) : error(res, 'Job not found or not claimed by this agent', 404);
  });
};
```

- [ ] **Step 4: Register the module and add the agent rate limiter** — in `server/index.js`:

Add the limiter beside the existing `authLimiter` / `shareLimiter` definitions (after line ~51):

```js
const agentLimiter = rateLimit({ windowMs: 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false });
AGENT_PATHS.forEach(p => app.use(p, agentLimiter));
```

**This alone is NOT enough** — middleware runs in registration order, so the
unconditional global limiter (200/min, registered earlier) still matches first
and 429s before the agent limiter is ever reached. Mounting a more permissive
limiter later does not raise the ceiling. The global limiter must SKIP these
paths. Add above the global limiter in `server/index.js`:

```js
const AGENT_PATHS = ['/api/print/_y_/agent', '/api/print/_x_/agent'];
const isAgentPath = (req) => AGENT_PATHS.some(p => req.path.startsWith(p));
```
and add `skip: isAgentPath,` to the existing global `rateLimit({...})` options.

Add the module registration alongside the others (after the `labels.routes` line):

```js
require('./src/modules/print/print.routes')({ app, db, logger, config });
```

- [ ] **Step 5: Run to verify it passes, then the whole suite**

Run: `cd server && node --test test/print.test.js`
Expected: PASS (30 tests).
Run: `cd server && node --test`
Expected: all pass, output pristine (the Phase 1 label tests must be untouched).
Run: `cd server && node --check src/modules/print/print.routes.js && node --check index.js`
Expected: both parse.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/print/print.routes.js server/index.js server/test/print.test.js
git commit -m "feat(print): routes, module registration and a dedicated agent rate limiter"
```

---

## Task 7: Client — hooks & "Send to printer"

**Files:**
- Create: `client/src/hooks/use-print.ts`
- Modify: `client/src/components/labels/label-print-dialog.tsx`

**Interfaces:**
- Consumes: the endpoints from Task 6.
- Produces: `usePrinters(propertyId)`, `usePrintJobs(propertyId)`, `useCreatePrintJob()`, `useCancelPrintJob()`, `useRetryPrintJob()`, `useCreatePrinter()`, `useRevokePrinter()`, `useSetLoadedMedia()`, and the exported types `Printer` / `PrintJob`.

- [ ] **Step 1: Create the hooks** — `client/src/hooks/use-print.ts`:

```ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { LabelPreset } from '@/hooks/use-labels';

export type PrintablePreset = Exclude<LabelPreset, 'sheet'>;

export interface Printer {
  id: number;
  propertyId: number;
  name: string;
  loadedMedia: PrintablePreset;
  printerState: 'idle' | 'printing' | 'stopped' | 'unknown';
  printerStateReasons: string[];
  lastSeenAt: string | null;
}

export interface PrintJob {
  id: number;
  entityType: string;
  entityIds: number[];
  preset: PrintablePreset;
  status: 'queued' | 'held' | 'claimed' | 'done' | 'failed' | 'canceled';
  attempts: number;
  lastError: string | null;
  createdAt: string;
}

const printerKeys = {
  printers: (propertyId: number) => ['print', 'printers', propertyId] as const,
  jobs: (propertyId: number) => ['print', 'jobs', propertyId] as const,
};

export function usePrinters(propertyId?: number) {
  return useQuery({
    queryKey: printerKeys.printers(propertyId ?? 0),
    queryFn: () => api.get<Printer[]>(`/api/print/_x_/agents?propertyId=${propertyId}`),
    enabled: !!propertyId,
    // The agent refreshes LAST_SEEN_AT every 2s; poll often enough that the
    // online indicator and printer status stay believable while the dialog is open.
    refetchInterval: 15000,
  });
}

export function usePrintJobs(propertyId?: number) {
  return useQuery({
    queryKey: printerKeys.jobs(propertyId ?? 0),
    queryFn: () => api.get<PrintJob[]>(`/api/print/_x_/jobs?propertyId=${propertyId}`),
    enabled: !!propertyId,
    refetchInterval: 15000,
  });
}

export function useCreatePrintJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { entityType: string; entityIds: number[]; preset: PrintablePreset; propertyId?: number }) =>
      api.post<{ id: number; status: PrintJob['status'] }>('/api/print/_y_/jobs', {
        entityType: vars.entityType, entityIds: vars.entityIds, preset: vars.preset,
      }),
    onSuccess: (_d, vars) => {
      if (vars.propertyId) qc.invalidateQueries({ queryKey: printerKeys.jobs(vars.propertyId) });
    },
  });
}

export function useCancelPrintJob(propertyId?: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: number) => api.patch(`/api/print/_p_/jobs/${jobId}/cancel`),
    onSuccess: () => { if (propertyId) qc.invalidateQueries({ queryKey: printerKeys.jobs(propertyId) }); },
  });
}

export function useRetryPrintJob(propertyId?: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: number) => api.post(`/api/print/_y_/jobs/${jobId}/retry`),
    onSuccess: () => { if (propertyId) qc.invalidateQueries({ queryKey: printerKeys.jobs(propertyId) }); },
  });
}

export function useCreatePrinter(propertyId?: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api.post<{ id: number; name: string; token: string }>('/api/print/_y_/agents', { propertyId, name }),
    onSuccess: () => { if (propertyId) qc.invalidateQueries({ queryKey: printerKeys.printers(propertyId) }); },
  });
}

export function useRevokePrinter(propertyId?: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.del(`/api/print/_d_/agents/${id}`),
    onSuccess: () => { if (propertyId) qc.invalidateQueries({ queryKey: printerKeys.printers(propertyId) }); },
  });
}

export function useSetLoadedMedia(propertyId?: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: number; loadedMedia: PrintablePreset }) =>
      api.put<{ released: number }>(`/api/print/_u_/agents/${vars.id}/loaded-media`, { loadedMedia: vars.loadedMedia }),
    onSuccess: () => {
      if (propertyId) {
        qc.invalidateQueries({ queryKey: printerKeys.printers(propertyId) });
        qc.invalidateQueries({ queryKey: printerKeys.jobs(propertyId) });
      }
    },
  });
}
```

> `LabelPreset` is Phase 1's exported union (`'small' | 'medium' | 'large' | 'sheet'`); `PrintablePreset` narrows it by removing `sheet`, so the type system enforces §4b at every call site.

- [ ] **Step 2: Typecheck the hook alone**

Run: `cd client && ./node_modules/.bin/tsc --noEmit`
Expected: clean. If `api.put`/`api.patch` signatures differ, adapt the calls to the real `client/src/lib/api.ts` surface (`get/post/put/patch/del`).

- [ ] **Step 3: Add "Send to printer" to the dialog** — in `label-print-dialog.tsx`:

Add the props/imports and derive printer state. `LabelPrintDialogProps` gains an optional `propertyId?: number` (callers that don't pass it simply get no print button):

```tsx
import { usePrinters, useCreatePrintJob, type PrintablePreset } from '@/hooks/use-print';

// inside the component:
const { data: printers } = usePrinters(propertyId);
const printer = printers?.[0];
const createPrintJob = useCreatePrintJob();

const isPrintable = preset !== 'sheet';
const online = !!printer?.lastSeenAt &&
  Date.now() - new Date(printer.lastSeenAt).getTime() < 60_000;
const problem = printer && printer.printerState === 'stopped'
  ? (printer.printerStateReasons[0] ?? 'stopped')
  : null;
const rollMatches = printer?.loadedMedia === preset;

const PROBLEM_TEXT: Record<string, string> = {
  'media-empty': 'out of labels',
  'cover-open': 'cover open',
  'media-jam': 'jammed',
  offline: 'offline',
};

function handlePrint() {
  createPrintJob.mutate(
    { entityType, entityIds: entities.map((e) => e.id), preset: preset as PrintablePreset, propertyId },
    {
      onSuccess: (res) => toast(res.status === 'held'
        ? `Queued — will print when you load the ${preset} roll`
        : `Printing ${entities.length} label${entities.length === 1 ? '' : 's'}`),
      onError: (err) => toast(err instanceof Error ? err.message : 'Failed to queue the print job'),
    },
  );
}
```

Render the button beside the existing Generate/Download action in `DialogFooter`, only when a printer exists and the preset is printable:

```tsx
{printer && isPrintable && (
  <Button
    size="sm"
    onClick={handlePrint}
    disabled={createPrintJob.isPending || !online || !!problem}
    title={
      problem ? `Printer: ${PROBLEM_TEXT[problem] ?? problem}`
      : !online ? 'Printer offline'
      : undefined
    }
  >
    <Printer className="w-3.5 h-3.5" />
    {problem ? `Printer: ${PROBLEM_TEXT[problem] ?? problem}`
      : !online ? 'Printer offline'
      : rollMatches ? 'Send to printer'
      : `Queue for ${preset} roll`}
  </Button>
)}
```

Keep the existing download button unconditionally — it is the escape hatch when the Pi is down.

- [ ] **Step 4: Pass `propertyId` from the three caller pages**

`client/src/pages/item-detail.tsx`, `container-detail.tsx`, `area-detail.tsx` each render `<LabelPrintDialog …>`. Add `propertyId={…}` using the property id each page already has in scope (e.g. `area.propertyId`, or the container's resolved property). If a page genuinely has no property id available, leave it off — the print button is then simply hidden there, which is acceptable and must be noted in the report.

- [ ] **Step 5: Gate**

Run: `cd client && ./node_modules/.bin/tsc --noEmit && npm run build`
Expected: tsc clean, build succeeds. There is **no client ESLint** — manually verify no unused imports were introduced.

- [ ] **Step 6: Commit**

```bash
git add client/src/hooks/use-print.ts client/src/components/labels/label-print-dialog.tsx client/src/pages/item-detail.tsx client/src/pages/container-detail.tsx client/src/pages/area-detail.tsx
git commit -m "feat(print): send-to-printer action in the label dialog"
```

---

## Task 8: Client — Settings → Printing

**Files:**
- Create: `client/src/components/print/printer-settings.tsx`
- Modify: `client/src/pages/settings.tsx`

**Interfaces:**
- Consumes: every hook from Task 7.

- [ ] **Step 1: Build the section** — `client/src/components/print/printer-settings.tsx`:

```tsx
import * as React from 'react';
import { Printer as PrinterIcon, Copy, Trash2, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import {
  usePrinters, usePrintJobs, useCreatePrinter, useRevokePrinter,
  useSetLoadedMedia, useCancelPrintJob, useRetryPrintJob,
  type PrintablePreset,
} from '@/hooks/use-print';

const ROLLS: { value: PrintablePreset; label: string }[] = [
  { value: 'small', label: 'Small · 2×1' },
  { value: 'medium', label: 'Medium · 3×3' },
  { value: 'large', label: 'Large · 4×6' },
];

const PROBLEM_TEXT: Record<string, string> = {
  'media-empty': 'Out of labels',
  'cover-open': 'Cover open',
  'media-jam': 'Jammed',
  offline: 'Offline',
};

export function PrinterSettings({ propertyId }: { propertyId?: number }) {
  const { data: printers } = usePrinters(propertyId);
  const { data: jobs } = usePrintJobs(propertyId);
  const createPrinter = useCreatePrinter(propertyId);
  const revokePrinter = useRevokePrinter(propertyId);
  const setLoadedMedia = useSetLoadedMedia(propertyId);
  const cancelJob = useCancelPrintJob(propertyId);
  const retryJob = useRetryPrintJob(propertyId);

  const [newName, setNewName] = React.useState('');
  const [issuedToken, setIssuedToken] = React.useState<string | null>(null);
  const printer = printers?.[0];

  const online = !!printer?.lastSeenAt && Date.now() - new Date(printer.lastSeenAt).getTime() < 60_000;
  const problem = printer?.printerState === 'stopped'
    ? PROBLEM_TEXT[printer.printerStateReasons[0]] ?? 'Stopped' : null;

  function handleAdd() {
    if (!newName.trim()) return;
    createPrinter.mutate(newName.trim(), {
      onSuccess: (res) => { setIssuedToken(res.token); setNewName(''); },
      onError: (e) => toast(e instanceof Error ? e.message : 'Could not add the printer'),
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {!printer && (
        <div className="flex gap-2">
          <Input placeholder="Printer name (e.g. Garage Pi)" value={newName}
                 onChange={(e) => setNewName(e.target.value)} />
          <Button size="sm" onClick={handleAdd} disabled={createPrinter.isPending}>Add printer</Button>
        </div>
      )}

      {issuedToken && (
        <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-3 flex flex-col gap-2">
          <p className="text-xs text-[var(--color-text-secondary)]">
            Copy this now — it is shown only once. Paste it into <code>tally-printer.conf</code> on the SD card:
          </p>
          <pre className="text-[10px] font-mono bg-[var(--color-elevated)] p-2 rounded overflow-x-auto">
{`tally_url   = ${window.location.origin}
agent_token = ${issuedToken}`}
          </pre>
          <Button variant="outline" size="sm" onClick={() => {
            navigator.clipboard.writeText(issuedToken).then(
              () => toast('Token copied'), () => toast('Could not copy'));
          }}>
            <Copy className="w-3.5 h-3.5" /> Copy token
          </Button>
        </div>
      )}

      {printer && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <PrinterIcon className="w-4 h-4" />
            <span className="text-sm font-medium">{printer.name}</span>
            <span className={`text-[10px] px-2 py-0.5 rounded-full ${
              problem ? 'bg-[var(--color-red-bg)] text-[var(--color-red)]'
              : online ? 'bg-[var(--color-green-bg)] text-[var(--color-green)]'
              : 'bg-[var(--color-elevated)] text-[var(--color-text-muted)]'}`}>
              {problem ?? (online ? 'Online' : 'Offline')}
            </span>
            <Button variant="outline" size="sm" className="ml-auto"
                    onClick={() => revokePrinter.mutate(printer.id)}>
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>

          <div>
            <p className="text-xs text-[var(--color-text-muted)] mb-1.5">Loaded roll</p>
            <div className="flex gap-2">
              {ROLLS.map((r) => (
                <Button key={r.value} size="sm"
                  variant={printer.loadedMedia === r.value ? 'default' : 'outline'}
                  onClick={() => setLoadedMedia.mutate({ id: printer.id, loadedMedia: r.value }, {
                    onSuccess: (res) => toast(res.released > 0
                      ? `Released ${res.released} waiting job${res.released === 1 ? '' : 's'}`
                      : 'Loaded roll updated'),
                  })}>
                  {r.label}
                </Button>
              ))}
            </div>
          </div>
        </div>
      )}

      {!!jobs?.length && (
        <div>
          <p className="text-xs text-[var(--color-text-muted)] mb-1.5">Recent jobs</p>
          <div className="flex flex-col gap-1">
            {jobs.map((j) => (
              <div key={j.id} className="flex items-center gap-2 text-xs border border-[var(--color-border)] rounded-[var(--radius-md)] px-2 py-1.5">
                <span className="font-mono">{j.preset}</span>
                <span className="text-[var(--color-text-muted)]">
                  {j.entityIds.length} label{j.entityIds.length === 1 ? '' : 's'}
                </span>
                <span className="ml-auto">
                  {j.status === 'held' ? `waiting for ${j.preset} roll` : j.status}
                </span>
                {j.status === 'failed' && (
                  <Button variant="outline" size="sm" title={j.lastError ?? undefined}
                          onClick={() => retryJob.mutate(j.id)}>
                    <RotateCw className="w-3 h-3" />
                  </Button>
                )}
                {['queued', 'held'].includes(j.status) && (
                  <Button variant="outline" size="sm" onClick={() => cancelJob.mutate(j.id)}>
                    <Trash2 className="w-3 h-3" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Mount it in Settings** — in `client/src/pages/settings.tsx`, import `PrinterSettings` and render it inside a section that matches the file's existing section markup (the same `<h2 className="text-sm font-semibold …">` + `Card` pattern used by Appearance / Notifications). Title it **Printing**, and pass the currently selected property's id — reuse whatever property the page already resolves for its other sections.

- [ ] **Step 3: Gate**

Run: `cd client && ./node_modules/.bin/tsc --noEmit && npm run build`
Expected: tsc clean, build succeeds. Manually verify no unused imports (no client ESLint).

- [ ] **Step 4: Manual check**

Start the app. Settings → Printing: add a printer, confirm the token appears **once** with the config snippet, switch the loaded roll, and confirm the print dialog's button text changes between "Send to printer" and "Queue for … roll" as the roll changes.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/print/printer-settings.tsx client/src/pages/settings.tsx
git commit -m "feat(print): Settings → Printing (printer, loaded roll, job queue)"
```

---

## Self-Review

**Spec coverage:** §2 pull model → Tasks 4/6 (agent claims, no inbound). §4 data model → Task 1. §4a transitions → Tasks 3–5. §4b sheet download-only → Task 1 (Joi) + Task 7 (`isPrintable`). §5 API → Task 6. §5a telemetry → Tasks 1, 4, 8. §6 security (hashed token, once-only plaintext, server-derived authority, PDF only for held jobs) → Tasks 2, 4, 5, 6. §9 client → Tasks 7–8. §10 testing → each task's tests. §3/§7/§8 (backends, image, bring-up) are explicitly out of scope for this plan.

**Placeholder scan:** none. Every step carries the actual code or command to run. Two clarifying notes explain cross-task details (why `crypto` is imported in Task 3 but first used in Task 4; why `PrintablePreset` narrows Phase 1's `LabelPreset`) — neither defers work.

**Type consistency:** `PrintService` method names are consistent across Tasks 3–6 (`resolveProperty`, `createJob`, `listJobs`, `cancelJob`, `retryJob`, `sweepStaleClaims`, `claimNext`, `getClaimedJob`, `renderJobPdf`, `ackJob`, `createAgent`, `listAgents`, `revokeAgent`, `setLoadedMedia`). `hashToken`/`generateToken`/`requireAgent` (Task 2) are consumed with those exact names in Tasks 5–6. Client `Printer`/`PrintJob`/`PrintablePreset` (Task 7) are used unchanged in Task 8. Preset vocabulary is `small|medium|large` server-side for jobs and rolls, with `sheet` existing only in Phase 1's label presets.

**Known gap accepted:** there is no route-level HTTP test harness in this repo (see issue #101), so Task 6 verifies wiring by registration assertions rather than live requests.

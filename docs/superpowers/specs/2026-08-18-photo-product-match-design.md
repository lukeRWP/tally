# Photo → product match: design

**Goal:** a confident photo identification finds the real product — brand, model,
UPC, price, image — without anyone scanning a barcode. Capture stays fast; the
choosing happens later, sitting down.

**Status:** approved 2026-08-18. Extends the vision identification shipped
2026-08-12 (PRs #155–163).

---

## 1. The problem

Vision identify names an item from a photo. Naming is not identifying: "DeWalt
cordless drill" matches dozens of SKUs, and only "DCD771C2" resolves to one.
Today the only path to a real product record is step 2 of the capture flow —
scanning a UPC barcode — which requires the box, good light, and a hand free.

The barcode is a means, not an end. What it buys is a catalog row: specs, retail
price, an image, a stable identity shared with other items of the same product.
If a photo can buy the same thing, the scan is not needed.

## 2. What the barcode step is actually for

`capture.tsx` documents the flow as three steps:

> The photo captures the thing, the product barcode names it, the tag files it.
> Step 3 is the one that cannot be skipped.

This design removes the need for step 2 on branded objects. Step 3 — which bin —
remains mandatory and untouched.

## 3. Flow

**Phone, rapid fire.** Photo → vision names the item → item created → step 2 is
replaced by a *product pending* chip → bin → next item. Nothing blocks on the
network. The user never waits for a search.

**Background.** Immediately after creating the item, the capture flow queues a
match, passing the vision suggestion it already holds. A fire-and-forget runner
performs one Claude call with web search and stores the candidates.

**Desk, later.** Alerts shows "N items need a product". `/matches` presents the
pending items in the existing split view — list left, candidates right. Tap a
candidate: the product is linked or created, the item leaves the list.

This is deliberately a two-device feature. Capture standing up, resolve sitting
down. On a phone `/matches` collapses to list → detail, which works, but the
screen is designed for the desk.

## 4. The gate

A match is queued only when **vision returned `confidence: 'high'` AND a
non-null `brand`**.

The brand condition is not a proxy for quality — it is the whole signal. The
vision prompt forbids inventing a brand, model or measurement that cannot be
read off the object (`vision.service.js`, and the reasoning in `normalise`).
So a brand coming back means text was legible on the thing itself, which is
exactly the condition under which a text search can resolve to one product.

An unbranded mug never searches, because that search was never going to land.
This is the primary cost control: most household objects are not branded, and
they cost nothing.

## 5. Data model — migration 008

Two changes, one migration. Both idempotent, no `USE` statement (CLAUDE.md
rules 15–17).

### 5.1 `product_matches`

Migration DDL uses **unqualified** table names and `TABLE_SCHEMA = DATABASE()`,
matching 002–007. The migrate-all playbook selects the database with `-D TALLY`,
so a hardcoded schema name is both redundant and a hazard if the target is ever
named differently. (Service code still writes `TALLY.` prefixes in its queries —
that is a different convention and stays as it is.)

```sql
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
    UNIQUE KEY uq_product_matches_item (ITEM_ID),
    KEY ix_product_matches_status (STATUS),
    KEY ix_product_matches_creator (CREATED_BY, CREATED_AT),
    CONSTRAINT fk_product_matches_item
        FOREIGN KEY (ITEM_ID) REFERENCES items (ID) ON DELETE CASCADE,
    CONSTRAINT fk_product_matches_product
        FOREIGN KEY (SELECTED_PRODUCT_ID) REFERENCES products (ID)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

`SEARCH_QUERY`, not `QUERY` — avoids any argument with the parser.
`UNIQUE (ITEM_ID)` — one match record per item, so a double-fire cannot create
two. `CREATED_BY` exists for the per-user daily cap (§8) and for audit;
`ix_product_matches_creator` serves that count.
`ON DELETE CASCADE` matters for purge: items are soft-deleted normally, but the
recycle bin's 30-day purge hard-deletes, and a match row must not outlive its
item.

### 5.2 `products.DATA_SOURCE`

The column is `ENUM('upc_db','open_food_facts','scrape','manual')`. Recording
this honestly needs a new value. MySQL 8 has no `ADD VALUE IF NOT EXISTS`, so
guard with `information_schema` plus a prepared statement, matching 002:

```sql
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

**This migration runs before the code that needs it merges.** Merge-first caused
a 14h17m production outage on 2026-08-15; the ordering is not negotiable.

## 6. The match call

New file `server/src/modules/products/lookup/product-match.js`, sitting beside
the existing lookup providers.

**Input is text, never the image**: `{brand, name, category, description}` taken
from the vision suggestion. The photo has already done its job.

One Claude call, mirroring `vision-identify.js`'s use of the SDK:

- model from `config.match.model` (default `claude-sonnet-5`)
- adaptive thinking (`thinking: {type: 'adaptive'}`)
- the `web_search` server tool, capped at a small `max_uses`
- structured output validated against a fixed schema

Each candidate:

| field | rule |
|---|---|
| `name` | required; candidate dropped without it |
| `brand` | optional |
| `model` | optional |
| `upc` | optional; must be 8, 12, 13 or 14 digits or it is dropped |
| `priceUsd` | optional, positive |
| `imageUrl` | optional, must parse as `https:` |
| `sourceUrl` | required, must parse as `https:` |
| `sourceDomain` | derived from `sourceUrl`, not taken from the model |

At most **3** candidates are kept. A response that fails validation is not an
error — it is `none` (§9).

`sourceUrl` is stored as provenance only. It is not fetched in v1 and not
surfaced as a shopping link; it exists so a spec can be traced to where it came
from.

## 7. The runner, and why there is no scheduler

`POST /_y_/matches` inserts a `queued` row and kicks a fire-and-forget async
runner, then responds immediately — the client never waits for the search.
The runner sets `searching` + `SEARCH_STARTED_AT`, performs the call, and writes
`ready` with candidates, or `none`, or `failed`.

`GET /_x_/matches` first sweeps: any row in `searching` older than
`MATCH_STALE_MINUTES` goes back to `queued` with `ATTEMPTS + 1`, and any row
exceeding `MATCH_MAX_ATTEMPTS` becomes `failed`. This is `sweepStaleClaims` from
the print module, for the same reason — this app has nowhere to run a cron, and
a lazy sweep on read is self-healing without one. The attempts cap exists so a
query that reliably kills the runner cannot loop forever.

**The runner must not carry an abort-on-disconnect handler.** Vision identify
was once broken exactly this way: a `req.on('close')` handler aborted every call
at 0ms. The runner outlives the request that created it by design.

## 8. Cost controls

Three, because a background feature with no ceiling is how a rapid-fire session
becomes a surprise bill:

1. **The gate** (§4) — unbranded objects never search.
2. **`config.match.dailyPerUser`** (default 100) — counted from
   `product_matches` by `CREATED_BY` over 24h, checked in the runner before the
   call. Exceeding it writes `failed` with a clear `LAST_ERROR`, visible in the
   worklist rather than silent.
3. **`config.match.enabled`** — `MATCH_ENABLED=false` kills the feature without
   touching the vault, mirroring `VISION_ENABLED`. With it off, capture behaves
   exactly as it does today.

### 8.1 Config

A `match` block in `server/src/config.js`, shaped like the existing `vision`
block it sits beside:

```js
match: {
  model: process.env.MATCH_MODEL || 'claude-sonnet-5',
  enabled: !!process.env.ANTHROPIC_API_KEY && process.env.MATCH_ENABLED !== 'false',
  timeoutMs: parseInt(process.env.MATCH_TIMEOUT_MS || '45000', 10),
  dailyPerUser: parseInt(process.env.MATCH_DAILY_PER_USER || '100', 10),
  maxCandidates: parseInt(process.env.MATCH_MAX_CANDIDATES || '3', 10),
  staleMinutes: parseInt(process.env.MATCH_STALE_MINUTES || '5', 10),
  maxAttempts: parseInt(process.env.MATCH_MAX_ATTEMPTS || '3', 10),
},
```

`timeoutMs` is far longer than vision's 12s: a call that performs several web
searches legitimately takes tens of seconds. Nobody is waiting on it, so the
generous budget costs nothing. `staleMinutes` and `maxAttempts` mirror the print
module's `STALE_CLAIM_MINUTES` / `MAX_ATTEMPTS`.

The API key is shared with vision — no new credential.

## 9. Failure behaviour

Nothing here can block capture, and nothing disappears silently.

| Outcome | Status | What the user sees |
|---|---|---|
| Candidates found | `ready` | The item, with up to 3 candidates |
| Search ran, found nothing | `none` | "No match found", with *scan barcode* and *search manually* |
| Call failed, under cap | `queued` | Nothing yet; retried on next sweep |
| Call failed, at cap | `failed` | "Couldn't look this up", with the same two actions |
| Feature disabled | no row | Today's flow, barcode step included |

`none` and `failed` appearing in the worklist is deliberate. If a failed lookup
removed the item from the list, the user would never learn it failed — they'd
have items that quietly never got a product.

## 10. Resolve

`POST /_y_/matches/:id/resolve` with `{candidateIndex}` or `{dismiss: true}`.

**Convergence on the catalog.** `products.BARCODE` is `UNIQUE`. Resolve looks
the candidate's UPC up first and links the existing catalog row when there is
one, inserting only when there is not. The photo path and the barcode path land
on the same product row instead of racing to create two of it. A candidate with
no UPC always inserts a new row with `BARCODE = NULL`.

The item gets `PRODUCT_ID`. It gets nothing else — `items` has no `BARCODE`
column; the barcode lives on the product and is reached through the join.

**Duplicate detection moves here.** `checkDuplicate` resolves
`barcode → products.ID → items.PRODUCT_ID`, scoped by `property_members`. At
capture time there is no barcode yet, so this is the first moment tally *can*
say "you already own one of these" — and resolve runs it, showing the existing
item and its location before writing.

New product rows are written with `DATA_SOURCE = 'vision_match'` and the
`sourceUrl` recorded in `RETAIL_LINKS` (already `JSON` — no column needed).

`{dismiss: true}` sets `dismissed` and writes no product.

## 11. Routes

Registered in the products module as `matches.routes.js` / `matches.service.js` /
`matches.schema.js`, alongside the existing `vision.*` files.

| Route | Guards | Returns |
|---|---|---|
| `POST /api/products/_y_/matches` | `requireAuth`, burst, daily | `{id, status}` — queues and returns at once |
| `GET /api/products/_x_/matches?propertyId=` | `requireAuth` | Pending matches with candidates |
| `POST /api/products/_y_/matches/:id/resolve` | `requireAuth` | The linked/created product |

**Why the queue is its own route rather than a side effect of item creation.**
`items` has no `BRAND` column, so the vision brand is discarded at create time
and the server cannot apply the gate from the item alone. Passing vision fields
through the inventory create payload would couple inventory to a products
concern for no gain. The capture flow already holds the suggestion, so it posts
it here directly, and `items.service.js` is untouched by this feature.

The queue route verifies the caller owns the item through the membership join
before inserting — the gate is advisory (the client applies it), but ownership
never is.

Both mirror `identify-photo`'s guard order: `requireAuth` first so `req.user`
exists, then limiters. Registered in `server/index.js` with the standard
dependency object alongside the other product routes:

```js
require('./src/modules/products/matches.routes')({ app, db, logger, config });
```

**Privacy invariant.** Unlike `identify-photo`, these routes issue SQL, so the
membership rule applies in full. Every read and write joins
`items → containers → areas → properties → property_members` with
`pm.USER_ID = ?`. A match row is reachable only through the item it belongs to,
so the scoping holds by construction rather than by remembering to add it.

## 12. Client

- **`capture.tsx`** — when a photo was taken and vision returned high confidence
  with a brand, step 2 is skipped and a *product pending* chip is shown in its
  place. Everything else about the flow is unchanged. When the feature is off,
  or the gate fails, step 2 appears exactly as today.
- **`/matches`** — new page using the existing `SplitView`: pending items left,
  candidates right. Each candidate card shows image, name, brand, model, UPC and
  price. `none`/`failed` rows offer *scan barcode* and *search manually*, both
  routing into flows that already exist.
- **Alerts** — a "N items need a product" entry linking to `/matches`.
- **`use-matches.ts`** — TanStack Query hook; the list polls while any row is
  `queued` or `searching`, and stops when none are.

## 13. Testing

**Server** (`fakeDb` + `node:test`, SDK mocked):

- the gate: queued only for high confidence **and** brand; nothing otherwise
- one match row per item under repeated creation (the `UNIQUE` key)
- candidate normalisation: cap of 3, UPC digit-length validation, non-https
  `sourceUrl` rejected, candidate without `name` dropped
- an SDK failure yields `failed`/`queued`, never a thrown error out of the runner
- the sweep: `searching` past the timeout requeues; attempts cap lands `failed`
- the daily cap blocks the call and records a readable `LAST_ERROR`
- resolve links an existing product when the UPC is already in the catalog, and
  inserts when it is not
- resolve surfaces an existing owned item via `checkDuplicate`
- privacy: a user outside the property sees no rows and cannot resolve

**Client:** `tsc --noEmit` and `npm run build` (there is no client ESLint in this
repo), plus harness screenshots of `/matches` at 390, 768 and 1600.

## 14. Out of scope for v1

Deliberate omissions, each with the reason:

- **No `url-extractor` verification pass.** Trust the structured output first and
  measure. Verifying every candidate doubles the latency of the thing meant to
  make this faster, and the extractor can be added behind the same interface if
  data quality disappoints.
- **No caching.** Every household item is different, so the hit rate would be
  near zero.
- **No retailer link surfaced.** Provenance is stored, not shown.
- **No auto-apply**, even for a single exact UPC. A wrong product carries a UPC,
  a price and a spec sheet that all look like fact — the same reasoning that
  keeps `estimatedValue` from auto-applying into the insurance report.
- **No bulk accept** and **no manual re-run button.** The sweep already retries
  failures; both are cheap to add later if the worklist proves tedious.

## 15. Risks

- **Search quality on used or obscure household goods may be poor**, producing a
  lot of `none`. The gate limits the cost of finding out. Measure the
  `ready`/`none` ratio before investing in verification or a second provider.
- **The model may return a plausible but wrong UPC.** Mitigated by digit-length
  validation, by three candidates rather than one, and by never auto-applying.
- **Cost drift** as capture volume grows — bounded by the gate, the daily cap and
  the kill switch.

# Tally

Collaborative home inventory management system. Track items across containers and locations in your home, with QR code scanning, full-text search, and multi-user support.

## Tech Stack

| Layer      | Technology                                      |
|------------|-------------------------------------------------|
| Frontend   | React 19 + TypeScript 6 (Vite 7)                |
| UI         | Radix UI primitives + Tailwind CSS v4           |
| Icons      | Lucide React                                    |
| Fonts      | Inter (body), JetBrains Mono (code/labels)      |
| Backend    | Express 5 (Node, CommonJS)                      |
| Database   | MySQL 8.4 (prod, via PW catalog; local docker-compose still pins 8.0) |
| Storage    | MinIO via `@aws-sdk/client-s3` (presigned URLs) |
| AI         | Claude vision photo-identify (`ANTHROPIC_API_KEY`) |
| Testing    | Vitest (client) + `node --test` (server)        |
| Auth       | Microsoft Entra ID (OIDC)                       |
| Container  | Docker Compose (local) / PW v2 `pw.json` (prod) |

## Backlog & Issue Tracking

**Deferred work goes to GitHub issues**, not session task lists or ad-hoc TODOs:

```bash
gh issue create -R lukeRWP/tally -t "<one-line subject>" -b "<context>"
```

Session tasks rotate out when memory recycles; GH issues persist, are visible to the operator at any time, and link to PRs when the fix lands.

**When you find something out of scope mid-task:**
- File an issue with a one-line subject + multi-line body explaining context.
- Apply an existing label (`enhancement`, `infrastructure`, `security`, `documentation`, `operator-action` for things requiring human action). Don't invent labels without asking.
- End the body with `---\nMigrated from session backlog YYYY-MM-DD.` so the origin is clear.
- The session task can do in-flight bookkeeping; the GH issue is the permanent record.

**Skip the issue** only when the work is fully done in-session with no deferred follow-up.

## Common Commands

```bash
task init         # First-time setup (copy .env, build containers)
task up           # Start all services
task dev          # Start with hot-reload dev servers
task down         # Stop all services
task logs:server  # Tail server logs
task logs:client  # Tail client logs
task db:shell     # Open MySQL shell in TALLY database
task db:reset     # Reset database (destructive)
task clean        # Full cleanup (removes volumes)
```

Local dev (outside Docker):

```bash
cd client && npm run dev    # Vite dev server on :3000 (proxies /api to :2727)
cd server && node index.js  # Express server on :2727
```

Test commands:

```bash
cd client && npm test       # vitest
cd server && npm test       # node --test
```

## Project Structure

```
tally/
├── client/                       # React frontend (Vite + TypeScript)
│   ├── src/
│   │   ├── components/
│   │   │   ├── inventory/        # Entity cards (property, area, container, item)
│   │   │   ├── layout/           # Root layout, header, bottom-nav, breadcrumbs
│   │   │   └── ui/               # Shared primitives (button, card, badge, dialog, input, skeleton, toast)
│   │   ├── hooks/                # 20+ hooks (use-auth, use-inventory, use-print, use-vision, …)
│   │   ├── lib/                  # api.ts, query-client.ts, utils.ts + ~10 more helpers
│   │   ├── pages/                # home, areas, search, property/area/container/item-detail, capture, put-down, scan, qr-redirect, matches, print-queue, notifications, recycle-bin, share-view, reports, settings, login, oauth-callback (/inventory redirects to /areas)
│   │   ├── store/                # Zustand: auth-store, carry-store, print-queue-store, vision-store
│   │   ├── types/                # api.ts, auth.ts, inventory.ts
│   │   ├── globals.css           # Tailwind v4 @theme + OKLCH color tokens
│   │   ├── App.tsx               # Router + route definitions
│   │   └── main.tsx              # React entry point
│   ├── index.html
│   ├── vite.config.ts            # @tailwindcss/vite plugin, path alias @/
│   ├── tsconfig.json
│   ├── postcss.config.js         # Empty (Tailwind handled by Vite plugin)
│   └── package.json
├── server/                       # Express backend (CommonJS)
│   ├── index.js                  # Entry point — middleware + route registration
│   └── src/
│       ├── config.js             # Validated env config object
│       ├── infrastructure/
│       │   └── db.js             # mysql2/promise connection pool
│       ├── middleware/
│       │   ├── csrf.js           # Double-submit CSRF cookie — every non-GET client call depends on it
│       │   ├── error-handler.js  # Global error handler
│       │   └── validate.js       # Joi validation middleware helper
│       ├── modules/              # One dir per feature — server/index.js is the authoritative list
│       │   ├── auth/             # auth.routes, auth.service, auth.middleware, auth.schema
│       │   ├── inventory/        # properties, areas, containers, items (+ closure-table.service.js, move-reconcile.service.js)
│       │   ├── products/         # Barcode lookup + Claude vision photo-identify (vision.service.js, matches.*)
│       │   ├── files/            # Upload/download + thumbnails.service.js (lazy 256px derivatives)
│       │   ├── print/            # Print queue + Pi agent API (agent.middleware.js, role.middleware.js)
│       │   ├── recycle/          # Delete batches + batch restore
│       │   └── …                 # accessories, audit, dates, labels, lending, notifications, reports, sharing, tags
│       ├── repositories/
│       │   └── BaseRepository.js
│       └── utils/
│           ├── logger.js         # Winston logger (DailyRotateFile in prod)
│           ├── qr.js             # QR code generation (TLY-{TYPE}-{HEX} format)
│           └── response.js       # success() / error() response helpers
├── SQL/
│   ├── init/
│   │   ├── 001_TALLY_Init.sql    # Full schema: 21 tables
│   │   └── 002_apply_migrations.sh # Applies SQL/migrations/ after the base schema in local dev
│   ├── migrations/               # 001–011 (see Database → Migrations)
│   ├── ci/migration-gate.sh      # CI migration gate — chain applied twice + schema diff (rule 9)
│   └── expected-schema.sql       # GENERATED. Regenerate with `SQL/ci/migration-gate.sh --write`
├── docker-compose.yml            # 5 services: tally-db, tally-minio, tally-server, tally-client, tally-vault (no nginx locally)
├── Taskfile.yml
├── .env.template
└── CLAUDE.md
```

## Backend Modules

Each feature lives in `server/src/modules/{feature}/` with three files:

```
{feature}.routes.js   # Express routes — thin, delegates to service
{feature}.service.js  # Business logic, SQL queries
{feature}.schema.js   # Joi validation schemas
```

### Registered routes

| Module      | Prefix            | Key endpoints                                              |
|-------------|-------------------|------------------------------------------------------------|
| auth        | `/api/auth`       | GET `/_x_/session`, GET `/_x_/oauth/init`, GET `/_x_/oauth/callback`, POST `/_y_/logout` |
| properties  | `/api/properties` | CRUD + membership: GET/POST `/_x_|_y_/:id/members`, PATCH `/_p_/:id/members/:userId` (role), DELETE `/_d_/:id/members/:userId` — all owner-only |
| areas       | `/api/areas`      | CRUD scoped to a property                                  |
| containers  | `/api/containers` | CRUD + move (uses closure table for hierarchy)             |
| items       | `/api/items`      | CRUD + move + FULLTEXT search                              |
| products    | `/api/products`   | Barcode lookup, catalog CRUD, duplicate check, text search; POST `/_y_/identify-photo` (Claude vision), `/_y_/extract-url`; matches queue (`/_y_|_x_/matches`, `/_y_/matches/:id/resolve`) |
| files       | `/api/files`      | Upload, download (presigned URLs), list by item, delete    |
| conditions  | `/api/conditions` | Create snapshot (photo + rating), history by item, delete  |
| tags          | `/api/tags`          | Tag CRUD, polymorphic entity tagging                       |
| labels        | `/api/labels`        | QR generation, PDF label printing (4 presets), code resolution |
| lending       | `/api/lending`       | Lend, return, history, overdue tracking                    |
| dates         | `/api/dates`         | User-defined date types per item, upcoming dates           |
| accessories   | `/api/accessories`   | Link/unlink items as accessories                           |
| audit         | `/api/audit`         | Change log, activity feed by property/entity/recent        |
| notifications | `/api/notifications` | List, mark read, preferences, date-based checks            |
| reports | `/api/reports` | Generate PDF/CSV reports (insurance, value, location, lending, activity, tags) |
| sharing | `/api/sharing` | Time-limited share links, public read-only views |
| print         | `/api/print`         | Print-job queue + Raspberry Pi agent API (auto-print)      |
| recycle       | `/api/recycle`       | GET `/_x_/list` (delete batches), POST `/_y_/restore/:batchId` (batch undo) |

All modules are registered in `server/index.js` via:

```js
require('./src/modules/auth/auth.routes')({ app, db, logger, config });
require('./src/modules/inventory/properties.routes')({ app, db, logger, config });
require('./src/modules/inventory/areas.routes')({ app, db, logger, config });
require('./src/modules/inventory/containers.routes')({ app, db, logger, config });
require('./src/modules/inventory/items.routes')({ app, db, logger, config });
require('./src/modules/files/files.routes')({ app, db, logger, config });
require('./src/modules/files/condition.routes')({ app, db, logger, config });
require('./src/modules/products/products.routes')({ app, db, logger, config });
require('./src/modules/products/matches.routes')({ app, db, logger, config });
require('./src/modules/tags/tags.routes')({ app, db, logger, config });
require('./src/modules/labels/labels.routes')({ app, db, logger, config });
require('./src/modules/lending/lending.routes')({ app, db, logger, config });
require('./src/modules/dates/dates.routes')({ app, db, logger, config });
require('./src/modules/accessories/accessories.routes')({ app, db, logger, config });
require('./src/modules/audit/audit.routes')({ app, db, logger, config });
require('./src/modules/notifications/notifications.routes')({ app, db, logger, config });
require('./src/modules/reports/reports.routes')({ app, db, logger, config });
require('./src/modules/sharing/sharing.routes')({ app, db, logger, config });
require('./src/modules/recycle/recycle.routes')({ app, db, logger, config });
require('./src/modules/print/print.routes')({ app, db, logger, config });
```

## Phase 2 Infrastructure & Integrations

### MinIO Object Storage

- MinIO is an S3-compatible object store running as a Docker service (`tally-minio`), accessed via `@aws-sdk/client-s3` + `s3-request-presigner` (NOT the `minio` SDK).
- The server calls `storage.ensureBucket()` on startup to auto-create the configured bucket if it does not exist.
- File downloads use **presigned URLs, memoised per (key, options)** in a bounded cache in `storage.js` — SigV4 puts the signature in the query string, so re-signing on every render produces a fresh URL and defeats the browser cache entirely. Objects are written with `Cache-Control: private, max-age=31536000, immutable`.
- List rows serve a lazily generated 256px thumbnail (`item_files.THUMB_KEY`, migration 007, `files/thumbnails.service.js`); a NULL thumb serves the original and generates in the background. Thumbnail generation is the one path where the server reads object bytes back — it never streams files to clients.
- Upload flow: client sends `multipart/form-data` (NOT JSON) to `POST /api/files/_y_/upload`; the server pipes the stream to MinIO.

### External Product Lookup APIs

Two external APIs are queried in sequence when a barcode is scanned and not found locally:

1. **Open Food Facts** (`https://world.openfoodfacts.org/api/v2/product/{barcode}.json`) — free, no key required, best for food/grocery items.
2. **UPC Database** (`https://api.upcitemdb.com/prod/trial/lookup?upc={barcode}`) — general product catalog, free tier available.

Results are normalised to the internal `products` schema and optionally cached in the `TALLY.products` table.

### Camera Barcode Scanning

- Library: `html5-qrcode` (client-side, no server involvement).
- The `ScanPage` component activates the device camera, decodes barcodes in real time, and triggers the product lookup flow on a successful scan.
- Fallback: manual barcode entry field for environments where camera access is unavailable.

### File Upload Convention

- All file upload requests must use `Content-Type: multipart/form-data`.
- The field name for the file binary is `file`.
- JSON metadata (item ID, description, etc.) is sent as additional form fields alongside the binary.
- Do **not** base64-encode files or send them as JSON — use `FormData` on the client.

## Dependency Injection

All modules receive a standard dependency object:

```js
{ db, logger, config }
```

- `db` — MySQL connection pool (`mysql2/promise`)
- `logger` — Winston logger instance
- `config` — Validated environment config object

Note: there is no Redis / cache dependency. Sessions are stored in MySQL (`TALLY.sessions` table).

## API Conventions

### Route Prefixes

| Prefix | Method |
|--------|--------|
| `_x_`  | GET    |
| `_y_`  | POST   |
| `_u_`  | PUT    |
| `_p_`  | PATCH  |
| `_d_`  | DELETE |

Example: `GET /api/items/_x_/list`, `POST /api/items/_y_/create`

### Response Envelope

All API responses use:

```json
{ "success": true, "data": {}, "message": "Optional message" }
```

### Naming Conventions

- Database columns: `UPPER_SNAKE_CASE`
- API fields: `camelCase`
- Services map DB results to camelCase before returning

### Validation Status Codes

A request the server refuses because of what the caller sent — a Joi failure,
a missing required field or file, an unparseable id or URL, an unknown enum
value — is **400**, with the Joi messages in `errors[]`. That is what
`middleware/validate.js` and the error-handler's Joi branch already emit; the
hand-rolled route checks were aligned to it in #357 (they used to say 422).
Never introduce 422: the client does not distinguish the two and a second code
for the same class of mistake only splits the toast/inline behaviour by accident.
Related-entity mismatches ("must be in the same property") are also 400; a
resource that exists but is the wrong shape is 409, not 4xx-validation.

## Three-Tier Data Pattern

```
StateStore (Zustand)
    └── API client (lib/api.ts + TanStack Query)
            └── Express services (business logic, return camelCase)
                    └── SQL (mysql2/promise, UPPER_SNAKE_CASE columns)
```

- **Services** handle all SQL — business logic + data transformation
- **API client** (`lib/api.ts`) wraps fetch with auth headers and base URL
- **TanStack Query** manages server-state cache on the client
- **Zustand** (`store/auth-store.ts`) manages client-side auth state

## Frontend Conventions

- Radix UI primitives for accessible interactive components (Dialog, DropdownMenu, Select, Tooltip, etc.)
- Custom Tailwind utility classes for styling — no Radix themes
- Lucide React for all icons
- Inter font for all body text; JetBrains Mono for item codes, QR labels, and monospace fields
- Co-locate component styles with component files (no global CSS beyond base reset and theme tokens)
- Form management via `react-hook-form` + `@hookform/resolvers` with Zod schemas (client-side only)

## Color System

Colors are defined as OKLCH CSS custom properties in `client/src/globals.css`.

Light and dark mode are supported via:
- `.dark` class on `<html>` for explicit dark mode
- `@media (prefers-color-scheme: dark)` for system preference (applied to `:root:not(.light)`)

Token set: `--color-bg`, `--color-card`, `--color-elevated`, `--color-border`, `--color-text`, `--color-text-secondary`, `--color-text-muted`, `--color-primary`, `--color-primary-bg`, plus semantic colors: `--color-green`, `--color-amber`, `--color-red`, `--color-purple` (each with a `-bg` alpha variant).

Tailwind v4 uses the `@tailwindcss/vite` plugin — no `tailwind.config.js` or PostCSS plugin is required.

## Database

Single database: `TALLY`

Key design patterns:

- **Closure table** for container hierarchy (supports arbitrary nesting of locations/containers)
- **FULLTEXT indexes** on item name, description, and tags for fast search
- All tables include `CREATED_AT` / `UPDATED_AT` timestamps
- Soft deletes via `DELETED_AT` where appropriate
- Sessions stored in MySQL `sessions` table (no Redis)

### Migrations (`SQL/migrations/`)

| # | Purpose |
|---|---------|
| 001 | notification entity types |
| 002 | entity indexes (the `information_schema`-guard idempotency pattern lives here) |
| 003 | print jobs + printer agents |
| 004 | delete batches (recycle bin) |
| 005 | CURRENT_VALUE is-estimate marker |
| 006 | item completeness |
| 007 | item file thumbnails (`THUMB_KEY`) |
| 008 | product matches (vision queue) |
| 009 | printer agent `CREATED_BY` tether |
| 010 | items indexes |
| 011 | share-link disclosure choices (`share_links.DISCLOSURE` JSON; NULL = share everything) |
| 012 | per-user daily vision usage (`vision_usage`), so the spend cap survives a restart (#340) |
| 013 | notification dedupe: `notifications.DUE_ON` + `DISMISSED_AT`, `uq_notifications_due` (#348) |
| 014 | share tokens hashed in place: `share_links.TOKEN_HASHED` marker + `TOKEN = SHA2(TOKEN, 256)` (#349) |

## Authentication

- Provider: Microsoft Entra ID (Azure AD) via OIDC with PKCE
- Sessions stored in MySQL (`TALLY.sessions`) — no Redis
- Session token sent as an httpOnly signed cookie (`session_token`)
- Set `BYPASS_AUTH=true` in `.env` to skip real auth during local development (auto-creates a dev user + session)
- User identity (`req.user`) is injected into all request contexts after `requireAuth` middleware
- CSRF: double-submit cookie (`server/src/middleware/csrf.js`, registered in `index.js`) — every non-GET client call must echo the token header

### Property membership & roles

- Authority is `TALLY.property_members.ROLE` (`owner` / `editor` / `viewer`), resolved per request by `resolvePropertyRole` from `:propertyId` and gated by `requireRole(...)`. `properties.OWNER_ID` is who created it and is **not** consulted for permissions — a property can have several owners.
- Membership routes are all `requireRole('owner')`. Add is by email of an existing user (`409` if already a member); PATCH changes a role; DELETE removes. **A property must always keep at least one owner**: the service locks the property's member rows (`FOR UPDATE`) and answers `409` to any demote/remove that would leave zero owners (#345). Every change writes a `change_log` row (`property` / `updated` with a `member` payload — the enums have no member-specific values).
- Client: Settings → Members (`components/inventory/property-members.tsx`, hooks in `use-members.ts`) mounts only when the selected property's role (carried by the properties list) is `owner`; the only owner's controls are disabled up front rather than letting the 409 happen; removing anyone, or demoting yourself, confirms first.

## Validation

- **Server**: Joi (`server/src/modules/**/*.schema.js`)
- **Client**: Zod + `react-hook-form` (client-side form validation only)

## QR Code Format

```
TLY-{TYPE}-{HEX}
```

| TYPE | Entity     |
|------|------------|
| `P`  | Place      |
| `A`  | Area       |
| `C`  | Container  |
| `I`  | Item       |

Example: `TLY-I-3a9f2c` — a unique item identifier encoded as a scannable QR code.

## Phase 3 Features

### QR Deep-Link Resolution

Scanning a TLY code navigates to `/s/:code` on the client. The `QrRedirect` page (`client/src/pages/qr-redirect.tsx`) calls `GET /api/labels/_x_/resolve/:code`, which decodes the entity type and ID from the code and returns the canonical deep-link path (e.g. `/items/42`). The client then redirects to that path automatically.

### Scan-Scan-Done Workflow (Move Mode)

`/move` (renders `pages/put-down.tsx`, not `/scan`) is a station you stay at, with two modes:

1. **Gather** — while carrying a load, scan a bin/area to land the whole load (unchanged `PATCH /api/items/_p_/:id/move` / `.../containers/_p_/:id/move`), or scan an item not already in hand to add it to the load (`Carrying N`). Any container scan is treated as a destination, never as something to add.
2. **Distribute** — after a landing, the destination stays **pinned** as a banner instead of navigating away. Scanning an item now moves it straight to the pin (`Moved N to X`, with a toast Undo); scanning a new bin/area re-pins instead — nothing moves.
3. **Done** (button, or Esc at a desk) leaves to the pinned destination's page — leaving is the explicit act, staying is the default.

A typed-code field under the scanner is the fallback for a damaged label; the same field is the primary control at a desk in distribute mode, which has no camera.

### Label Printing (PDF, 4 presets)

- `POST /api/labels/_y_/generate` — accepts `{ entityType, entityIds, preset }` and **always** returns `application/pdf`. All output is rendered server-side with `pdfkit`. There is no ZPL output and no `format` field.
- `entityType` is one of `item` | `container` | `area`; `entityIds` is an array of IDs (max 100), all of the same type.
- `preset` selects the geometry:

| Preset   | Size    | Output                                                            |
|----------|---------|-------------------------------------------------------------------|
| `small`  | 2 × 1"  | Item tag — QR left, name right                                     |
| `medium` | 3 × 3"  | Bin / location tag — QR centred, TLY code + entity type in footer  |
| `large`  | 4 × 6"  | Contents manifest — paginated list of what's inside                |
| `sheet`  | Letter  | Avery 5160, 30-up sheet                                            |

- `preset` defaults to `small` for items and `medium` for containers/areas.
- `large` is a contents manifest and is **containers/areas only** — requesting it for an item fails Joi validation (400).
- The thermal presets (`small`/`medium`/`large`) share a common look: an inverted (white-on-black) title bar plus a rotated parent-zone location banner down the left edge — the Area for a container, the Property for an area. `sheet` is unchanged legacy geometry and prints the full location path as one line instead.
- All geometry lives in the `PRESETS` table at the top of `labels.service.js` — it is the single source of truth; renderers must not hard-code sizes.
- There is **no `/labels` page**. Printing is launched from a label dialog on the item, container, and area detail pages (`client/src/components/labels/label-print-dialog.tsx`), which shows a to-scale preview and downloads the PDF.

### Auto-Print (print-job queue + Raspberry Pi agent)

Labels can be queued for automatic printing on a USB thermal printer (Munbyn ITPP941) driven by a Raspberry Pi. The Pi **pulls** — it polls tally outbound, so there are no inbound firewall rules.

- **Two tables** (`SQL/migrations/003_print_jobs.sql`): `printer_agents` (one row per Pi) and `print_jobs`.
- **Jobs store parameters, not bytes.** A job records `{entityType, entityIds, preset}`; the PDF is rendered on demand when the agent fetches it, reusing the Phase 1 label renderers. Rendering happens **as the job's `CREATED_BY` user**, so the membership scoping of those renderers still applies.
- **Agent auth is a bearer token**, separate from session auth: `crypto.randomBytes(32)` with a `tp_` prefix, shown **once** at registration and stored only as a SHA-256 hash. An agent can do exactly three things — claim a job in its own property, fetch that job's PDF, ack it. It has no entity-reading surface.
- **The claim is atomic** (a generated `CLAIM_ID` is written then read back) and **self-healing** (claims older than 5 minutes are swept back to `queued` on the next claim, with the 3-attempt cap applied so a poison job cannot loop forever).
- **Roll state lives in tally, not on the Pi.** `printer_agents.LOADED_MEDIA` is the roll physically loaded; jobs whose preset doesn't match are `held` and released when that roll is loaded. Changing the roll also re-holds jobs queued for the old one.
- **`sheet` is never printable** — an Avery 5160 30-up Letter page is laser output, so it is rejected at queue time and stays download-only. `large` requires a container or area (it is a contents manifest).
- **Telemetry rides the claim request** (`printerState`, `printerStateReasons`), so "out of labels" surfaces in the UI instead of jobs failing mysteriously. Malformed telemetry is coerced to `unknown` — it can never fail a claim.
- **A `stopped` printer is dealt nothing** — the claim succeeds but returns no job, so a jammed printer stops consuming work instead of burning the 3-attempt cap; a job that dies mid-print is failed with reason `Printer stopped responding mid-job`.
- **`LAST_SEEN_AT` is stamped on every claim** and drives an `Offline · last seen <relative>` badge on `/print` (online = seen <60s ago). The queue poll must keep running or the badge goes stale exactly when it matters.
- **Agent tokens are tethered to `printer_agents.CREATED_BY`** (migration 009) — an agent registered by a since-removed property member stops authenticating.
- **Rate limiting:** the agent paths are exempted from the global 200/min limiter (via a segment-aware `skip`) and given their own 600/min budget, because draining a label batch fires claim+pdf+ack per label. The exemption must match on segment boundaries so the user-facing `/agents` routes stay limited.
- UI lives on the dedicated **`/print` page** (nav tab — job queue, agent status) and **Settings → Printing** (register, loaded roll), plus a **Send to printer** action in the label dialog. There is still no `/labels` page.

### Tags System (property-scoped, polymorphic)

- Tags are scoped to a property — each `tag` row references a `PROPERTY_ID`.
- Tags can be attached to any entity type (`item`, `container`, `area`) via the `entity_tags` join table (`ENTITY_TYPE` + `ENTITY_ID` columns).
- API: `GET /api/tags/_x_/property/:propertyId` lists all tags for a property; `POST /api/tags/_y_/entity` attaches a tag to an entity; `DELETE /api/tags/_d_/entity` removes it.
- The search endpoint (`GET /api/items/_x_/search`) accepts an optional `tagIds` query parameter (comma-separated) to filter results to items that have all specified tags.

## Phase 4 Features

### Lending

- Lending an item changes its `STATUS` to `'lent'`; returning it sets `STATUS` back to `'active'`.
- `POST /api/lending/_y_/lend` creates a loan record; `POST /api/lending/_y_/return/:loanId` closes it.
- `GET /api/lending/_x_/overdue` lists all loans past their due date across a property.
- Full loan history is available per item via `GET /api/lending/_x_/item/:itemId`.

### User-Defined Dates

- Each item can have any number of named date entries (e.g. "Warranty expiry", "Last service").
- Date types are user-defined strings — no fixed schema enumeration.
- `GET /api/dates/_x_/upcoming` returns items with dates falling within a configurable look-ahead window.

### Accessories

- Items can be linked as accessories of other items (many-to-many, within the same property).
- `POST /api/accessories/_y_/link` and `DELETE /api/accessories/_d_/unlink` manage the relationship.
- Accessory links are property-scoped — cross-property links are not permitted.

### Audit Trail

- All CRUD operations on core entities (properties, areas, containers, items) write an entry to the `audit_log` table automatically.
- `GET /api/audit/_x_/property/:propertyId` returns the full change log for a property.
- `GET /api/audit/_x_/entity/:entityType/:entityId` returns the history for a single entity.
- `GET /api/audit/_x_/recent` returns the most recent activity across all accessible properties.

### Notifications

- Two types exist, both produced by `checkDateNotifications` in `notifications.service.js`: `custom_date` (an `item_dates` row due within 30 days) and `lending_due` (an open `item_lending` past `DUE_AT`). The list is `NOTIFICATION_TYPES` in `notifications.schema.js`; the client's `notification-prefs.tsx` mirrors it. The DB enums still name four retired types (`warranty_expiry`, `item_moved`, `item_removed`, `share_expiring`) that nothing ever produced — do not resurface them without a producer (#348).
- Opt-in per type, **off by default**; preferences are per user (not per property) in `notification_preferences`. `create()` silently skips a type the user has not enabled.
- There is no scheduler. `GET /api/notifications/_x_/list` kicks `checkDateNotifications(userId)` fire-and-forget before it reads, so notifications appear on the next page load. Soft-deleted items (`items.DELETED_AT`) never notify.
- One notification per (user, type, entity, **due date**): `notifications.DUE_ON` (013) is the dedupe key and is UNIQUE, so a rescheduled date notifies once more and a concurrent check loses with `ER_DUP_ENTRY`, which is swallowed. Dismiss is soft (`DISMISSED_AT`) precisely so the dedupe marker survives it.
- Routes: `GET _x_/list` (`limit`/`offset`/`unreadOnly`), `GET _x_/unread-count`, `PATCH _p_/:id/read`, `PATCH _p_/read-all`, `DELETE _d_/:id` (dismiss), `GET _x_/preferences`, `PUT _u_/preferences` (`{type, enabled}`). All under `/api/notifications`, all `requireAuth`, all scoped to `req.user.id`.

### Recycle Bin

- Every soft-delete (single item, container cascade, area cascade) opens a **delete batch** (`004_delete_batches.sql`); members carry `DELETE_BATCH_ID`. The `/recycle-bin` page lists batches via `GET /api/recycle/_x_/list` (any member of the property; each row carries `canRestore`) and `POST /api/recycle/_y_/restore/:batchId` restores the whole batch — **owner only**, enforced in the service (403) because the batch, not the path, names the property (#347).
- **Retention is 30 days and is enforced by a lazy sweep, not a button.** `RecycleService.sweepIfDue()` runs fire-and-forget from the list route, at most once per 10 min per process, global (not per caller), bounded (25 batches + 200 pre-batch orphan items per sweep). `list`, `restore` and the sweep share one `RETENTION_DAYS`, so an aged-out batch is neither shown nor restorable by id. Items go through `ItemsService.permanentDelete` (child tables + object storage); containers/areas come out in FK order in one transaction; a batch with an open loan inside is skipped and logged. There is no scheduler in this app — this is the same pattern as `print.service sweepStaleClaims`. (`POST /api/items/_y_/purge-expired` and the client's "Purge Expired" button were removed with #347.)
- `GET /api/items/_x_/deleted` lists soft-deleted items for a property; `PATCH /api/items/_p_/:itemId/restore` recovers a single item; `DELETE /api/items/_d_/:itemId/permanent` removes one immediately (not `/purge`).

### Depreciation

- Depreciation is calculated **client-side on demand** — no server storage of depreciation values.
- Calculated from `purchase_price`, `purchase_date`, and a user-supplied depreciation rate/method.

## Phase 5 Features

### Reports

- 6 report types available: **insurance** (insured items with declared values), **total value** (aggregate value by location/category), **items by location** (full inventory tree), **lending** (active and historical loans), **activity log** (audit trail export), and **tag** (items grouped by tag).
- Reports can be exported as **PDF** (pdfkit, server-side rendered) or **CSV** (plain text, client can trigger download).
- API: `POST /api/reports/_y_/generate` accepts `{ type, format, propertyId, filters }` and returns the file as a download response.
- The `/reports` page lets users choose report type, output format, and optional filters before generating.

### Share Links

- Any item, container, area, or property can be shared via a **time-limited public link** — no authentication required for viewers.
- `POST /api/sharing/_y_/create` generates a share token with a configurable expiry (default 7 days). **The raw token appears exactly once — in the `url` of that response.** `share_links.TOKEN` holds `sha256(token)` (hex) with `TOKEN_HASHED = 1` (migration 014, #349); `validate` hashes the incoming token and matches only hashed rows. `GET /api/sharing/_x_/my-links` rows therefore carry no `url` and no `token`, and both clients (ShareDialog, Settings) show the address only in the freshly-created panel. A `TOKEN_HASHED = 0` row is one an old server wrote between 014 running and the dependent code deploying: it is dead and the expiry purge removes it.
- `GET /api/sharing/_x_/view/:token` resolves the token and returns a read-only view of the shared entity. **The creator must still be a member of the link's property** (inner join on `property_members`) — removing a member kills their links.
- `DELETE /api/sharing/_d_/:linkId` revokes a share link immediately — allowed to its **creator or any owner of the property** it exposes; a row that is neither yours nor there is a 404. `my-links` is scoped the same way (creator, or owner of the property) and purges expired rows before it lists.
- The link's property is resolved by one shared join chain (`LINK_PROPERTY_JOINS` / `LINK_PROPERTY_ID` in `sharing.service.js`): property → itself, area → `areas.PROPERTY_ID`, container → its area, item → its container's area.
- The error handler masks the token in the logged URL by route shape (`SENSITIVE_PATH_PREFIXES` in `middleware/error-handler.js`) — `req.params` is already `{}` by the time an app-level error handler runs, so redacting params alone would not have helped.
- Share links are stored in the `share_links` table with `TOKEN` (digest), `TOKEN_HASHED`, `ENTITY_TYPE`, `ENTITY_ID`, `EXPIRES_AT`, `CREATED_BY`, and `DISCLOSURE` columns.
- The client renders shared content on a standalone `/share/:token` page — no nav, no auth, no sidebar.
- **What a link publishes is a per-link choice**, catalogued in `server/src/modules/sharing/sharing.disclosure.js` — the single source of truth for both the sharer-facing list (`GET /api/sharing/_x_/disclosure`, read by `ShareDialog`) and the strip applied when the public payload is built (`applyDisclosure`, called once in `getEntityForShare`). Add a field to the public payload → add it to that catalogue, or it can never be withheld.
- **Every category defaults to ON**, and each states so explicitly via `defaultOn` in that catalogue — changing what a *new* share publishes by default is that one line, nothing else. #298 asked specifically about the property address and the purchase price; Luke's answer was on for both, same as every other category, with opt-out left to the per-link dialog.
- **A default applies at link-creation time only — never on read.** `resolve()` must never consult `defaultOn`: `share_links.DISCLOSURE` NULL means "everything" and a key missing from a stored object means "on", *permanently*, so flipping a default cannot retroactively change what an already-issued URL publishes. `sharing.disclosure.test.js` flips every default to `false` and asserts no existing link moves; do not "simplify" the NULL handling past it.
- **The public payload is not a dump of the row.** Fields nothing on `/share/:token` renders are deliberately absent: no `recordedByName` on condition snapshots, no `purchasePrice` on the items of a property/area/container share (the item share carries its own, which `ItemView` shows), no depreciation fields, no `productSpecs`.

### Diagnosing "AI photos aren't working"

The feature fails **silently by design**, at two layers: `config.js` lists
`ANTHROPIC_API_KEY` in `optionalFeatureVars`, so a missing key warns and never
throws; `vision.http.js` then answers `200 {available:false, suggestion:null}` —
a *successful* response. Capture keeps working and simply stops offering names.
An upstream API failure and the model honestly declining also produce the same
thing on screen. So "nothing happens" is the only symptom for several very
different causes, and the order below is the cheap-to-expensive way to separate
them.

**1. Is it configured at all?** One unauthenticated request:

```bash
curl -s https://tally.razorwire-productions.com/health/ready
# → "vision":"enabled" | "disabled"   (also "match")
```

`disabled` means no `ANTHROPIC_API_KEY` in the container. The key lives in the
Vault bundle the deploy writes `.env` from, and is declared in `pw.json`
`external_secrets` (NOT `secrets` — that list is auto-generated and fail-closed;
an operator-supplied key there would be overwritten with a random string and
would fail every deploy until populated). Fill it with:

```bash
vault kv patch secret/apps/tally/prod ANTHROPIC_API_KEY=<key>
```

**`patch`, never `put`** — `put` replaces the whole bundle and takes
`MYSQL_ROOT_PASSWORD`, the S3 keys and `COOKIE_SECRET` with it. (KV-v2 CLI paths
omit `data/`.) Or PW UI → tally → Secrets → prod.

**2. Is it the browser, not the server?** There is a per-device on/off switch
(`client/src/store/vision-store.ts`, persisted, default on). If it fails on one
device and works on another, that is the cause.

**3. Otherwise it is the upstream call, and only the logs distinguish why.**
PW UI → tally → prod → Logs (service `app`), or:

```bash
curl -s "http://10.0.5.42:8500/api/_x_/apps/tally/envs/prod/server-logs/snapshot?service=app&lines=500" \
  -H "Authorization: Bearer $ORCHESTRATOR_API_KEY" | grep -i vision
```

| Log line | Level | Means |
|---|---|---|
| `Vision identify failed` | error | The call threw — rejected key, model id the account cannot reach, refused request shape, or the 12s timeout. Names the model attempted. |
| `Vision identify produced no usable result` | error | Billed, returned nothing usable (e.g. truncation). |
| `Vision identify complete` | info | Working; the model declined this photo. **Invisible in prod** — the console transport emits at `error` only. |

None of the three means the request never reached the service.

**Ruled out on 2026-08-30, so don't re-derive:** the model default
`claude-sonnet-5` is current and `VISION_MODEL` is unset in `pw.json`; the
server image builds with `npm ci --production`, so the SDK is lockfile-pinned
and cannot drift on a redeploy; and the 2026-08 UniFi firewall audit deleted no
tally egress rule (its 8 deletions were `Servers→Tally :22/:80`, the IMP-side
rules, the IMP-DEV superset, `THD to EMP_DB`, Airplay and Internal-to-Work).

### Deployment (PW v2)

- Tally deploys via the **PW v2 contract** — `pw.json` in the repo root is the single deployment manifest (services `app`/`db`/`storage`/`web`, secrets, health check `/health/ready`). No `app.yml`, no dual-repo manifest sync: the orchestrator clones this repo fresh and reads `pw.json`.
- `pw.json` contains no IPs, VLANs, VMIDs, or Ansible groups — the PW registry owns those. Production is a single Docker Compose VM at **10.0.135.10 (VLAN 135, VMID 132)**. (Not VLAN 130 — that was a placeholder in the Phase 5 plan doc; `docs/entra-id-setup.md` still carries stale `10.0.130.x` IPs.)
- Local development uses `docker-compose.yml` + Taskfile, unrelated to the prod manifest.

### CI/CD (GitHub Actions + PW Orchestrator)

**Workflows:**
- **`ci.yml`** — runs on every pull request: client (`tsc --noEmit`, ESLint, `npm test` = vitest, `npm run build`), server (ESLint, syntax check, `npm test` = `node --test`), `npm audit --production --audit-level=high`, and the **Migration Gate** (rule 9). Blocks merge on failure.
- **`build.yml`** — runs on push to `master`: smoke-builds client + server on the self-hosted runner (gates only — no artifacts; the orchestrator does its OWN build from a fresh git clone, #352), then triggers `POST /api/_y_/apps/tally/envs/prod/v2/deploy` and polls the operation.
- **`gitleaks.yml`** / **`trivy.yml`** — secret scanning + CVE/misconfig gates on every PR whatever its base, plus push to master and (trivy) weekly (#351).
- All jobs use the `.github/actions/setup-node` composite action.

**Required GitHub Config:**
- Repository variable: `ORCHESTRATOR_URL` = `http://10.0.5.42:8500`
- Repository secret: `ORCHESTRATOR_API_KEY` = the orchestrator admin token
- Self-hosted runner: `tally-runner-shared` registered at `/opt/actions-runner-tally` on VMID 105

### CI/CD Rules — READ BEFORE MAKING CHANGES

These rules exist because every one of them was learned from a production failure. Do not skip them.

#### Contract Rules (`pw.json`)

1. **`pw.json` in this repo root is the ONLY manifest — with one exception that must not be deleted.** Tally is on the PW v2 contract: there is no dual-repo manifest sync, and the orchestrator clones this repo fresh and reads `pw.json`. BUT `orchestrator/apps/tally/app.yml` in the PW repo is **not** inert legacy — line 36 carries `adminDb: "TALLY"`, and `pw.json` has no equivalent field. That single line is what makes `migrate-all` record into `TALLY.schema_migrations` instead of falling back to its `<APP>_ADMIN` default; delete the file and the migration ledger silently moves to a stray `TALLY_ADMIN` database, so the next `migrate-all` sees zero applied migrations and re-runs the whole chain (survivable only because every migration here is idempotent — see rule 16). Leave it in place until `adminDb` has a home in `pw.json`. `pw.json` contains no IPs, VLANs, VMIDs, or Ansible groups — the PW registry owns those.

2. **Build steps run with `NODE_ENV=development`** — the orchestrator PM2 process runs `NODE_ENV=production` (ecosystem.config.js), inherited by child processes; the v2 executor overrides it during the build phase so `npm ci` installs devDependencies. Don't add check/build commands that assume devDeps outside the declared `pw.json` build steps.

3. **Check commands MUST use `./node_modules/.bin/` paths** — never `npx`. On the orchestrator VM, `npx tsc` resolves to a global npm shim that prints "This is not the tsc command you are looking for" instead of the project-local TypeScript compiler. Always use `./node_modules/.bin/tsc`, `./node_modules/.bin/eslint`, etc.

4. **`pw.json`'s `services.app.healthCheck.path` (`/health/ready`) must match the Express app** — the deploy flow verifies it post-deploy and auto-rolls back on failure. If you change the endpoint, change `pw.json` in the same PR.

#### Build & Deploy Flow Rules

5. **There are TWO build pipelines — they MUST produce equivalent results.** GH Actions `build.yml` smoke-builds on the self-hosted runner (nothing it produces is shipped). The orchestrator builds on the orchestrator VM from a fresh clone and that build is what runs. Different Node versions, npm versions, or OS libraries can cause one to succeed and the other to fail. When changing build commands (`pw.json` build steps or `build.yml`), test both paths.

6. **`npm audit` in CI can block all PRs** — if a new high-severity advisory is published for any transitive dependency, all PRs fail until resolved. This is intentional (security gate) but can be temporarily bypassed by pinning the vulnerable package or adding an audit exception. Do NOT revert to `|| true`.

7. **The deploy job polls the orchestrator op for up to 15 min (90 × 10s) inside a 20-min job timeout** (the trigger curl itself is `--max-time 30` with 3 retries) — a slow deploy can outlive the poll and report failure in GH Actions while succeeding on the orchestrator. The orchestrator operation status is the source of truth, not the GH Actions status.

#### Database Migrations — NOT part of deploy

8. **`Build & Deploy` never runs migrations.** The orchestrator's deploy op updates containers only; applying schema is a *separate* op (`executor.js` says so explicitly). A PR that adds a migration will deploy green and then 500 on every endpoint touching the new tables. After merging any migration, run:

    ```bash
    curl -X POST http://10.0.5.42:8500/api/_y_/apps/tally/envs/prod/db/migrate-all \
      -H "Authorization: Bearer $ORCHESTRATOR_API_KEY" \
      -H 'Content-Type: application/json' -d '{"ref":"master"}'
    ```

    `migrate-all` auto-applies: it diffs `SQL/migrations/` against `schema_migrations` on the target and applies what's pending, in order. It takes a pre-migration `mysqldump` first. **The orchestrator is only reachable from the management VLAN (10.0.5.0/24)** — not from a normal client machine.

9. **Migrations MUST be idempotent.** The playbook stops at the first error, so one failing migration blocks every later one behind it. This is not hypothetical: 002 added indexes that were later folded into `SQL/init/001_TALLY_Init.sql`, so it died with `ERROR 1061 Duplicate key name` on any database built from the current base schema — and blocked 003, leaving the print tables absent while the deploy reported success. MySQL 8 has no `ADD KEY ... IF NOT EXISTS`; guard with an `information_schema` check plus a prepared statement (see 002 for the pattern). Prefer `CREATE TABLE IF NOT EXISTS` for new tables.

    **This is now enforced, not remembered.** The `Migration Gate` job in `ci.yml` is a required check: on any PR touching `SQL/` it boots MySQL 8.4, applies `SQL/init/001_TALLY_Init.sql` + the whole chain, applies **the whole chain again** and requires it to succeed, then byte-compares the resulting schema against the committed `SQL/expected-schema.sql`. Run it locally with `SQL/ci/migration-gate.sh` (needs only docker).

    **Every PR that adds or changes a migration must regenerate the expected schema** — `SQL/ci/migration-gate.sh --write` — and commit `SQL/expected-schema.sql` alongside it, or the gate fails on drift. Drift is not a nuisance: the base schema silently growing ahead of the chain is what made 002 fatal.

10. **Local dev applies migrations via `SQL/init/002_apply_migrations.sh`.** `docker-compose` mounts `SQL/migrations/` at `/docker-entrypoint-migrations/` and that script applies them after the base schema — MySQL's entrypoint ignores subdirectories, so they cannot simply be mounted alongside `init/`. Without this, `task db:reset` produces a database with *no* migrations applied.

#### Object storage: presigned URLs and the proxy in front of them

11. **`client/nginx.conf` is NOT what serves production.** It has a correct `location ^~ /tally-files/` MinIO proxy and has since the first commit — but prod is fronted by the PW deployment's own nginx, which serves the built client statically and proxies only `/api` and `/health`. Verified 2026-08-07: `GET https://tally.<domain>/tally-files/anything` returns `index.html` from disk (`etag`, `last-modified`, `content-type: text/html`), not a proxy response. **Editing `client/nginx.conf` changes local dev only.** Routing changes for prod belong in the `web` (nginx) service config in `pw.json` / PW's nginx service-catalog template.

11a. **`server/Dockerfile` and `client/Dockerfile` are NOT what runs in production either** — only local `docker-compose.yml` builds them. Prod is the stock `node:22-bookworm-slim` image named in `pw.json` `environments.prod.services.app` with `./server` bind-mounted and `node index.js` as PID 1 (as root, no init — #370), fronted by PW's pinned `nginx:alpine` catalog image. When you change the Node major, `NODE_ENV`, the health probe or a runtime apt package, change `pw.json` (prod) AND the Dockerfile (local) together, or `sharp`'s native binary and friends will differ between the two. `poppler-utils` is a CI-only dependency (the label geometry test), not a runtime one (#353).

12. **A presigned URL is bound to the host it was signed for.** SigV4 signs the `Host` header, so the browser must reach MinIO at *the same* host the server signed against, and every proxy in the chain must forward `Host` unchanged (`proxy_set_header Host $host;` — **not** `$proxy_host`). A mismatch surfaces as `SignatureDoesNotMatch`, which names the key and bucket and says nothing about the host, so it reads like a credentials problem and is not one.

13. **`S3_PUBLIC_ENDPOINT` must be an origin, with no path.** With `forcePathStyle` the SDK builds `/{bucket}/{key}` itself, so a path on the endpoint gets signed twice (`/tally-files/tally-files/key` → `NoSuchKey`). `storage.js` strips a trailing copy of the bucket and warns; any other path is left alone but warned about, because it only works if the proxy forwards the path byte for byte. When unset it falls back to `S3_ENDPOINT`, which is the internal service name — links the browser can never load, which is why uploaded photos appeared nowhere for so long.

#### Environment & Secrets

14. **GitHub repo secrets must be configured for the deploy step** — `ORCHESTRATOR_URL` (variable) and `ORCHESTRATOR_API_KEY` (secret). Missing secrets cause the deploy step to silently send empty auth headers and empty URLs, which fail with unhelpful curl exit codes.

15. **After every push, check GH Actions run status** — `gh run list --limit 3`. If a run fails, diagnose and fix BEFORE pushing more commits. Stacking fixes on failures creates queued broken runs. Cancel stale runs with `gh run cancel <id>`. Never leave a failed run uninvestigated.

16. **The self-hosted runner must be registered for this repo** — a new runner registration requires: (a) `gh api -X POST repos/lukeRWP/tally/actions/runners/registration-token`, (b) configure at `/opt/actions-runner-tally` on the runner VM, (c) install as systemd service. If the runner is offline, GH Actions jobs queue indefinitely.

## Tally v1.0 — Complete Feature Set

| Phase | Key Features |
|-------|-------------|
| **Phase 1** — Core Inventory | Properties, Areas, Containers (closure-table hierarchy), Items (CRUD + FULLTEXT search), React frontend with Radix UI + Tailwind v4, Microsoft Entra ID (OIDC) auth, MySQL + MinIO infrastructure, Docker Compose stack |
| **Phase 2** — Files & Products | File upload/download (presigned MinIO URLs), Condition snapshots (photo + rating history), Product catalog with barcode lookup (Open Food Facts + UPC Database), camera barcode scanning (`html5-qrcode`) |
| **Phase 3** — Labels & Tags | QR code generation (`TLY-{TYPE}-{HEX}` format), PDF label printing with 4 presets (2×1 item tag, 3×3 bin/location tag, 4×6 contents manifest, Avery 5160 sheet), QR deep-link resolution, Scan-Scan-Done move workflow, polymorphic tag system (property-scoped, works across items/containers/areas) |
| **Phase 4** — Advanced Features | Lending (lend/return/overdue tracking), User-defined dates (warranty, service, etc.) with upcoming alerts, Accessories (item-to-item links), Audit trail (full change log), Notifications (opt-in, per-type preferences), Recycle bin (30-day soft delete), Client-side depreciation calculation |
| **Phase 5** — Reports, Sharing & Deployment | 6 report types in PDF/CSV, Time-limited public share links (no-auth viewer page), PW v2 `pw.json` deployment (VLAN 135), GitHub Actions CI (`ci.yml`) + build+deploy (`build.yml`) pipeline |

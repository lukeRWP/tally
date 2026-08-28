# Tally

Collaborative home inventory management system. Track items across containers and locations in your home, with QR code scanning, full-text search, and multi-user support.

## Tech Stack

| Layer      | Technology                                      |
|------------|-------------------------------------------------|
| Frontend   | React 18 + TypeScript                           |
| UI         | Radix UI primitives + Tailwind CSS v4           |
| Icons      | Lucide React                                    |
| Fonts      | Inter (body), JetBrains Mono (code/labels)      |
| Backend    | Express.js (Node)                               |
| Database   | MySQL 8.0                                       |
| Storage    | MinIO (S3-compatible object storage)            |
| Auth       | Microsoft Entra ID (OIDC)                       |
| Container  | Docker Compose                                  |

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

## Project Structure

```
tally/
├── client/                       # React frontend (Vite + TypeScript)
│   ├── src/
│   │   ├── components/
│   │   │   ├── inventory/        # Entity cards (property, area, container, item)
│   │   │   ├── layout/           # Root layout, header, bottom-nav, breadcrumbs
│   │   │   └── ui/               # Shared primitives (button, card, badge, dialog, input, skeleton, toast)
│   │   ├── hooks/                # use-auth.ts, use-inventory.ts
│   │   ├── lib/                  # api.ts, query-client.ts, utils.ts
│   │   ├── pages/                # home, inventory, property-detail, area-detail, container-detail, item-detail, login, oauth-callback, scan, reports, settings
│   │   ├── store/                # auth-store.ts (Zustand)
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
│       │   ├── error-handler.js  # Global error handler
│       │   └── validate.js       # Joi validation middleware helper
│       ├── modules/
│       │   ├── auth/             # auth.routes, auth.service, auth.middleware, auth.schema
│       │   └── inventory/        # properties, areas, containers, items (routes/service/schema each)
│       │       └── closure-table.service.js  # Shared closure-table helpers for container hierarchy
│       ├── repositories/
│       │   └── BaseRepository.js
│       └── utils/
│           ├── logger.js         # Winston logger (DailyRotateFile in prod)
│           ├── qr.js             # QR code generation (TLY-{TYPE}-{HEX} format)
│           └── response.js       # success() / error() response helpers
├── SQL/
│   └── init/
│       └── 001_TALLY_Init.sql    # Full schema: 20 tables
├── docker-compose.yml            # 5 services: tally-db, tally-minio, tally-server, tally-client, tally-nginx
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
| properties  | `/api/properties` | CRUD + member management                                   |
| areas       | `/api/areas`      | CRUD scoped to a property                                  |
| containers  | `/api/containers` | CRUD + move (uses closure table for hierarchy)             |
| items       | `/api/items`      | CRUD + move + FULLTEXT search                              |
| products    | `/api/products`   | Barcode lookup, catalog CRUD, duplicate check, text search |
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
require('./src/modules/tags/tags.routes')({ app, db, logger, config });
require('./src/modules/labels/labels.routes')({ app, db, logger, config });
require('./src/modules/lending/lending.routes')({ app, db, logger, config });
require('./src/modules/dates/dates.routes')({ app, db, logger, config });
require('./src/modules/accessories/accessories.routes')({ app, db, logger, config });
require('./src/modules/audit/audit.routes')({ app, db, logger, config });
require('./src/modules/notifications/notifications.routes')({ app, db, logger, config });
require('./src/modules/reports/reports.routes')({ app, db, logger, config });
require('./src/modules/sharing/sharing.routes')({ app, db, logger, config });
```

## Phase 2 Infrastructure & Integrations

### MinIO Object Storage

- MinIO is an S3-compatible object store running as a Docker service (`tally-minio`).
- The server calls `storage.ensureBucket()` on startup to auto-create the configured bucket if it does not exist.
- File downloads use **presigned URLs** — the server generates a time-limited URL and returns it to the client; the client fetches the file directly from MinIO. The Express server never streams file bytes.
- Upload flow: client sends `multipart/form-data` (NOT JSON) to `POST /api/files/_y_/upload`; the server pipes the stream to MinIO via the `minio` SDK.

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

## Authentication

- Provider: Microsoft Entra ID (Azure AD) via OIDC with PKCE
- Sessions stored in MySQL (`TALLY.sessions`) — no Redis
- Session token sent as an httpOnly signed cookie (`session_token`)
- Set `BYPASS_AUTH=true` in `.env` to skip real auth during local development (auto-creates a dev user + session)
- User identity (`req.user`) is injected into all request contexts after `requireAuth` middleware

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

Scanning a TLY code navigates to `/s/TLY-X-XXXX` on the client. The `ScanRedirectPage` component calls `GET /api/labels/_x_/resolve/:code`, which decodes the entity type and ID from the code and returns the canonical deep-link path (e.g. `/items/42`). The client then redirects to that path automatically.

### Scan-Scan-Done Workflow (Move Mode)

`/move` (not `/scan`) is a station you stay at, with two modes:

1. **Gather** — while carrying a load, scan a bin/area to land the whole load (unchanged `PATCH /api/items/_p_/:id/move` / `.../containers/_p_/:id/move`), or scan an item/bin not already in hand to add it to the load (`Carrying N`).
2. **Distribute** — after a landing, the destination stays **pinned** as a banner instead of navigating away. Scanning an item/bin now moves it straight to the pin (`Moved N to X`, with a toast Undo); scanning a new bin/area re-pins instead — nothing moves.
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
- **Rate limiting:** the agent paths are exempted from the global 200/min limiter (via a segment-aware `skip`) and given their own 600/min budget, because draining a label batch fires claim+pdf+ack per label. The exemption must match on segment boundaries so the user-facing `/agents` routes stay limited.
- UI lives in **Settings → Printing** (register, loaded roll, job queue) plus a **Send to printer** action in the label dialog. There is still no `/labels` page.

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

- Notifications are opt-in per type — all notification types are **off by default**.
- Preferences are stored per user per property in `notification_preferences`.
- `GET /api/notifications/_x_/list` returns unread notifications for the current user.
- `POST /api/notifications/_y_/mark-read` marks one or all notifications as read.
- `GET /api/notifications/_x_/preferences` and `PUT /api/notifications/_u_/preferences` manage per-type opt-in settings.
- Date-based notifications (e.g. upcoming warranty expiry) are triggered by `GET /api/notifications/_x_/check-dates` and respect the user's preferences.

### Recycle Bin

- Soft-deleted items are retained for 30 days before permanent purge.
- `GET /api/items/_x_/deleted` lists all soft-deleted items for a property.
- `PATCH /api/items/_p_/:itemId/restore` recovers a soft-deleted item.
- `DELETE /api/items/_d_/:id/purge` permanently removes a soft-deleted item immediately.
- Automatic purge of items older than 30 days is handled server-side.

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
- `POST /api/sharing/_y_/create` generates a share token with a configurable expiry (default 7 days).
- `GET /api/sharing/_x_/:token` resolves the token and returns a read-only view of the shared entity.
- `DELETE /api/sharing/_d_/:token` revokes a share link immediately.
- Share links are stored in the `share_links` table with `TOKEN`, `ENTITY_TYPE`, `ENTITY_ID`, `EXPIRES_AT`, and `CREATED_BY` columns.
- The client renders shared content on a standalone `/share/:token` page — no nav, no auth, no sidebar.

### Deployment

- **Proxmox / Portainer Workloads app manifest** (`deploy/app.yml`) defines the full production stack: `tally-db`, `tally-minio`, `tally-server`, `tally-client`, `tally-nginx`.
- Production is deployed on **VLAN 130** within the Proxmox homelab environment.
- The manifest is production-only and is not used for local development (use `docker-compose.yml` + Taskfile for local work).

### CI/CD (GitHub Actions + PW Orchestrator)

**Workflows:**
- **`ci.yml`** — runs on every pull request: `tsc --noEmit`, ESLint, syntax checks, `npm audit`. Blocks merge on failure.
- **`build.yml`** — runs on push to `master`: builds client/server/db tarballs on the self-hosted runner, then triggers the PW orchestrator to deploy. The orchestrator does its OWN build from a fresh git clone (the GH Actions artifacts are retained for debugging but not consumed by the orchestrator).

**Required GitHub Config:**
- Repository variable: `ORCHESTRATOR_URL` = `http://10.0.5.42:8500`
- Repository secret: `ORCHESTRATOR_API_KEY` = the orchestrator admin token
- Self-hosted runner: `tally-runner-shared` registered at `/opt/actions-runner-tally` on VMID 105

### CI/CD Rules — READ BEFORE MAKING CHANGES

These rules exist because every one of them was learned from a production failure. Do not skip them.

#### Manifest Rules (`app.yml`)

1. **`app.yml` exists in TWO repos** — this repo AND `prevailing-winds/orchestrator/apps/tally/app.yml`. The orchestrator reads the PW copy, NOT the Tally copy. **Any change to `app.yml` in this repo MUST be copied to the PW repo and deployed to the orchestrator.** Failure to sync means the orchestrator deploys with stale config.

2. **`build.env` MUST set `NODE_ENV: development`** — the orchestrator PM2 process runs with `NODE_ENV=production` (from ecosystem.config.js). This is inherited by child processes via `process.env`. If `build.env` doesn't override it, `npm ci` skips devDependencies and check steps (TypeScript, ESLint) fail because their binaries aren't installed. The target VM's deploy task runs `npm ci --production` separately to strip devDeps.

3. **Check commands MUST use `./node_modules/.bin/` paths** — never `npx`. On the orchestrator VM, `npx tsc` resolves to a global npm shim that prints "This is not the tsc command you are looking for" instead of the project-local TypeScript compiler. Always use `./node_modules/.bin/tsc`, `./node_modules/.bin/eslint`, etc.

4. **`build.components.*.tarball.includes` must match `build.yml`** — the GH Actions build.yml creates tarballs with explicit file lists. The orchestrator uses `app.yml`'s tarball config. If a new file is added to the server (e.g., `knexfile.js`), both must be updated. They are separate definitions in separate repos.

5. **`ansibleGroups` must follow the pattern `{appName}_{role}s`** — the executor constructs group names as `${appName}_servers`, `${appName}_clients`, etc. and passes them as Ansible extra-vars. If `ansibleGroups` in app.yml uses different names, the playbook's `hosts:` directive won't match any hosts. All plays skip silently (exit 0) and nothing deploys.

6. **`healthChecks.server.path` must match the actual health endpoint** — the deploy playbook uses this for post-deploy verification. The app-server role also hardcodes `/health/live` in its rollback health check. If you change the health endpoint path in the Express app, update BOTH app.yml and notify the PW team to update the deploy role.

#### Build & Deploy Flow Rules

7. **There are TWO build pipelines — they MUST produce equivalent results.** GH Actions `build.yml` builds on the self-hosted runner. The orchestrator builds on the orchestrator VM from a fresh clone. Different Node versions, npm versions, or OS libraries can cause one to succeed and the other to fail. When changing build commands, test both paths.

8. **`build.yml` sets `NODE_ENV: production` for the client build step, but `app.yml` sets `NODE_ENV: development`** — these are intentionally different. build.yml's NODE_ENV only affects the Vite build (tree-shaking, dead code). app.yml's NODE_ENV affects `npm ci` (must be development to get devDeps). Do not "fix" this discrepancy — it is correct.

9. **`npm audit` in CI can block all PRs** — if a new high-severity advisory is published for any transitive dependency, all PRs fail until resolved. This is intentional (security gate) but can be temporarily bypassed by pinning the vulnerable package or adding an audit exception. Do NOT revert to `|| true`.

10. **The deploy step's curl timeout (16 min) is shorter than the orchestrator's deploy timeout (20 min)** — a slow deploy can succeed on the orchestrator but report failure in GH Actions. This is a known gap. The orchestrator operation status is the source of truth, not the GH Actions status.

#### Database Migrations — NOT part of deploy

15. **`Build & Deploy` never runs migrations.** The orchestrator's deploy op updates containers only; applying schema is a *separate* op (`executor.js` says so explicitly). A PR that adds a migration will deploy green and then 500 on every endpoint touching the new tables. After merging any migration, run:

    ```bash
    curl -X POST http://10.0.5.42:8500/api/_y_/apps/tally/envs/prod/db/migrate-all \
      -H "Authorization: Bearer $ORCHESTRATOR_API_KEY" \
      -H 'Content-Type: application/json' -d '{"ref":"master"}'
    ```

    `migrate-all` auto-applies: it diffs `SQL/migrations/` against `schema_migrations` on the target and applies what's pending, in order. It takes a pre-migration `mysqldump` first. **The orchestrator is only reachable from the management VLAN (10.0.5.0/24)** — not from a normal client machine.

16. **Migrations MUST be idempotent.** The playbook stops at the first error, so one failing migration blocks every later one behind it. This is not hypothetical: 002 added indexes that were later folded into `SQL/init/001_TALLY_Init.sql`, so it died with `ERROR 1061 Duplicate key name` on any database built from the current base schema — and blocked 003, leaving the print tables absent while the deploy reported success. MySQL 8 has no `ADD KEY ... IF NOT EXISTS`; guard with an `information_schema` check plus a prepared statement (see 002 for the pattern). Prefer `CREATE TABLE IF NOT EXISTS` for new tables.

17. **Local dev applies migrations via `SQL/init/002_apply_migrations.sh`.** `docker-compose` mounts `SQL/migrations/` at `/docker-entrypoint-migrations/` and that script applies them after the base schema — MySQL's entrypoint ignores subdirectories, so they cannot simply be mounted alongside `init/`. Without this, `task db:reset` produces a database with *no* migrations applied.

#### Object storage: presigned URLs and the proxy in front of them

18. **`client/nginx.conf` is NOT what serves production.** It has a correct `location ^~ /tally-files/` MinIO proxy and has since the first commit — but prod is fronted by the PW deployment's own nginx, which serves the built client statically and proxies only `/api` and `/health`. Verified 2026-08-07: `GET https://tally.<domain>/tally-files/anything` returns `index.html` from disk (`etag`, `last-modified`, `content-type: text/html`), not a proxy response. **Editing `client/nginx.conf` changes local dev only.** Routing changes for prod belong in the PW repo, exactly like `app.yml` (rule 1).

19. **A presigned URL is bound to the host it was signed for.** SigV4 signs the `Host` header, so the browser must reach MinIO at *the same* host the server signed against, and every proxy in the chain must forward `Host` unchanged (`proxy_set_header Host $host;` — **not** `$proxy_host`). A mismatch surfaces as `SignatureDoesNotMatch`, which names the key and bucket and says nothing about the host, so it reads like a credentials problem and is not one.

20. **`S3_PUBLIC_ENDPOINT` must be an origin, with no path.** With `forcePathStyle` the SDK builds `/{bucket}/{key}` itself, so a path on the endpoint gets signed twice (`/tally-files/tally-files/key` → `NoSuchKey`). `storage.js` strips a trailing copy of the bucket and warns; any other path is left alone but warned about, because it only works if the proxy forwards the path byte for byte. When unset it falls back to `S3_ENDPOINT`, which is the internal service name — links the browser can never load, which is why uploaded photos appeared nowhere for so long.

#### Adding New Server Files

11. **If you add a new top-level file the server needs at runtime** (e.g., a config file, seed script), you must update THREE places: (a) `app.yml` `build.components.server.tarball.includes`, (b) `build.yml` tar command, (c) `.dockerignore` if applicable.

#### Environment & Secrets

12. **GitHub repo secrets must be configured for the deploy step** — `ORCHESTRATOR_URL` (variable) and `ORCHESTRATOR_API_KEY` (secret). Missing secrets cause the deploy step to silently send empty auth headers and empty URLs, which fail with unhelpful curl exit codes.

13. **After every push, check GH Actions run status** — `gh run list --limit 3`. If a run fails, diagnose and fix BEFORE pushing more commits. Stacking fixes on failures creates queued broken runs. Cancel stale runs with `gh run cancel <id>`. Never leave a failed run uninvestigated.

14. **The self-hosted runner must be registered for this repo** — a new runner registration requires: (a) `gh api -X POST repos/lukeRWP/tally/actions/runners/registration-token`, (b) configure at `/opt/actions-runner-tally` on the runner VM, (c) install as systemd service. If the runner is offline, GH Actions jobs queue indefinitely.

## Tally v1.0 — Complete Feature Set

| Phase | Key Features |
|-------|-------------|
| **Phase 1** — Core Inventory | Properties, Areas, Containers (closure-table hierarchy), Items (CRUD + FULLTEXT search), React frontend with Radix UI + Tailwind v4, Microsoft Entra ID (OIDC) auth, MySQL + MinIO infrastructure, Docker Compose stack |
| **Phase 2** — Files & Products | File upload/download (presigned MinIO URLs), Condition snapshots (photo + rating history), Product catalog with barcode lookup (Open Food Facts + UPC Database), camera barcode scanning (`html5-qrcode`) |
| **Phase 3** — Labels & Tags | QR code generation (`TLY-{TYPE}-{HEX}` format), PDF label printing with 4 presets (2×1 item tag, 3×3 bin/location tag, 4×6 contents manifest, Avery 5160 sheet), QR deep-link resolution, Scan-Scan-Done move workflow, polymorphic tag system (property-scoped, works across items/containers/areas) |
| **Phase 4** — Advanced Features | Lending (lend/return/overdue tracking), User-defined dates (warranty, service, etc.) with upcoming alerts, Accessories (item-to-item links), Audit trail (full change log), Notifications (opt-in, per-type preferences), Recycle bin (30-day soft delete), Client-side depreciation calculation |
| **Phase 5** — Reports, Sharing & Deployment | 6 report types in PDF/CSV, Time-limited public share links (no-auth viewer page), PW app.yml deployment manifest (VLAN 130), GitHub Actions CI (`ci.yml`) + build+deploy (`build.yml`) pipeline |

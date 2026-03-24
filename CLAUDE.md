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
| labels        | `/api/labels`        | QR generation, PDF/ZPL label printing, code resolution     |
| lending       | `/api/lending`       | Lend, return, history, overdue tracking                    |
| dates         | `/api/dates`         | User-defined date types per item, upcoming dates           |
| accessories   | `/api/accessories`   | Link/unlink items as accessories                           |
| audit         | `/api/audit`         | Change log, activity feed by property/entity/recent        |
| notifications | `/api/notifications` | List, mark read, preferences, date-based checks            |

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

The scan page supports a two-scan move flow:

1. First scan — select a destination container (enters "move mode", shown as an amber banner).
2. Second scan — scan an item; it is immediately moved to the selected container via `PATCH /api/items/_p_/:id/move`.
3. Repeat step 2 to move more items to the same destination, or cancel move mode to start over.

This allows rapid relocation of many items without navigating away from the scan page.

### Label Printing (PDF Avery sheets + ZPL thermal)

- `POST /api/labels/_y_/generate` — accepts an array of `{ entityType, entityId }` objects and returns either a PDF (Avery 5160 / 30-up sheet layout) or a ZPL string for thermal printers, depending on the `format` field (`pdf` | `zpl`).
- PDF labels are generated server-side using `pdfkit` and returned as `application/pdf`.
- ZPL labels are plain text returned as `text/plain`, ready to spool directly to a Zebra-compatible printer.
- The label UI (`/labels`) lets users build a print queue, choose format, and download or print.

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
- `POST /api/items/_y_/:id/restore` recovers a soft-deleted item.
- `DELETE /api/items/_d_/:id/purge` permanently removes a soft-deleted item immediately.
- Automatic purge of items older than 30 days is handled server-side.

### Depreciation

- Depreciation is calculated **client-side on demand** — no server storage of depreciation values.
- Calculated from `purchase_price`, `purchase_date`, and a user-supplied depreciation rate/method.

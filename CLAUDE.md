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

All modules are registered in `server/index.js` via:

```js
require('./src/modules/auth/auth.routes')({ app, db, logger, config });
require('./src/modules/inventory/properties.routes')({ app, db, logger, config });
require('./src/modules/inventory/areas.routes')({ app, db, logger, config });
require('./src/modules/inventory/containers.routes')({ app, db, logger, config });
require('./src/modules/inventory/items.routes')({ app, db, logger, config });
```

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

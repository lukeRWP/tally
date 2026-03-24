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
task db:shell     # Open MySQL shell in TALLY database
```

## Project Structure

```
tally/
├── client/               # React frontend
│   └── src/
│       ├── components/   # Shared UI components
│       ├── modules/      # Feature modules (mirrors server)
│       └── lib/          # Utilities, API client
├── server/               # Express backend
│   └── src/
│       ├── modules/      # Feature modules
│       ├── lib/          # Shared utilities
│       └── index.js      # Entry point
├── docker-compose.yml
└── Taskfile.yml
```

## Server Module Pattern

Each feature lives in `server/src/modules/{feature}/`:

```
modules/items/
├── routes.js    # Express router — thin, delegates to service
├── service.js   # Business logic, calls repositories
└── schema.js    # Zod validation schemas
```

Modules are registered in the main router and receive dependencies via injection.

## Dependency Injection

All modules receive a standard dependency object:

```js
{ cache, db, logger, config }
```

- `db` — MySQL connection pool (via `mysql2/promise`)
- `cache` — Redis client
- `logger` — Pino logger instance
- `config` — Validated environment config object

## API Conventions

### Route Prefixes

| Prefix | Method |
|--------|--------|
| `_x_`  | GET    |
| `_y_`  | POST   |
| `_u_`  | PUT    |
| `_p_`  | PATCH  |
| `_d_`  | DELETE |

Example: `GET /api/items/_x_list`, `POST /api/items/_y_create`

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
StateStore (React context / Zustand)
    └── Repositories (raw DB queries, return DB shape)
            └── Services (business logic, return camelCase)
```

- **Repositories** handle all SQL — no business logic
- **Services** orchestrate repositories, apply rules, transform data
- **StateStore** manages client-side cache and optimistic updates

## Frontend Conventions

- Radix UI primitives for accessible interactive components (Dialog, DropdownMenu, Tooltip, etc.)
- Custom Tailwind utility classes for styling — no Radix themes
- Lucide React for all icons
- Inter font for all body text; JetBrains Mono for item codes, QR labels, and monospace fields
- Co-locate component styles with component files (no global CSS beyond base reset)

## Database

Single database: `TALLY`

Key design patterns:
- **Closure table** for container hierarchy (supports arbitrary nesting of locations/containers)
- **FULLTEXT indexes** on item name, description, and tags for fast search
- All tables include `CREATED_AT` / `UPDATED_AT` timestamps
- Soft deletes via `DELETED_AT` where appropriate

## Authentication

- Provider: Microsoft Entra ID (Azure AD) via OIDC
- Sessions stored in httpOnly signed cookies (no JWT in localStorage)
- Session data held server-side (Redis)
- Set `BYPASS_AUTH=true` in `.env` to skip auth during local development
- User identity (`USER_ID`, `TENANT_ID`) is injected into all request contexts after auth middleware

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

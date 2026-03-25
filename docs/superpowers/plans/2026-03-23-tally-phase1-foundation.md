# Tally Phase 1: Foundation & Core Inventory — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Tally project with working auth, full database schema, core inventory CRUD (backend + frontend), and a functional UI shell with the design system.

**Architecture:** Monorepo with `server/` (Express.js, EMP module pattern) and `client/` (React 18, Radix UI, Tailwind v4). MySQL 8.0 database, MinIO for file storage, Docker Compose for local dev. Auth via Microsoft Entra ID OIDC. All EMP conventions: dependency injection, `_x_`/`_y_`/`_u_`/`_d_` API prefixes, UPPERCASE DB columns with camelCase API responses, `{ success, data, message }` response envelope.

**Tech Stack:** React 18, TypeScript, Radix UI, Tailwind CSS v4 (OKLCH), Vite, Express.js, MySQL 8.0, MinIO, Docker Compose, Lucide React, Inter + JetBrains Mono fonts, Joi validation, mysql2, Winston logging

**Spec:** `docs/superpowers/specs/2026-03-23-tally-design.md`

**Phase Plan:**
- **Phase 1 (this plan):** Foundation — scaffolding, Docker, DB, auth, inventory CRUD, frontend shell
- **Phase 2:** Item Intelligence & Files — products, barcode/OCR/image lookup, camera scanner, file uploads, condition tracking
- **Phase 3:** Organization & Labels — tags, full-text search, QR codes, label printing (PDF + ZPL), scan-scan-done
- **Phase 4:** Lifecycle & Notifications — lending, flexible dates, depreciation, audit trail, notifications, soft delete purge
- **Phase 5:** Reports, Sharing & Deployment — all reports (PDF/CSV), share links, PW app.yml, CI/CD pipelines

---

## File Structure

### Root

```
tally/
├── docker-compose.yml
├── Taskfile.yml
├── .env.template
├── .env                          # Generated from template (gitignored)
├── .gitignore
├── app.yml                       # PW deployment manifest (Phase 5)
├── CLAUDE.md
├── README.md
```

### Server

```
server/
├── index.js                      # Express entry point, boot sequence
├── package.json
├── src/
│   ├── config.js                 # Environment config loader + validation
│   ├── infrastructure/
│   │   └── db.js                 # MySQL connection pool (SSL, retry, health)
│   ├── repositories/
│   │   └── BaseRepository.js     # Parameterized queries, CRUD, entity mapping
│   ├── state/
│   │   └── StateStore.js         # In-memory cache with auto-refresh
│   ├── middleware/
│   │   ├── error-handler.js      # Centralized error handling
│   │   └── validate.js           # Joi schema validation HOF
│   ├── utils/
│   │   ├── response.js           # success() / error() response envelope
│   │   ├── logger.js             # Winston structured logging
│   │   └── qr.js                 # TLY-{TYPE}-{HEX} code generation
│   └── modules/
│       ├── auth/
│       │   ├── auth.routes.js    # OAuth init, callback, session, logout
│       │   ├── auth.service.js   # Entra ID OIDC, token validation, session CRUD
│       │   ├── auth.middleware.js # requireAuth, requireRole(role)
│       │   └── auth.schema.js    # Joi schemas
│       └── inventory/
│           ├── properties.routes.js
│           ├── properties.service.js
│           ├── properties.schema.js
│           ├── areas.routes.js
│           ├── areas.service.js
│           ├── areas.schema.js
│           ├── containers.routes.js
│           ├── containers.service.js
│           ├── containers.schema.js
│           ├── items.routes.js
│           ├── items.service.js
│           ├── items.schema.js
│           └── closure-table.service.js  # Container hierarchy management
```

### Client

```
client/
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── postcss.config.js
├── nginx.conf
├── Dockerfile
├── src/
│   ├── main.tsx                  # React entry, providers
│   ├── App.tsx                   # Router + layout
│   ├── globals.css               # Tailwind v4 + OKLCH theme tokens (light + dark)
│   ├── lib/
│   │   ├── api.ts                # Fetch wrapper, auth headers, base URL
│   │   ├── query-client.ts       # React Query config, key factories
│   │   └── utils.ts              # clsx + tailwind-merge helper
│   ├── hooks/
│   │   ├── use-auth.ts           # Auth context hook
│   │   └── use-inventory.ts      # React Query hooks for inventory CRUD
│   ├── components/
│   │   ├── layout/
│   │   │   ├── root-layout.tsx   # Shell: header + bottom nav + main content
│   │   │   ├── bottom-nav.tsx    # 5-tab navigation
│   │   │   ├── header.tsx        # Title + notification bell + breadcrumbs
│   │   │   └── breadcrumbs.tsx   # Hierarchy path display
│   │   ├── ui/
│   │   │   ├── button.tsx        # Radix Slot + CVA variants
│   │   │   ├── card.tsx          # Card container
│   │   │   ├── dialog.tsx        # Radix Dialog wrapper
│   │   │   ├── input.tsx         # Styled input
│   │   │   ├── select.tsx        # Radix Select wrapper
│   │   │   ├── toast.tsx         # Sonner toast wrapper
│   │   │   ├── badge.tsx         # Status/role badges
│   │   │   ├── dropdown-menu.tsx # Radix DropdownMenu wrapper
│   │   │   └── skeleton.tsx      # Loading skeleton
│   │   └── inventory/
│   │       ├── property-card.tsx  # Property list item
│   │       ├── area-card.tsx      # Area list item
│   │       ├── container-card.tsx # Container list item
│   │       ├── item-card.tsx      # Item list item
│   │       ├── entity-form.tsx    # Shared create/edit form
│   │       └── hierarchy-view.tsx # Drill-down view (containers + items in context)
│   ├── pages/
│   │   ├── home.tsx              # Dashboard: search + properties + activity
│   │   ├── inventory.tsx         # Hierarchy browser entry
│   │   ├── property-detail.tsx   # Areas list for a property
│   │   ├── area-detail.tsx       # Containers list for an area
│   │   ├── container-detail.tsx  # Nested containers + items
│   │   ├── item-detail.tsx       # Full item view
│   │   ├── scan.tsx              # Placeholder (Phase 2)
│   │   ├── reports.tsx           # Placeholder (Phase 5)
│   │   ├── settings.tsx          # Basic settings shell
│   │   ├── login.tsx             # Login redirect page
│   │   └── oauth-callback.tsx    # Entra ID callback handler
│   ├── store/
│   │   └── auth-store.ts         # Zustand: user session state
│   └── types/
│       ├── api.ts                # Response envelope types
│       ├── inventory.ts          # Property, Area, Container, Item types
│       └── auth.ts               # User, Session types
```

### SQL

```
SQL/
├── init/
│   └── 001_TALLY_Init.sql        # CREATE DATABASE + all tables
└── migrations/
    └── (empty — init creates everything for v1)
```

---

## Task Breakdown

### Task 1: Initialize Repository & Project Structure

**Files:**
- Create: `tally/.gitignore`
- Create: `tally/CLAUDE.md`

- [ ] **Step 1: Create project directory and initialize git**

```bash
mkdir -p /Users/luke/dev/tally
cd /Users/luke/dev/tally
git init
```

- [ ] **Step 2: Create .gitignore**

```gitignore
# Dependencies
node_modules/

# Build
client/build/
client/dist/
server/dist/

# Environment
.env
.env.local

# IDE
.idea/
.vscode/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db

# Docker
docker-data/

# Logs
*.log
logs/

# SSL certs (local dev)
ssl/

# Superpowers
.superpowers/
```

- [ ] **Step 3: Create CLAUDE.md**

Write project documentation following EMP's CLAUDE.md pattern. Include:
- Project overview (Tally — collaborative home inventory)
- Tech stack summary
- EMP conventions: module pattern, DI, API prefixes, DB UPPERCASE → API camelCase
- Common commands (`task up`, `task dev`, `task logs:server`)
- Module structure reference

- [ ] **Step 4: Commit**

```bash
git add .gitignore CLAUDE.md
git commit -m "feat: initialize tally repository with project documentation"
```

---

### Task 2: Server Scaffolding — Package.json, Config, DB, Utilities

**Files:**
- Create: `server/package.json`
- Create: `server/src/config.js`
- Create: `server/src/infrastructure/db.js`
- Create: `server/src/utils/response.js`
- Create: `server/src/utils/logger.js`
- Create: `server/src/utils/qr.js`
- Create: `server/src/repositories/BaseRepository.js`
- Create: `server/src/middleware/error-handler.js`
- Create: `server/src/middleware/validate.js`

- [ ] **Step 1: Create server/package.json**

```json
{
  "name": "tally-server",
  "version": "1.0.0",
  "main": "index.js",
  "scripts": {
    "start": "node index.js",
    "dev": "node --watch index.js"
  },
  "dependencies": {
    "express": "^4.21.0",
    "express-async-errors": "^3.1.1",
    "helmet": "^8.1.0",
    "cors": "^2.8.5",
    "compression": "^1.7.4",
    "express-rate-limit": "^8.3.0",
    "cookie-parser": "^1.4.7",
    "mysql2": "^3.16.0",
    "joi": "^18.0.2",
    "jose": "^6.1.3",
    "winston": "^3.19.0",
    "winston-daily-rotate-file": "^5.0.0",
    "uuid": "^9.0.1",
    "dotenv": "^17.2.3",
    "node-cache": "^5.1.2",
    "@aws-sdk/client-s3": "^3.948.0",
    "@aws-sdk/s3-request-presigner": "^3.948.0",
    "multer": "^1.4.5-lts.1",
    "sharp": "^0.33.2"
  }
}
```

- [ ] **Step 2: Run npm install**

```bash
cd server && npm install
```

- [ ] **Step 3: Create src/config.js**

Environment variable loader with validation. Required vars: `PORT`, `MYSQL_URL`, `MYSQL_USER`, `MYSQL_PASSWORD`, `TALLY_DB`, `ENTRA_CLIENT_ID`, `ENTRA_TENANT_ID`, `COOKIE_SECRET`, `CLIENT_URL`. Defaults for PORT (2727), NODE_ENV (development). Fail fast on missing required vars in production.

Follow EMP pattern: export a frozen config object.

- [ ] **Step 4: Create src/infrastructure/db.js**

MySQL2 connection pool matching EMP's pattern:
- Pool size: 20 connections, 100 queue limit
- SSL support (optional)
- 30-second query timeout
- Transient error retry (PROTOCOL_CONNECTION_LOST, ECONNRESET, ER_LOCK_DEADLOCK)
- `query(sql, params)`, `queryLong(sql, params)`, `getConnection()`, `checkConnection()`
- Pool stats method for health endpoint

- [ ] **Step 5: Create src/utils/response.js**

```javascript
function success(res, data, message = 'Success', statusCode = 200, meta) {
  const body = { success: true, message, data };
  if (meta) body.meta = meta;
  return res.status(statusCode).json(body);
}

function error(res, message = 'Internal Server Error', statusCode = 500, errors) {
  const body = { success: false, message };
  if (errors) body.errors = errors;
  return res.status(statusCode).json(body);
}

module.exports = { success, error };
```

- [ ] **Step 6: Create src/utils/logger.js**

Winston logger matching EMP: structured JSON, daily rotate file, console transport in development. Log levels: error, warn, info, debug.

- [ ] **Step 7: Create src/utils/qr.js**

QR code utility:
- `generateCode(type)` — generates `TLY-{TYPE}-{HEX}` where TYPE is P/A/C/I and HEX is 4 uppercase hex chars from a random uint16
- `parseCode(code)` — parses a TLY code, returns `{ type, hex }` or null
- `typeMap` — maps P→property, A→area, C→container, I→item

```javascript
const crypto = require('crypto');

const TYPE_MAP = { P: 'property', A: 'area', C: 'container', I: 'item' };
const REVERSE_MAP = Object.fromEntries(Object.entries(TYPE_MAP).map(([k, v]) => [v, k]));

function generateCode(entityType) {
  const prefix = REVERSE_MAP[entityType];
  if (!prefix) throw new Error(`Unknown entity type: ${entityType}`);
  const hex = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `TLY-${prefix}-${hex}`;
}

function parseCode(code) {
  const match = code.match(/^TLY-([PACI])-([0-9A-Fa-f]{4})$/);
  if (!match) return null;
  return { type: TYPE_MAP[match[1]], hex: match[2].toUpperCase() };
}

module.exports = { generateCode, parseCode, TYPE_MAP };
```

Note: In production, if a collision occurs on INSERT (QR_CODE has UNIQUE constraint), retry with a new code. The service layer handles this.

- [ ] **Step 8: Create src/repositories/BaseRepository.js**

Matching EMP pattern:
- Constructor takes `{ db, table, database, primaryKey = 'ID' }`
- `findById(id)` → `mapToEntity()`
- `findAll({ where, orderBy, limit, offset })` — parameterized, sanitized orderBy
- `insert(entity)` → `mapToRow()`, returns insertId
- `update(id, entity)` → `mapToRow()`, returns affectedRows
- `delete(id)` — soft delete: `UPDATE SET DELETED_AT = NOW()`
- `restore(id)` — `UPDATE SET DELETED_AT = NULL`
- `count(where)`
- `exists(id)`
- `mapToEntity(row)` — override in subclass (UPPERCASE → camelCase)
- `mapToRow(entity)` — override in subclass (camelCase → UPPERCASE)
- `sanitizeOrderBy(orderBy, allowedColumns)` — prevents SQL injection

- [ ] **Step 9: Create src/middleware/error-handler.js**

Centralized error handler matching EMP:
- Redacts sensitive fields (password, token, secret, cookie)
- Handles Joi ValidationError → `{ field, message }` array, 400 status
- Handles MySQL errors (ER_DUP_ENTRY → 409, ER_NO_REFERENCED_ROW → 400)
- Default: 500 with generic message in production, full error in development
- Logs all errors via logger

- [ ] **Step 10: Create src/middleware/validate.js**

```javascript
const { error } = require('../utils/response');

function validate(schema, source = 'body') {
  return (req, res, next) => {
    const { error: validationError, value } = schema.validate(req[source], {
      abortEarly: false,
      stripUnknown: true,
    });
    if (validationError) {
      const errors = validationError.details.map(d => ({
        field: d.path.join('.'),
        message: d.message,
      }));
      return error(res, 'Validation failed', 400, errors);
    }
    req[source] = value;
    next();
  };
}

module.exports = validate;
```

- [ ] **Step 11: Commit**

```bash
git add server/
git commit -m "feat: server scaffolding — config, db, utilities, middleware"
```

---

### Task 3: Database Schema

**Files:**
- Create: `SQL/init/001_TALLY_Init.sql`

- [ ] **Step 1: Write the complete TALLY database initialization SQL**

Single file creates the entire `TALLY` database with all 19 tables defined in the spec (plus the `sessions` table added in Task 6). Use idempotent patterns (`CREATE DATABASE IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`).

Table creation order (respecting FK dependencies):
1. `users` (no FKs)
2. `products` (no FKs)
3. `properties` (FK → users)
4. `property_members` (FK → properties, users)
5. `areas` (FK → properties)
6. `containers` (FK → areas, self-ref)
7. `container_paths` (FK → containers)
8. `items` (FK → containers, products)
9. `item_dates` (FK → items)
10. `item_accessories` (FK → items)
11. `condition_snapshots` (FK → items, users)
12. `item_files` (FK → items, users)
13. `item_lending` (FK → items, users)
14. `tags` (FK → properties)
15. `entity_tags` (FK → tags)
16. `change_log` (FK → users, properties)
17. `notifications` (FK → users)
18. `notification_preferences` (FK → users)
19. `share_links` (FK → users)

Key SQL conventions from EMP:
- `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
- Column names UPPERCASE
- Timestamps as `DATETIME` with `DEFAULT CURRENT_TIMESTAMP`
- FULLTEXT indexes on items (NAME, DESCRIPTION), products (NAME, BRAND, DESCRIPTION), containers (NAME), areas (NAME)
- Closure table: composite PK on (ANCESTOR_ID, DESCENDANT_ID), index on DESCENDANT_ID

- [ ] **Step 2: Verify SQL is valid**

```bash
# Will be tested when Docker Compose is up (Task 4)
```

- [ ] **Step 3: Commit**

```bash
git add SQL/
git commit -m "feat: TALLY database schema — all 19 tables with indexes and FKs"
```

---

### Task 4: Docker Compose & Environment

**Files:**
- Create: `docker-compose.yml`
- Create: `.env.template`
- Create: `Taskfile.yml`
- Create: `server/Dockerfile`
- Create: `client/Dockerfile`
- Create: `client/nginx.conf`

- [ ] **Step 1: Create .env.template**

```bash
# ============================================================
# Tally Configuration Template
# Copy to .env and fill in required values.
# ============================================================

# --- Core ---
NODE_ENV=development
PORT=2727
CLIENT_URL=http://localhost:8080

# --- Database ---
MYSQL_URL=tally-db
MYSQL_USER=tally_api
MYSQL_PASSWORD=tally_dev_password
MYSQL_ROOT_PASSWORD=tally_root_password
MYSQL_USE_SSL=false
TALLY_DB=TALLY

# --- File Storage (MinIO) ---
S3_BUCKET=tally-files
S3_REGION=us-east-1
S3_ACCESS_KEY=tallydevaccess
S3_SECRET_KEY=tallydevsecret
S3_ENDPOINT=http://tally-minio:9000
S3_PUBLIC_ENDPOINT=http://localhost:9000

# --- Auth (Entra ID) ---
ENTRA_CLIENT_ID=
ENTRA_CLIENT_SECRET=
ENTRA_TENANT_ID=
ENTRA_REDIRECT_URI=http://localhost:8080/oauth/callback
COOKIE_SECRET=tally-dev-cookie-secret-min-32-chars!!

# --- Logging ---
LOG_LEVEL=info
LOG_TO_CONSOLE=true
LOG_TO_FILE=false

# --- Dev ---
BYPASS_AUTH=true
```

- [ ] **Step 2: Create docker-compose.yml**

5 services matching EMP pattern:
- `tally-db`: MySQL 8.0, port 3306, health check (`mysqladmin ping`), volume mount for `SQL/init/` → `/docker-entrypoint-initdb.d/`
- `tally-server`: Node.js, port 2727, depends_on tally-db healthy, env_file .env
- `tally-client`: Nginx, port 8080, serves React build, proxies /api/ to server
- `tally-minio`: MinIO, ports 9000/9001, creates default bucket on start
- `tally-vault`: HashiCorp Vault dev mode, port 8200 (for future secret management)

Docker network: `tally-network` (bridge).

Volume: `tally-db-data` for MySQL persistence.

Dev profile: `tally-server` and `tally-client` mount source for hot reload.

- [ ] **Step 3: Create server/Dockerfile**

```dockerfile
FROM node:20-alpine
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci
COPY . .
EXPOSE 2727
CMD ["node", "index.js"]
```

- [ ] **Step 4: Create client/Dockerfile**

```dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
```

- [ ] **Step 5: Create client/nginx.conf**

Matching EMP pattern:
- Docker DNS resolver (127.0.0.11)
- `/api/` proxy to `tally-server:2727`
- `/tally-files/` proxy to `tally-minio:9000`
- `/health` proxy to server
- `try_files $uri $uri/ /index.html` for SPA routing
- Security headers (CSP, X-Frame-Options, nosniff)
- Gzip compression
- Static asset caching (1 year, immutable)
- 1G max upload for files
- **Camera permissions in CSP**: `camera=(self)` in Permissions-Policy

- [ ] **Step 6: Create Taskfile.yml**

```yaml
version: '3'

dotenv: ['.env']

tasks:
  init:
    desc: First-time setup
    cmds:
      - cp -n .env.template .env || true
      - task: up

  up:
    desc: Build and start all services
    cmds:
      - docker compose up --build -d
      - docker compose logs -f tally-server

  dev:
    desc: Start with live source mounts
    cmds:
      - docker compose -f docker-compose.yml up --build -d
      - echo "Server running at http://localhost:2727"
      - echo "Client running at http://localhost:8080"
      - echo "MinIO running at http://localhost:9001"

  down:
    desc: Stop all services
    cmds:
      - docker compose down

  restart:
    desc: Restart services
    cmds:
      - docker compose restart

  logs:server:
    desc: Tail server logs
    cmds:
      - docker compose logs -f tally-server

  logs:client:
    desc: Tail client logs
    cmds:
      - docker compose logs -f tally-client

  db:shell:
    desc: Open MySQL shell
    cmds:
      - docker compose exec tally-db mysql -u root -p$MYSQL_ROOT_PASSWORD TALLY

  db:reset:
    desc: Reset database (destructive)
    cmds:
      - docker compose down -v
      - docker compose up -d tally-db
      - echo "Database reset. Run 'task up' to restart all services."

  clean:
    desc: Full cleanup
    cmds:
      - docker compose down -v --remove-orphans
```

- [ ] **Step 7: Copy .env.template to .env**

```bash
cp .env.template .env
```

- [ ] **Step 8: Verify Docker Compose starts**

```bash
task up
```

Expected: All 5 services start. MySQL initializes with TALLY database and all 19 tables. Server starts on port 2727 (will fail since index.js doesn't exist yet — that's OK).

- [ ] **Step 9: Commit**

```bash
git add docker-compose.yml .env.template Taskfile.yml server/Dockerfile client/Dockerfile client/nginx.conf
git commit -m "feat: docker compose setup — MySQL, API, client, MinIO, Vault"
```

---

### Task 5: Server Entry Point

**Files:**
- Create: `server/index.js`

- [ ] **Step 1: Write server/index.js**

Express boot sequence matching EMP:
1. Load dotenv
2. Validate environment via config.js
3. Import express, cors, helmet, compression, cookie-parser, rate-limit
4. Initialize database pool
5. Create Express app
6. Apply security middleware: helmet (with camera-friendly CSP), CORS (CLIENT_URL origin), compression, rate-limit (200 req/min)
7. Apply cookie-parser with COOKIE_SECRET
8. Apply JSON body parser (50mb limit for file metadata)
9. Health endpoint: `GET /health/live` — returns `{ status: 'ok', uptime, db: await db.checkConnection() }`
10. Register module routes with dependency injection: `require('./src/modules/auth/auth.routes')({ app, db, logger, config })`
11. Apply error handler middleware (must be last)
12. Start server, log startup time
13. Graceful shutdown on SIGTERM/SIGINT: close DB pool, exit

- [ ] **Step 2: Verify server starts**

```bash
cd server && npm start
```

Expected: Server starts on port 2727. `GET /health/live` returns 200 with DB connection status.

- [ ] **Step 3: Commit**

```bash
git add server/index.js
git commit -m "feat: server entry point — Express boot with middleware and health check"
```

---

### Task 6: Auth Module

**Files:**
- Create: `server/src/modules/auth/auth.routes.js`
- Create: `server/src/modules/auth/auth.service.js`
- Create: `server/src/modules/auth/auth.middleware.js`
- Create: `server/src/modules/auth/auth.schema.js`

- [ ] **Step 1: Write auth.service.js**

AuthService handles Entra ID OIDC:
- `init({ db, config })` — static initialization, stores DB ref and config
- `getAuthorizationUrl()` — builds Entra authorize URL with PKCE (code_challenge, state)
- `exchangeCode(code, codeVerifier)` — POSTs to Entra token endpoint, validates ID token via JOSE (jwks_uri), returns user profile
- `findOrCreateUser(profile)` — upserts into `users` table by ENTRA_ID, returns user record
- `createSession(userId)` — inserts session, returns session token (UUID), sets LAST_LOGIN_AT
- `validateSession(token)` — queries session by token, checks expiry
- `destroySession(token)` — deletes session row

Session storage: `sessions` table (add to SQL init):
```sql
CREATE TABLE IF NOT EXISTS `sessions` (
  `ID` INT AUTO_INCREMENT PRIMARY KEY,
  `USER_ID` INT NOT NULL,
  `TOKEN` VARCHAR(64) NOT NULL UNIQUE,
  `EXPIRES_AT` DATETIME NOT NULL,
  `CREATED_AT` DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`USER_ID`) REFERENCES `users`(`ID`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

Update `SQL/init/001_TALLY_Init.sql` to include this table.

PKCE state/verifier stored temporarily in NodeCache (5 min TTL).

BYPASS_AUTH mode: When `BYPASS_AUTH=true`, skip Entra ID entirely. Auto-create a dev user and session.

- [ ] **Step 2: Write auth.middleware.js**

```javascript
function requireAuth(authService) {
  return async (req, res, next) => {
    const token = req.signedCookies?.session_token;
    if (!token) return error(res, 'Authentication required', 401);

    const session = await authService.validateSession(token);
    if (!session) return error(res, 'Session expired', 401);

    req.user = session.user;
    next();
  };
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.propertyRole) return error(res, 'No property context', 403);
    if (!roles.includes(req.propertyRole)) return error(res, 'Insufficient permissions', 403);
    next();
  };
}

// Resolves user's role for a given property (from URL param or body)
function resolvePropertyRole(db) {
  return async (req, res, next) => {
    const propertyId = req.params.propertyId || req.body?.propertyId;
    if (!propertyId) return next(); // No property context — skip

    const [rows] = await db.query(
      'SELECT ROLE FROM TALLY.property_members WHERE PROPERTY_ID = ? AND USER_ID = ?',
      [propertyId, req.user.id]
    );
    req.propertyRole = rows[0]?.ROLE || null;
    next();
  };
}
```

- [ ] **Step 3: Write auth.schema.js**

Joi schemas for:
- `oauthCallback` — `{ code: Joi.string().required(), state: Joi.string().required() }`

- [ ] **Step 4: Write auth.routes.js**

```javascript
module.exports = function authRoutes({ app, db, logger, config }) {
  const AuthService = require('./auth.service');
  AuthService.init({ db, config, logger });

  const { requireAuth, resolvePropertyRole } = require('./auth.middleware');
  const validate = require('../../middleware/validate');
  const schemas = require('./auth.schema');
  const { success, error } = require('../../utils/response');

  // GET /api/auth/_x_/session — get current user
  app.get('/api/auth/_x_/session', requireAuth(AuthService), (req, res) => {
    success(res, { user: req.user });
  });

  // GET /api/auth/_x_/oauth/init — start OAuth flow
  app.get('/api/auth/_x_/oauth/init', (req, res) => {
    const { url, state } = AuthService.getAuthorizationUrl();
    res.redirect(url);
  });

  // GET /api/auth/_x_/oauth/callback — Entra ID callback
  app.get('/api/auth/_x_/oauth/callback', async (req, res) => {
    const { code, state } = req.query;
    const profile = await AuthService.exchangeCode(code, state);
    const user = await AuthService.findOrCreateUser(profile);
    const session = await AuthService.createSession(user.id);

    res.cookie('session_token', session.token, {
      httpOnly: true,
      secure: config.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      signed: true,
    });

    res.redirect(config.CLIENT_URL);
  });

  // POST /api/auth/_y_/logout — destroy session
  app.post('/api/auth/_y_/logout', requireAuth(AuthService), async (req, res) => {
    await AuthService.destroySession(req.signedCookies?.session_token);
    res.clearCookie('session_token');
    success(res, null, 'Logged out');
  });

  // Export middleware for other modules
  app.locals.requireAuth = requireAuth(AuthService);
  app.locals.resolvePropertyRole = resolvePropertyRole(db);
  app.locals.requireRole = requireRole;
};
```

- [ ] **Step 5: Register auth routes in index.js**

Add to server/index.js after middleware setup:
```javascript
require('./src/modules/auth/auth.routes')({ app, db, logger, config });
```

- [ ] **Step 6: Test auth flow**

With `BYPASS_AUTH=true`:
```bash
curl http://localhost:2727/api/auth/_x_/session -b "session_token=dev"
```

Expected: 200 with dev user data.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/auth/ server/index.js SQL/
git commit -m "feat: auth module — Entra ID OIDC, sessions, RBAC middleware"
```

---

### Task 7: Inventory Module — Properties

**Files:**
- Create: `server/src/modules/inventory/properties.routes.js`
- Create: `server/src/modules/inventory/properties.service.js`
- Create: `server/src/modules/inventory/properties.schema.js`

- [ ] **Step 1: Write properties.service.js**

PropertiesService extends BaseRepository pattern:
- `init({ db })` — stores DB reference
- `getAll(userId)` — returns properties where user is a member (JOIN property_members)
- `getById(id)` — returns property with member count, area count, container count, item count
- `create(data, userId)` — INSERT property, INSERT property_members (owner), generate QR code via `qr.generateCode('property')`. Handle QR collision: retry once with new code.
- `update(id, data)` — UPDATE properties
- `softDelete(id)` — SET DELETED_AT = NOW()
- `restore(id)` — SET DELETED_AT = NULL
- `getMembers(propertyId)` — returns property_members with user details
- `addMember(propertyId, userId, role, invitedBy)` — INSERT property_members
- `removeMember(propertyId, userId)` — DELETE property_members
- `updateMemberRole(propertyId, userId, role)` — UPDATE ROLE

All entity methods return camelCase objects.

- [ ] **Step 2: Write properties.schema.js**

```javascript
const Joi = require('joi');

const createProperty = Joi.object({
  name: Joi.string().max(255).required(),
  address: Joi.string().allow('', null),
  description: Joi.string().allow('', null),
});

const updateProperty = Joi.object({
  name: Joi.string().max(255),
  address: Joi.string().allow('', null),
  description: Joi.string().allow('', null),
}).min(1);

const addMember = Joi.object({
  email: Joi.string().email().required(),
  role: Joi.string().valid('editor', 'viewer').required(),
});

const updateMemberRole = Joi.object({
  role: Joi.string().valid('owner', 'editor', 'viewer').required(),
});

module.exports = { createProperty, updateProperty, addMember, updateMemberRole };
```

- [ ] **Step 3: Write properties.routes.js**

```javascript
module.exports = function propertiesRoutes({ app, db, logger }) {
  const PropertiesService = require('./properties.service');
  PropertiesService.init({ db, logger });

  const validate = require('../../middleware/validate');
  const schemas = require('./properties.schema');
  const { success, error } = require('../../utils/response');
  const { requireAuth, resolvePropertyRole, requireRole } = app.locals;

  // GET /api/properties/_x_/list — all properties for current user
  app.get('/api/properties/_x_/list', requireAuth, async (req, res) => {
    const properties = await PropertiesService.getAll(req.user.id);
    success(res, properties);
  });

  // GET /api/properties/_x_/:propertyId — single property detail
  app.get('/api/properties/_x_/:propertyId', requireAuth, resolvePropertyRole, async (req, res) => {
    if (!req.propertyRole) return error(res, 'Not a member of this property', 403);
    const property = await PropertiesService.getById(req.params.propertyId);
    if (!property) return error(res, 'Property not found', 404);
    success(res, property);
  });

  // POST /api/properties/_y_/create — create property
  app.post('/api/properties/_y_/create', requireAuth, validate(schemas.createProperty), async (req, res) => {
    const property = await PropertiesService.create(req.body, req.user.id);
    success(res, property, 'Property created', 201);
  });

  // PUT /api/properties/_u_/:propertyId — update property
  app.put('/api/properties/_u_/:propertyId', requireAuth, resolvePropertyRole, requireRole('owner', 'editor'), validate(schemas.updateProperty), async (req, res) => {
    const property = await PropertiesService.update(req.params.propertyId, req.body);
    success(res, property);
  });

  // DELETE /api/properties/_d_/:propertyId — soft delete property
  app.delete('/api/properties/_d_/:propertyId', requireAuth, resolvePropertyRole, requireRole('owner'), async (req, res) => {
    await PropertiesService.softDelete(req.params.propertyId);
    success(res, null, 'Property deleted');
  });

  // GET /api/properties/_x_/:propertyId/members — list members
  app.get('/api/properties/_x_/:propertyId/members', requireAuth, resolvePropertyRole, requireRole('owner'), async (req, res) => {
    const members = await PropertiesService.getMembers(req.params.propertyId);
    success(res, members);
  });

  // POST /api/properties/_y_/:propertyId/members — add member
  app.post('/api/properties/_y_/:propertyId/members', requireAuth, resolvePropertyRole, requireRole('owner'), validate(schemas.addMember), async (req, res) => {
    const member = await PropertiesService.addMember(req.params.propertyId, req.body, req.user.id);
    success(res, member, 'Member added', 201);
  });
};
```

- [ ] **Step 4: Register properties routes in index.js**

Add after auth routes:
```javascript
require('./src/modules/inventory/properties.routes')({ app, db, logger, config });
```

- [ ] **Step 5: Test properties CRUD**

```bash
# Create
curl -X POST http://localhost:2727/api/properties/_y_/create \
  -H "Content-Type: application/json" \
  -b "session_token=dev" \
  -d '{"name": "Luke'\''s Apartment", "address": "123 Main St"}'

# List
curl http://localhost:2727/api/properties/_x_/list -b "session_token=dev"
```

Expected: 201 with property data including qrCode. 200 with array of properties.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/inventory/properties.*
git commit -m "feat: properties CRUD — create, read, update, soft delete, members"
```

---

### Task 8: Inventory Module — Areas

**Files:**
- Create: `server/src/modules/inventory/areas.routes.js`
- Create: `server/src/modules/inventory/areas.service.js`
- Create: `server/src/modules/inventory/areas.schema.js`

- [ ] **Step 1: Write areas.service.js**

AreasService:
- `getByProperty(propertyId)` — all areas in a property (where DELETED_AT IS NULL)
- `getById(id)` — area with container count, item count
- `create(data, propertyId)` — INSERT with QR code generation
- `update(id, data)` — UPDATE
- `softDelete(id)` — SET DELETED_AT
- `getPropertyIdForArea(areaId)` — resolve property ownership (for middleware)

- [ ] **Step 2: Write areas.schema.js**

```javascript
const Joi = require('joi');

const createArea = Joi.object({
  name: Joi.string().max(255).required(),
  description: Joi.string().allow('', null),
  propertyId: Joi.number().integer().required(),
});

const updateArea = Joi.object({
  name: Joi.string().max(255),
  description: Joi.string().allow('', null),
}).min(1);

module.exports = { createArea, updateArea };
```

- [ ] **Step 3: Write areas.routes.js**

Routes:
- `GET /api/areas/_x_/property/:propertyId` — list areas in property
- `GET /api/areas/_x_/:areaId` — area detail
- `POST /api/areas/_y_/create` — create area (resolves property from body.propertyId)
- `PUT /api/areas/_u_/:areaId` — update area
- `DELETE /api/areas/_d_/:areaId` — soft delete area

All routes: requireAuth → resolve property from area → resolvePropertyRole → requireRole.

- [ ] **Step 4: Register and test**

```bash
curl -X POST http://localhost:2727/api/areas/_y_/create \
  -H "Content-Type: application/json" \
  -b "session_token=dev" \
  -d '{"name": "Kitchen", "propertyId": 1}'
```

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/inventory/areas.*
git commit -m "feat: areas CRUD — create, read, update, soft delete"
```

---

### Task 9: Inventory Module — Containers (with Closure Table)

**Files:**
- Create: `server/src/modules/inventory/containers.routes.js`
- Create: `server/src/modules/inventory/containers.service.js`
- Create: `server/src/modules/inventory/containers.schema.js`
- Create: `server/src/modules/inventory/closure-table.service.js`

- [ ] **Step 1: Write closure-table.service.js**

Manages the `container_paths` closure table:

```javascript
class ClosureTableService {
  constructor(db) { this.db = db; }

  // Insert self-reference + copy ancestor paths
  async addNode(containerId, parentContainerId) {
    // Self-reference: every node is its own ancestor at depth 0
    await this.db.query(
      'INSERT INTO TALLY.container_paths (ANCESTOR_ID, DESCENDANT_ID, DEPTH) VALUES (?, ?, 0)',
      [containerId, containerId]
    );

    if (parentContainerId) {
      // Copy all ancestors of parent, incrementing depth by 1
      await this.db.query(
        `INSERT INTO TALLY.container_paths (ANCESTOR_ID, DESCENDANT_ID, DEPTH)
         SELECT ANCESTOR_ID, ?, DEPTH + 1
         FROM TALLY.container_paths
         WHERE DESCENDANT_ID = ?`,
        [containerId, parentContainerId]
      );
    }
  }

  // Move a subtree: delete old paths, insert new ones
  async moveNode(containerId, newParentContainerId) {
    // Delete all paths to ancestors (keep subtree internal paths)
    await this.db.query(
      `DELETE cp FROM TALLY.container_paths cp
       INNER JOIN TALLY.container_paths subtree ON cp.DESCENDANT_ID = subtree.DESCENDANT_ID
       LEFT JOIN TALLY.container_paths internal
         ON internal.ANCESTOR_ID = subtree.DESCENDANT_ID AND internal.DESCENDANT_ID = cp.ANCESTOR_ID
       WHERE subtree.ANCESTOR_ID = ? AND internal.ANCESTOR_ID IS NULL`,
      [containerId]
    );

    // Insert new ancestor paths
    if (newParentContainerId) {
      await this.db.query(
        `INSERT INTO TALLY.container_paths (ANCESTOR_ID, DESCENDANT_ID, DEPTH)
         SELECT ancestor.ANCESTOR_ID, subtree.DESCENDANT_ID, ancestor.DEPTH + subtree.DEPTH + 1
         FROM TALLY.container_paths ancestor
         CROSS JOIN TALLY.container_paths subtree
         WHERE ancestor.DESCENDANT_ID = ? AND subtree.ANCESTOR_ID = ?`,
        [newParentContainerId, containerId]
      );
    }
  }

  // Remove node and all descendants from closure table
  async removeNode(containerId) {
    await this.db.query(
      `DELETE FROM TALLY.container_paths
       WHERE DESCENDANT_ID IN (
         SELECT DESCENDANT_ID FROM (
           SELECT DESCENDANT_ID FROM TALLY.container_paths WHERE ANCESTOR_ID = ?
         ) AS sub
       )`,
      [containerId]
    );
  }

  // Get all descendant container IDs (for "what's inside this?")
  async getDescendants(containerId) {
    const [rows] = await this.db.query(
      'SELECT DESCENDANT_ID, DEPTH FROM TALLY.container_paths WHERE ANCESTOR_ID = ? AND DEPTH > 0 ORDER BY DEPTH',
      [containerId]
    );
    return rows;
  }

  // Get ancestor path (for breadcrumbs)
  async getAncestors(containerId) {
    const [rows] = await this.db.query(
      'SELECT ANCESTOR_ID, DEPTH FROM TALLY.container_paths WHERE DESCENDANT_ID = ? AND DEPTH > 0 ORDER BY DEPTH DESC',
      [containerId]
    );
    return rows;
  }
}

module.exports = ClosureTableService;
```

- [ ] **Step 2: Write containers.service.js**

ContainersService:
- `getByArea(areaId)` — top-level containers in an area (PARENT_CONTAINER_ID IS NULL, DELETED_AT IS NULL)
- `getByParent(parentContainerId)` — direct children of a container
- `getById(id)` — container with nested container count, item count, breadcrumb path (via closure table ancestors)
- `getAllDescendantItems(containerId)` — all items in this container and all nested containers (closure table query)
- `create(data)` — INSERT + closure table addNode + QR code generation
- `update(id, data)` — UPDATE
- `move(id, newParentContainerId)` — UPDATE PARENT_CONTAINER_ID + closure table moveNode
- `softDelete(id)` — SET DELETED_AT (cascade to closure table removeNode)
- `getPropertyIdForContainer(containerId)` — resolve property via area FK

- [ ] **Step 3: Write containers.schema.js**

```javascript
const Joi = require('joi');

const createContainer = Joi.object({
  name: Joi.string().max(255).required(),
  type: Joi.string().max(50).required(),
  description: Joi.string().allow('', null),
  areaId: Joi.number().integer().required(),
  parentContainerId: Joi.number().integer().allow(null),
});

const updateContainer = Joi.object({
  name: Joi.string().max(255),
  type: Joi.string().max(50),
  description: Joi.string().allow('', null),
}).min(1);

const moveContainer = Joi.object({
  parentContainerId: Joi.number().integer().allow(null).required(),
});

module.exports = { createContainer, updateContainer, moveContainer };
```

- [ ] **Step 4: Write containers.routes.js**

Routes:
- `GET /api/containers/_x_/area/:areaId` — top-level containers in area
- `GET /api/containers/_x_/:containerId` — container detail (with nested + items)
- `GET /api/containers/_x_/:containerId/children` — direct child containers
- `GET /api/containers/_x_/:containerId/all-items` — all items in subtree
- `POST /api/containers/_y_/create` — create container
- `PUT /api/containers/_u_/:containerId` — update container
- `PATCH /api/containers/_p_/:containerId/move` — move container
- `DELETE /api/containers/_d_/:containerId` — soft delete

- [ ] **Step 5: Test container nesting**

```bash
# Create top-level container
curl -X POST http://localhost:2727/api/containers/_y_/create \
  -H "Content-Type: application/json" -b "session_token=dev" \
  -d '{"name": "Blue Storage Tote", "type": "tote", "areaId": 1}'

# Create nested container
curl -X POST http://localhost:2727/api/containers/_y_/create \
  -H "Content-Type: application/json" -b "session_token=dev" \
  -d '{"name": "Ornaments Box", "type": "box", "areaId": 1, "parentContainerId": 1}'

# Verify closure table
curl http://localhost:2727/api/containers/_x_/1 -b "session_token=dev"
```

Expected: Container detail shows nested containers. Closure table has entries for self-reference and parent-child paths.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/inventory/containers.* server/src/modules/inventory/closure-table.service.js
git commit -m "feat: containers CRUD with closure table for unlimited nesting"
```

---

### Task 10: Inventory Module — Items

**Files:**
- Create: `server/src/modules/inventory/items.routes.js`
- Create: `server/src/modules/inventory/items.service.js`
- Create: `server/src/modules/inventory/items.schema.js`

- [ ] **Step 1: Write items.service.js**

ItemsService:
- `getByContainer(containerId)` — items in a container (DELETED_AT IS NULL)
- `getById(id)` — item with product data (LEFT JOIN products), container breadcrumb, dates, accessories
- `create(data)` — INSERT + QR code generation (TLY-I-{HEX})
- `update(id, data)` — UPDATE
- `move(id, newContainerId)` — UPDATE CONTAINER_ID
- `softDelete(id)` — SET DELETED_AT, STATUS = 'removed'
- `restore(id)` — SET DELETED_AT = NULL, STATUS = 'active'
- `search(query, userId)` — FULLTEXT search across items + products, filtered by user's properties
- `getPropertyIdForItem(itemId)` — resolve property via container → area chain

- [ ] **Step 2: Write items.schema.js**

```javascript
const Joi = require('joi');

const createItem = Joi.object({
  name: Joi.string().max(255).required(),
  description: Joi.string().allow('', null),
  containerId: Joi.number().integer().required(),
  productId: Joi.number().integer().allow(null),
  quantity: Joi.number().integer().min(1).default(1),
  purchasePrice: Joi.number().precision(2).allow(null),
  condition: Joi.string().valid('new', 'good', 'fair', 'poor').default('good'),
});

const updateItem = Joi.object({
  name: Joi.string().max(255),
  description: Joi.string().allow('', null),
  quantity: Joi.number().integer().min(1),
  purchasePrice: Joi.number().precision(2).allow(null),
  condition: Joi.string().valid('new', 'good', 'fair', 'poor'),
  depreciationEnabled: Joi.boolean(),
  depreciationRate: Joi.number().precision(4).min(0).max(1).allow(null),
}).min(1);

const moveItem = Joi.object({
  containerId: Joi.number().integer().required(),
});

const searchItems = Joi.object({
  q: Joi.string().min(1).max(255).required(),
  propertyId: Joi.number().integer(),
  condition: Joi.string().valid('new', 'good', 'fair', 'poor'),
  status: Joi.string().valid('active', 'removed', 'lent'),
});

module.exports = { createItem, updateItem, moveItem, searchItems };
```

- [ ] **Step 3: Write items.routes.js**

Routes:
- `GET /api/items/_x_/container/:containerId` — items in container
- `GET /api/items/_x_/:itemId` — item detail
- `GET /api/items/_x_/search` — full-text search (query param `q`)
- `POST /api/items/_y_/create` — create item
- `PUT /api/items/_u_/:itemId` — update item
- `PATCH /api/items/_p_/:itemId/move` — move item to new container
- `DELETE /api/items/_d_/:itemId` — soft delete

- [ ] **Step 4: Register inventory routes in index.js**

```javascript
require('./src/modules/inventory/properties.routes')({ app, db, logger, config });
require('./src/modules/inventory/areas.routes')({ app, db, logger, config });
require('./src/modules/inventory/containers.routes')({ app, db, logger, config });
require('./src/modules/inventory/items.routes')({ app, db, logger, config });
```

- [ ] **Step 5: Test items and search**

```bash
# Create item
curl -X POST http://localhost:2727/api/items/_y_/create \
  -H "Content-Type: application/json" -b "session_token=dev" \
  -d '{"name": "Dyson V15 Vacuum", "containerId": 1, "condition": "good", "purchasePrice": 749.99}'

# Search
curl "http://localhost:2727/api/items/_x_/search?q=dyson" -b "session_token=dev"
```

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/inventory/items.*
git commit -m "feat: items CRUD with full-text search and container placement"
```

---

### Task 11: Client Scaffolding — React, Radix, Tailwind v4, Design System

**Files:**
- Create: `client/package.json`
- Create: `client/tsconfig.json`
- Create: `client/vite.config.ts`
- Create: `client/postcss.config.js`
- Create: `client/index.html`
- Create: `client/src/main.tsx`
- Create: `client/src/globals.css`
- Create: `client/src/lib/utils.ts`

- [ ] **Step 1: Create client/package.json**

```json
{
  "name": "tally-client",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.30.0",
    "@tanstack/react-query": "^5.90.0",
    "@radix-ui/react-dialog": "^1.1.0",
    "@radix-ui/react-dropdown-menu": "^2.1.0",
    "@radix-ui/react-select": "^2.1.0",
    "@radix-ui/react-separator": "^1.1.0",
    "@radix-ui/react-slot": "^1.1.0",
    "@radix-ui/react-tooltip": "^1.1.0",
    "lucide-react": "^0.575.0",
    "clsx": "^2.1.1",
    "tailwind-merge": "^3.0.0",
    "class-variance-authority": "^0.7.0",
    "sonner": "^2.0.7",
    "zustand": "^5.0.10",
    "zod": "^4.3.6",
    "react-hook-form": "^7.71.0",
    "@hookform/resolvers": "^5.2.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.4",
    "@tailwindcss/vite": "^4.2.0",
    "tailwindcss": "^4.2.0",
    "typescript": "^5.9.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0"
  }
}
```

- [ ] **Step 2: Run npm install**

```bash
cd client && npm install
```

- [ ] **Step 3: Create vite.config.ts**

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3000,
    proxy: {
      '/api': 'http://localhost:2727',
    },
  },
  build: {
    outDir: 'dist',
  },
});
```

- [ ] **Step 4: Create tsconfig.json**

Standard React + TypeScript config with `@` path alias, strict mode, target ES2022.

- [ ] **Step 5: Create postcss.config.js**

```javascript
export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};
```

- [ ] **Step 6: Create src/globals.css with OKLCH theme tokens**

Tailwind v4 CSS with full light + dark mode token definitions:

```css
@import "tailwindcss";

@theme {
  /* Typography */
  --font-sans: 'Inter', ui-sans-serif, system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, monospace;

  /* Border radius */
  --radius-sm: 0.375rem;
  --radius-md: 0.5rem;
  --radius-lg: 0.625rem;
}

/* Light mode (default) */
:root {
  --color-bg: oklch(0.98 0 0);
  --color-card: oklch(1 0 0);
  --color-elevated: oklch(0.96 0 0);
  --color-border: oklch(0.88 0 0);
  --color-text: oklch(0.15 0 0);
  --color-text-secondary: oklch(0.45 0 0);
  --color-text-muted: oklch(0.6 0 0);
  --color-primary: oklch(0.55 0.2 260);
  --color-primary-bg: oklch(0.55 0.2 260 / 0.08);
  --color-green: oklch(0.6 0.19 155);
  --color-green-bg: oklch(0.6 0.19 155 / 0.08);
  --color-amber: oklch(0.7 0.17 75);
  --color-amber-bg: oklch(0.7 0.17 75 / 0.08);
  --color-red: oklch(0.6 0.2 25);
  --color-red-bg: oklch(0.6 0.2 25 / 0.08);
  --color-purple: oklch(0.6 0.17 300);
  --color-purple-bg: oklch(0.6 0.17 300 / 0.08);
}

/* Dark mode */
.dark {
  --color-bg: oklch(0.16 0 0);
  --color-card: oklch(0.2 0 0);
  --color-elevated: oklch(0.24 0 0);
  --color-border: oklch(0.28 0 0);
  --color-text: oklch(0.97 0 0);
  --color-text-secondary: oklch(0.7 0 0);
  --color-text-muted: oklch(0.5 0 0);
  --color-primary: oklch(0.7 0.15 260);
  --color-primary-bg: oklch(0.7 0.15 260 / 0.12);
  --color-green: oklch(0.72 0.17 155);
  --color-green-bg: oklch(0.72 0.17 155 / 0.12);
  --color-amber: oklch(0.78 0.15 75);
  --color-amber-bg: oklch(0.78 0.15 75 / 0.12);
  --color-red: oklch(0.7 0.18 25);
  --color-red-bg: oklch(0.7 0.18 25 / 0.12);
  --color-purple: oklch(0.7 0.14 300);
  --color-purple-bg: oklch(0.7 0.14 300 / 0.12);
}

/* System preference detection */
@media (prefers-color-scheme: dark) {
  :root:not(.light) {
    /* Apply dark tokens when system prefers dark and no explicit .light override */
    --color-bg: oklch(0.16 0 0);
    --color-card: oklch(0.2 0 0);
    --color-elevated: oklch(0.24 0 0);
    --color-border: oklch(0.28 0 0);
    --color-text: oklch(0.97 0 0);
    --color-text-secondary: oklch(0.7 0 0);
    --color-text-muted: oklch(0.5 0 0);
    --color-primary: oklch(0.7 0.15 260);
    --color-primary-bg: oklch(0.7 0.15 260 / 0.12);
    --color-green: oklch(0.72 0.17 155);
    --color-green-bg: oklch(0.72 0.17 155 / 0.12);
    --color-amber: oklch(0.78 0.15 75);
    --color-amber-bg: oklch(0.78 0.15 75 / 0.12);
    --color-red: oklch(0.7 0.18 25);
    --color-red-bg: oklch(0.7 0.18 25 / 0.12);
    --color-purple: oklch(0.7 0.14 300);
    --color-purple-bg: oklch(0.7 0.14 300 / 0.12);
  }
}

body {
  background-color: var(--color-bg);
  color: var(--color-text);
  font-family: var(--font-sans);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
```

- [ ] **Step 7: Create src/lib/utils.ts**

```typescript
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 8: Create index.html**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="theme-color" content="#1c1c1c" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
    <title>Tally</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 9: Create src/main.tsx**

```typescript
import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'sonner';
import { queryClient } from '@/lib/query-client';
import { App } from '@/App';
import '@/globals.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
        <Toaster position="bottom-center" />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);
```

- [ ] **Step 10: Verify dev server starts**

```bash
cd client && npm run dev
```

Expected: Vite dev server on port 3000. Empty page with correct fonts loading.

- [ ] **Step 11: Commit**

```bash
git add client/
git commit -m "feat: client scaffolding — React 18, Radix UI, Tailwind v4, OKLCH theme"
```

---

### Task 12: Client — Core UI Components

**Files:**
- Create: `client/src/lib/api.ts`
- Create: `client/src/lib/query-client.ts`
- Create: `client/src/types/api.ts`
- Create: `client/src/types/inventory.ts`
- Create: `client/src/types/auth.ts`
- Create: `client/src/components/ui/button.tsx`
- Create: `client/src/components/ui/card.tsx`
- Create: `client/src/components/ui/input.tsx`
- Create: `client/src/components/ui/badge.tsx`
- Create: `client/src/components/ui/skeleton.tsx`
- Create: `client/src/components/ui/dialog.tsx`
- Create: `client/src/components/ui/toast.tsx`

- [ ] **Step 1: Create types**

`types/api.ts`:
```typescript
export interface ApiResponse<T> {
  success: boolean;
  message: string;
  data: T;
  meta?: Record<string, unknown>;
}
```

`types/inventory.ts`:
```typescript
export interface Property {
  id: number;
  name: string;
  address: string | null;
  description: string | null;
  qrCode: string;
  role: 'owner' | 'editor' | 'viewer';
  areaCount: number;
  containerCount: number;
  itemCount: number;
  createdAt: string;
}

export interface Area {
  id: number;
  propertyId: number;
  name: string;
  description: string | null;
  qrCode: string;
  containerCount: number;
  itemCount: number;
}

export interface Container {
  id: number;
  areaId: number;
  parentContainerId: number | null;
  name: string;
  type: string;
  description: string | null;
  qrCode: string;
  nestedContainerCount: number;
  itemCount: number;
  breadcrumb: BreadcrumbItem[];
}

export interface Item {
  id: number;
  containerId: number;
  productId: number | null;
  name: string;
  description: string | null;
  quantity: number;
  purchasePrice: number | null;
  currentValue: number | null;
  condition: 'new' | 'good' | 'fair' | 'poor';
  qrCode: string;
  status: 'active' | 'removed' | 'lent';
  product?: Product;
}

export interface Product {
  id: number;
  barcode: string;
  name: string;
  brand: string;
  category: string;
  imageUrl: string | null;
  retailPrice: number | null;
}

export interface BreadcrumbItem {
  id: number;
  name: string;
  type: 'property' | 'area' | 'container';
}
```

`types/auth.ts`:
```typescript
export interface User {
  id: number;
  email: string;
  displayName: string;
  avatarUrl: string | null;
}
```

- [ ] **Step 2: Create lib/api.ts**

Fetch wrapper:
- `get<T>(path)`, `post<T>(path, body)`, `put<T>(path, body)`, `patch<T>(path, body)`, `del<T>(path)`
- Credentials: 'include' (sends cookies)
- Content-Type: application/json
- Handles non-OK responses: throws error with server message
- Base URL: `''` (proxied by Vite in dev, Nginx in prod)

- [ ] **Step 3: Create lib/query-client.ts**

React Query client with:
- Default staleTime: 30 seconds
- No retry on 4xx
- Query key factory: `queryKeys.properties.list()`, `.detail(id)`, `queryKeys.areas.byProperty(id)`, etc.

- [ ] **Step 4: Create UI components**

Build each component following Radix UI + CVA + Tailwind pattern. Use the OKLCH CSS custom properties defined in globals.css. No hardcoded colors — everything uses `var(--color-*)` tokens.

- `button.tsx` — Radix Slot, CVA variants (default, outline, ghost, destructive), sizes (sm, md, lg)
- `card.tsx` — Simple div with `bg-[var(--color-card)] border border-[var(--color-border)]` + rounded
- `input.tsx` — Styled input with focus ring using primary color
- `badge.tsx` — CVA variants for status colors (condition, role badges)
- `skeleton.tsx` — Animated loading placeholder
- `dialog.tsx` — Radix Dialog with overlay + content styling
- `toast.tsx` — Re-export Sonner's Toaster with theme-aware config

- [ ] **Step 5: Commit**

```bash
git add client/src/
git commit -m "feat: core UI components — button, card, input, badge, dialog, types"
```

---

### Task 13: Client — Layout Shell & Navigation

**Files:**
- Create: `client/src/components/layout/root-layout.tsx`
- Create: `client/src/components/layout/bottom-nav.tsx`
- Create: `client/src/components/layout/header.tsx`
- Create: `client/src/components/layout/breadcrumbs.tsx`
- Create: `client/src/store/auth-store.ts`
- Create: `client/src/hooks/use-auth.ts`
- Create: `client/src/App.tsx`
- Create: `client/src/pages/login.tsx`
- Create: `client/src/pages/oauth-callback.tsx`

- [ ] **Step 1: Create auth store and hook**

`store/auth-store.ts` — Zustand store:
```typescript
interface AuthState {
  user: User | null;
  isLoading: boolean;
  theme: 'light' | 'dark' | 'system';
  setUser: (user: User | null) => void;
  setTheme: (theme: 'light' | 'dark' | 'system') => void;
  checkSession: () => Promise<void>;
  logout: () => Promise<void>;
}
```

Theme toggle: applies `.dark` or `.light` class on `<html>`, persists preference to localStorage.

`hooks/use-auth.ts` — wraps the store, calls `checkSession()` on mount.

- [ ] **Step 2: Create layout components**

`root-layout.tsx`:
- Full-screen flex column
- Header at top (fixed)
- Scrollable main content area
- Bottom nav at bottom (fixed)
- Shows login page if user is null and loading is false

`bottom-nav.tsx`:
- 5 tabs: Home, Inventory, Scan (center, prominent), Reports, Settings
- Uses Lucide icons: Home, Layers, ScanLine, BarChart2, Settings
- Scan button is elevated circle (primary color)
- Active tab highlighted with primary color
- Uses react-router `useLocation` + `useNavigate`

`header.tsx`:
- "Tally" title left-aligned
- Notification bell right-aligned (placeholder count badge)
- Breadcrumbs below (when in drill-down views)

`breadcrumbs.tsx`:
- Accepts `items: BreadcrumbItem[]`
- Renders: "Property > Area > Container" with chevron separators
- Each segment is a link back to that level
- Uses JetBrains Mono for TLY IDs

- [ ] **Step 3: Create App.tsx with routing**

```typescript
import { Routes, Route, Navigate } from 'react-router-dom';
import { RootLayout } from '@/components/layout/root-layout';
import { Home } from '@/pages/home';
import { Inventory } from '@/pages/inventory';
import { PropertyDetail } from '@/pages/property-detail';
import { AreaDetail } from '@/pages/area-detail';
import { ContainerDetail } from '@/pages/container-detail';
import { ItemDetail } from '@/pages/item-detail';
import { Scan } from '@/pages/scan';
import { Reports } from '@/pages/reports';
import { Settings } from '@/pages/settings';
import { Login } from '@/pages/login';
import { OAuthCallback } from '@/pages/oauth-callback';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/oauth/callback" element={<OAuthCallback />} />
      <Route path="/s/:code" element={<Navigate to="/" />} /> {/* QR deep link — Phase 3 will implement full resolution */}
      <Route element={<RootLayout />}>
        <Route index element={<Home />} />
        <Route path="/inventory" element={<Inventory />} />
        <Route path="/property/:propertyId" element={<PropertyDetail />} />
        <Route path="/area/:areaId" element={<AreaDetail />} />
        <Route path="/container/:containerId" element={<ContainerDetail />} />
        <Route path="/item/:itemId" element={<ItemDetail />} />
        <Route path="/scan" element={<Scan />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<Navigate to="/" />} />
    </Routes>
  );
}
```

- [ ] **Step 4: Create login and callback pages**

`login.tsx` — Simple page with "Sign in with Microsoft" button. Redirects to `/api/auth/_x_/oauth/init`.

`oauth-callback.tsx` — Handles redirect from Entra ID. Extracts code/state from URL, calls API, redirects to `/` on success.

- [ ] **Step 5: Verify layout renders**

```bash
cd client && npm run dev
```

Open http://localhost:3000. Expected: Layout shell with header, bottom nav, and empty home page. Theme toggle works.

- [ ] **Step 6: Commit**

```bash
git add client/src/
git commit -m "feat: layout shell — header, bottom nav, routing, auth flow"
```

---

### Task 14: Client — Inventory Pages (Properties, Areas, Containers, Items)

**Files:**
- Create: `client/src/hooks/use-inventory.ts`
- Create: `client/src/components/inventory/property-card.tsx`
- Create: `client/src/components/inventory/area-card.tsx`
- Create: `client/src/components/inventory/container-card.tsx`
- Create: `client/src/components/inventory/item-card.tsx`
- Create: `client/src/components/inventory/entity-form.tsx`
- Create: `client/src/pages/home.tsx`
- Create: `client/src/pages/inventory.tsx`
- Create: `client/src/pages/property-detail.tsx`
- Create: `client/src/pages/area-detail.tsx`
- Create: `client/src/pages/container-detail.tsx`
- Create: `client/src/pages/item-detail.tsx`
- Create: `client/src/pages/scan.tsx` (placeholder)
- Create: `client/src/pages/reports.tsx` (placeholder)
- Create: `client/src/pages/settings.tsx` (shell)

- [ ] **Step 1: Create use-inventory.ts**

React Query hooks using query key factory:
- `useProperties()` — GET /api/properties/_x_/list
- `useProperty(id)` — GET /api/properties/_x_/:id
- `useCreateProperty()` — POST mutation
- `useUpdateProperty()` — PUT mutation
- `useDeleteProperty()` — DELETE mutation
- `useAreas(propertyId)` — GET /api/areas/_x_/property/:id
- `useArea(id)` — GET /api/areas/_x_/:id
- `useCreateArea()` — POST mutation
- `useContainers(areaId)` — GET /api/containers/_x_/area/:id
- `useContainerChildren(containerId)` — GET /api/containers/_x_/:id/children
- `useContainer(id)` — GET /api/containers/_x_/:id
- `useCreateContainer()` — POST mutation
- `useItems(containerId)` — GET /api/items/_x_/container/:id
- `useItem(id)` — GET /api/items/_x_/:id
- `useCreateItem()` — POST mutation
- `useUpdateItem()` — PUT mutation
- `useMoveItem()` — PATCH mutation
- `useSearchItems(query)` — GET /api/items/_x_/search?q=

All mutations invalidate relevant queries on success.

- [ ] **Step 2: Create entity card components**

Each card component:
- Uses `<Card>` UI component
- Shows icon in colored background square (from design system)
- Name, TLY code (JetBrains Mono), counts
- Chevron-right for navigation
- Click navigates to detail page
- Property cards show role badge if shared

`property-card.tsx` — Home icon (primary), warehouse icon (amber) for storage units
`area-card.tsx` — Door icon
`container-card.tsx` — Package icon (amber)
`item-card.tsx` — Image placeholder, name, TLY code, condition badge, price

- [ ] **Step 3: Create entity-form.tsx**

Shared form component using react-hook-form:
- Props: `type: 'property' | 'area' | 'container' | 'item'`, `defaultValues`, `onSubmit`
- Renders appropriate fields per type
- Used in both create dialog and edit mode
- Validates with Zod schemas matching server Joi schemas

- [ ] **Step 4: Create pages**

`home.tsx`:
- Search input at top (calls useSearchItems on submit)
- Quick action buttons: Scan + Add Item
- Properties list (useProperties)
- Recent activity section (placeholder — audit trail is Phase 4)

`inventory.tsx`:
- Same as home properties list but full-page
- Serves as the "all properties" view

`property-detail.tsx`:
- Header with property name, TLY code, address
- Action bar: Add Area button
- Areas list (useAreas)
- Create area dialog

`area-detail.tsx`:
- Breadcrumb: Property > Area
- Action bar: Add Container
- Containers list (useContainers)
- Create container dialog

`container-detail.tsx`:
- Breadcrumb: Property > Area > Container (nested breadcrumb from closure table ancestors)
- Action bar: Scan Into, Print Label (placeholder), Share (placeholder)
- Tags display (placeholder — Phase 3)
- Nested containers section (useContainerChildren)
- Items section (useItems)
- Create container / create item dialogs
- FAB: contextual add button

`item-detail.tsx`:
- Breadcrumb: Property > Area > Container
- Item image / placeholder
- Name, TLY code, condition badge, status
- Product info (if linked)
- Purchase price, current value
- Dates section (placeholder — Phase 4)
- Accessories section (placeholder — Phase 4)
- Files section (placeholder — Phase 2)
- Condition history (placeholder — Phase 2)
- Edit / Move / Delete actions

`scan.tsx` — Placeholder page with "Camera scanning coming in Phase 2" message
`reports.tsx` — Placeholder page
`settings.tsx` — Shell with theme toggle (light/dark/system), user profile display

- [ ] **Step 5: End-to-end test**

Start Docker Compose:
```bash
task up
```

Open http://localhost:8080 (or 3000 for Vite dev).
1. Create a property
2. Create an area inside it
3. Create a container in the area
4. Create a nested container
5. Create items in both containers
6. Navigate the full hierarchy via breadcrumbs
7. Search for an item
8. Toggle dark/light mode

- [ ] **Step 6: Commit**

```bash
git add client/src/
git commit -m "feat: inventory UI — properties, areas, containers, items, search, drill-down"
```

---

### Task 15: Final Integration & Cleanup

**Files:**
- Modify: `server/index.js` (ensure all routes registered)
- Modify: `docker-compose.yml` (verify all services work together)
- Modify: `CLAUDE.md` (update with actual project commands)

- [ ] **Step 1: Verify full Docker Compose integration**

```bash
task down
task up
```

All 5 services should start. Client should serve the full UI via Nginx proxy.

- [ ] **Step 2: Test complete flow through Nginx**

Via port 8080 (Nginx):
1. Load http://localhost:8080 — app renders
2. Create property, area, container, item
3. Navigate hierarchy
4. Search works
5. API calls go through /api/ proxy

- [ ] **Step 3: Update CLAUDE.md with actual commands and architecture**

Document:
- How to start (`task init` for first time, `task up` for normal)
- Module structure with file paths
- API conventions
- Database access (`task db:shell`)

- [ ] **Step 4: Final commit**

```bash
git add .
git commit -m "feat: phase 1 complete — foundation, auth, inventory CRUD, UI shell"
```

---

## Phase Summary

After completing Phase 1, you will have:

- **Working backend** with auth (Entra ID + dev bypass), full inventory CRUD (properties, areas, containers with closure table, items), full-text search
- **Working frontend** with mobile-first responsive UI, light/dark mode, design system (Radix + Tailwind v4 OKLCH), inventory browser with drill-down navigation, search
- **Full database** with all 19+ tables ready for future phases
- **Docker Compose** local dev environment with MySQL, MinIO, Vault
- **15 git commits** tracking incremental progress

**Next: Phase 2 — Item Intelligence & Files** (products catalog, barcode lookup, camera scanner, file uploads)

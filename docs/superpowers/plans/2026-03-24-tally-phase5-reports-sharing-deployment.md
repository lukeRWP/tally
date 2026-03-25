# Tally Phase 5: Reports, Sharing & Deployment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add PDF/CSV report generation, time-limited share links for public read-only views, PW deployment manifest (app.yml), and GitHub Actions CI/CD pipelines — completing all Tally features.

**Architecture:** New `reports` and `sharing` backend modules. Reports use pdfkit (already installed from Phase 3 labels) for PDF and csv-writer for CSV. Share links generate URL-safe tokens with expiry, served by public (no-auth) routes that render read-only entity views. Deployment uses the same PW app.yml manifest pattern as EMP, with a single production environment (no QA).

**Tech Stack:** pdfkit (already installed), csv-writer (new), crypto.randomBytes for share tokens

**Spec:** `docs/superpowers/specs/2026-03-23-tally-design.md` — Sections 4 (Share Links), 8 (Reports), 11 (Backend Modules: reports, sharing), 12 (Deployment)

**Depends on:** Phase 4 complete (`/Users/luke/dev/tally/`)

---

## File Structure

### New Server Files

```
server/src/modules/
├── reports/
│   ├── reports.routes.js       # Report generation endpoints
│   ├── reports.service.js      # Data aggregation + PDF/CSV rendering
│   └── reports.schema.js       # Joi validation
└── sharing/
    ├── sharing.routes.js       # Share link CRUD + public view endpoints
    ├── sharing.service.js      # Token generation, validation, expiry
    └── sharing.schema.js       # Joi validation
```

### New Root Files

```
tally/
├── app.yml                     # PW deployment manifest
└── .github/
    ├── actions/
    │   └── setup-node/
    │       └── action.yml      # Reusable Node.js setup action
    └── workflows/
        ├── ci.yml              # PR validation (lint, build, audit)
        └── build.yml           # Build + deploy on push to master
```

### New Client Files

```
client/src/
├── components/
│   └── sharing/
│       ├── share-dialog.tsx    # Generate/manage share links
│       └── share-view.tsx      # Public read-only entity view
├── hooks/
│   ├── use-reports.ts
│   └── use-sharing.ts
└── pages/
    ├── reports.tsx             # Replace placeholder with real reports page
    └── share-view.tsx          # Public share page (no auth required)
```

### Modified Files

```
server/index.js                     # Register reports + sharing routes
server/package.json                 # Add csv-writer
client/src/App.tsx                  # Add share view route
client/src/pages/item-detail.tsx    # Wire share button
client/src/pages/container-detail.tsx # Wire share button
client/src/pages/settings.tsx       # Add share links management
```

---

## Task Breakdown

### Task 1: Reports Module — Backend

**Files:**
- Create: `server/src/modules/reports/reports.routes.js`
- Create: `server/src/modules/reports/reports.service.js`
- Create: `server/src/modules/reports/reports.schema.js`
- Modify: `server/package.json` — add csv-writer
- Modify: `server/index.js` — register reports routes

- [ ] **Step 1: Install csv-writer**

```bash
cd server && npm install csv-writer
```

- [ ] **Step 2: Write reports.service.js**

ReportsService:
- `init({ db, logger, config })` — stores refs
- `insuranceSummary(propertyId)` — Query all active items in a property with purchase price, current value (calculate depreciation on-demand), condition, product info, and condition photos. JOIN items → containers → areas → products, LEFT JOIN condition_snapshots (latest per item). Return structured data.
- `totalValue(propertyId, { groupBy = 'property' })` — Aggregate SUM(PURCHASE_PRICE) and calculated current values. Group by property, area, or tag depending on param.
- `itemsByLocation(propertyId)` — Hierarchical data: property → areas → containers (nested) → items. Use closure table for nested containers.
- `lendingReport(propertyId)` — SELECT from item_lending WHERE RETURNED_AT IS NULL, scoped to property. Include item name, location, lent to, dates.
- `activityLog(propertyId, { limit, offset, startDate, endDate })` — SELECT from change_log for property. Include user names.
- `tagReport(propertyId, tagIds)` — SELECT items with specified tags. JOIN entity_tags.
- `generatePdf(reportType, data, options)` — Use pdfkit to render report as PDF. Each report type has its own layout:
  - Insurance: table with item name, purchase price, current value, condition, photo thumbnails
  - Total Value: summary table with subtotals
  - Items by Location: hierarchical indented list
  - Lending: table format
  - Tag: items grouped by tag
  Return PDF buffer.
- `generateCsv(reportType, data)` — Use csv-writer to generate CSV string. Flatten hierarchical data into rows. Return CSV string.

- [ ] **Step 3: Write reports.schema.js**

```javascript
const Joi = require('joi');

const generateReport = Joi.object({
  reportType: Joi.string().valid('insurance', 'total_value', 'items_by_location', 'lending', 'activity_log', 'tag').required(),
  propertyId: Joi.number().integer().required(),
  format: Joi.string().valid('pdf', 'csv').default('pdf'),
  groupBy: Joi.string().valid('property', 'area', 'tag').default('property'),
  tagIds: Joi.array().items(Joi.number().integer()).allow(null),
  startDate: Joi.date().iso().allow(null),
  endDate: Joi.date().iso().allow(null),
  limit: Joi.number().integer().min(1).max(1000).default(500),
  offset: Joi.number().integer().min(0).default(0),
});

module.exports = { generateReport };
```

- [ ] **Step 4: Write reports.routes.js**

Routes (all require auth + property membership):
- `POST /api/reports/_y_/generate` — Generate report. Validate body with generateReport schema. resolvePropertyRole (from body.propertyId), check membership.
  - If format is 'pdf': generate PDF, set Content-Type: application/pdf, Content-Disposition: attachment, send buffer.
  - If format is 'csv': generate CSV, set Content-Type: text/csv, Content-Disposition: attachment, send string.
- `GET /api/reports/_x_/preview/:reportType/:propertyId` — Preview report data as JSON (for UI preview before download). resolvePropertyRole, check membership.

- [ ] **Step 5: Register and commit**

```javascript
require('./src/modules/reports/reports.routes')({ app, db, logger, config });
```

```bash
git add server/src/modules/reports/ server/index.js server/package.json server/package-lock.json
git commit -m "feat: reports module — insurance, value, location, lending, activity, tag reports (PDF + CSV)"
```

---

### Task 2: Sharing Module — Backend

**Files:**
- Create: `server/src/modules/sharing/sharing.routes.js`
- Create: `server/src/modules/sharing/sharing.service.js`
- Create: `server/src/modules/sharing/sharing.schema.js`
- Modify: `server/index.js` — register sharing routes

- [ ] **Step 1: Write sharing.service.js**

SharingService:
- `init({ db, logger, config })` — stores refs. `baseUrl` = config.clientUrl.
- `create(entityType, entityId, createdBy, expiresInDays = 7)` — Generate URL-safe token via `crypto.randomBytes(32).toString('hex')`. INSERT into share_links (TOKEN, ENTITY_TYPE, ENTITY_ID, CREATED_BY, EXPIRES_AT = DATE_ADD(NOW(), INTERVAL ? DAY)). Return `{ token, url: ${baseUrl}/share/${token}, expiresAt }`.
- `validate(token)` — SELECT from share_links WHERE TOKEN = ? AND EXPIRES_AT > NOW(). Return `{ entityType, entityId, createdBy }` or null if expired/invalid.
- `getByUser(userId)` — SELECT share_links WHERE CREATED_BY = ? ORDER BY CREATED_AT DESC. Return camelCase array.
- `revoke(linkId, userId)` — DELETE FROM share_links WHERE ID = ? AND CREATED_BY = ?
- `getEntityForShare(entityType, entityId)` — Fetch the entity with relevant data for the public view:
  - 'property': property + areas + containers + items (full hierarchy)
  - 'area': area + containers + items
  - 'container': container + nested containers + items (use closure table)
  - 'item': item + product info + condition history + files (presigned URLs)
  Return structured camelCase data.

- [ ] **Step 2: Write sharing.schema.js**

```javascript
const Joi = require('joi');

const createShareLink = Joi.object({
  entityType: Joi.string().valid('property', 'area', 'container', 'item').required(),
  entityId: Joi.number().integer().required(),
  expiresInDays: Joi.number().integer().min(1).max(90).default(7),
});

module.exports = { createShareLink };
```

- [ ] **Step 3: Write sharing.routes.js**

Two categories of routes:

**Authenticated routes (managing share links):**
- `POST /api/sharing/_y_/create` — create share link. Auth required. Validate body. Resolve property from entity, requireRole('owner', 'editor').
- `GET /api/sharing/_x_/my-links` — list user's share links. Auth required.
- `DELETE /api/sharing/_d_/:linkId` — revoke share link. Auth required.

**Public routes (no auth required — accessible by anyone with the token):**
- `GET /api/sharing/_x_/view/:token` — validate token, return entity data for public view. NO auth middleware. If token invalid/expired, return 404.

IMPORTANT: The public route must NOT use requireAuth middleware. It should be registered before the auth middleware or use a specific bypass.

- [ ] **Step 4: Register and commit**

Register sharing routes. NOTE: The public view route needs special handling since it doesn't require auth. You can either:
- Register it before auth middleware in index.js, OR
- Use a conditional auth skip in the route itself

Simplest approach: register sharing routes normally, and in the public route handler, don't use requireAuth.

```javascript
require('./src/modules/sharing/sharing.routes')({ app, db, logger, config });
```

```bash
git add server/src/modules/sharing/ server/index.js
git commit -m "feat: sharing module — time-limited share links, public read-only views"
```

---

### Task 3: Reports UI — Frontend

**Files:**
- Create: `client/src/hooks/use-reports.ts`
- Modify: `client/src/pages/reports.tsx` — replace placeholder with real reports page

- [ ] **Step 1: Create use-reports.ts**

```typescript
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

interface ReportParams {
  reportType: string;
  propertyId: number;
  format: 'pdf' | 'csv';
  groupBy?: string;
  tagIds?: number[];
  startDate?: string;
  endDate?: string;
}

export function useGenerateReport() {
  return useMutation({
    mutationFn: async (params: ReportParams) => {
      const res = await fetch('/api/reports/_y_/generate', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });

      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.message || 'Failed to generate report');
      }

      if (params.format === 'pdf') {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `tally-${params.reportType}-report.pdf`;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        const text = await res.text();
        const blob = new Blob([text], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `tally-${params.reportType}-report.csv`;
        a.click();
        URL.revokeObjectURL(url);
      }
    },
  });
}

export function useReportPreview(reportType: string, propertyId: number) {
  return useQuery({
    queryKey: ['reports', 'preview', reportType, propertyId],
    queryFn: () => api.get(`/api/reports/_x_/preview/${reportType}/${propertyId}`),
    enabled: !!reportType && !!propertyId,
  });
}
```

- [ ] **Step 2: Rewrite reports.tsx**

Replace placeholder with a real reports page:
- Property selector at top (dropdown of user's properties)
- Report type cards in a grid:
  - Insurance Summary — "All items with values, condition, photos" — FileText icon
  - Total Value — "Aggregate value by location or tag" — DollarSign icon
  - Items by Location — "Hierarchical inventory view" — Layers icon
  - Lending Report — "Currently lent items" — HandCoins icon
  - Activity Log — "Who did what, when" — History icon
  - Tag Report — "Items by selected tags" — Tag icon
- Click a report card → shows options panel:
  - Format: PDF or CSV buttons
  - Additional options per report type (e.g., groupBy for Total Value, tagIds for Tag Report, date range for Activity Log)
  - "Generate" button → calls useGenerateReport → auto-downloads
  - Loading state during generation
- Uses useProperties() for property selector

- [ ] **Step 3: Commit**

```bash
git add client/src/hooks/use-reports.ts client/src/pages/reports.tsx
git commit -m "feat: reports UI — generate and download PDF/CSV reports"
```

---

### Task 4: Sharing UI — Frontend

**Files:**
- Create: `client/src/hooks/use-sharing.ts`
- Create: `client/src/components/sharing/share-dialog.tsx`
- Create: `client/src/pages/share-view.tsx`
- Modify: `client/src/App.tsx` — add public share route
- Modify: `client/src/pages/container-detail.tsx` — wire share button
- Modify: `client/src/pages/item-detail.tsx` — wire share button

- [ ] **Step 1: Create use-sharing.ts**

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

interface ShareLink {
  id: number;
  token: string;
  entityType: string;
  entityId: number;
  url: string;
  expiresAt: string;
  createdAt: string;
}

export function useMyShareLinks() {
  return useQuery({
    queryKey: ['sharing', 'my-links'],
    queryFn: () => api.get<ShareLink[]>('/api/sharing/_x_/my-links'),
  });
}

export function useCreateShareLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { entityType: string; entityId: number; expiresInDays?: number }) =>
      api.post<ShareLink>('/api/sharing/_y_/create', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sharing'] }),
  });
}

export function useRevokeShareLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.del(`/api/sharing/_d_/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sharing'] }),
  });
}
```

- [ ] **Step 2: Create share-dialog.tsx**

Dialog for generating share links:
- Props: `entityType`, `entityId`, `entityName`, `isOpen`, `onOpenChange`
- Expiry selector: 1 day, 7 days, 30 days, 90 days (default: 7)
- "Generate Link" button → creates share link
- After generation: shows the URL in a copy-able input with "Copy" button
- Also shows existing active share links for this entity with revoke buttons

- [ ] **Step 3: Create share-view.tsx**

Public share page (NO auth required):
- Route: `/share/:token`
- Fetches entity data via `GET /api/sharing/_x_/view/${token}` using direct fetch (not api.ts which sends credentials)
- If valid: renders a read-only view of the entity
  - Property: show areas, containers, items in hierarchy
  - Container: show nested containers + items
  - Item: show name, condition, product info, photos, files, dates
- If expired/invalid: "This link has expired or is invalid" with link to home
- No bottom nav, no header — standalone page with "Powered by Tally" footer
- Mobile-responsive, uses the same OKLCH design tokens

- [ ] **Step 4: Update App.tsx**

Add the share route OUTSIDE the RootLayout (no auth, no nav):
```tsx
<Route path="/share/:token" element={<ShareView />} />
```

- [ ] **Step 5: Wire share buttons on detail pages**

**container-detail.tsx:** The "Share" action bar button opens `ShareDialog` with entityType="container".

**item-detail.tsx:** Add "Share" button that opens `ShareDialog` with entityType="item".

- [ ] **Step 6: Commit**

```bash
git add client/src/hooks/use-sharing.ts client/src/components/sharing/ client/src/pages/share-view.tsx client/src/App.tsx client/src/pages/container-detail.tsx client/src/pages/item-detail.tsx
git commit -m "feat: sharing UI — generate share links, public read-only views"
```

---

### Task 5: PW Deployment Manifest

**Files:**
- Create: `app.yml`

- [ ] **Step 1: Create app.yml**

Following the EMP manifest pattern but simplified for Tally (production only, no QA):

```yaml
name: tally
displayName: "Tally Home Inventory"
repo: "git@github.com:lukeRWP/tally.git"
vaultPrefix: "secret/apps/tally"

ansibleGroups:
  client: tally_clients
  server: tally_servers
  database: tally_databases
  storage: tally_storage

build:
  env: { NODE_ENV: development }
  components:
    client:
      dir: client
      install: "npm ci"
      build: "npm run build"
      tarball:
        name: "client.tar.gz"
        from: "dist"
        args: "-C dist ."
    server:
      dir: server
      install: "npm ci"
      tarball:
        name: "server.tar.gz"
        includes: [index.js, package.json, package-lock.json, src/]

databases:
  list:
    - TALLY
  schemaPrefix: "TALLY"
  adminDb: "TALLY"
  envVars:
    TALLY_DB: TALLY

vmTemplate:
  roles:
    client:
      - common
      - node-exporter
      - nodejs
      - nginx
      - app-client
    server:
      - common
      - node-exporter
      - nodejs
      - app-server
    database:
      - common
      - node-exporter
      - mysql
    storage:
      - common
      - node-exporter
      - minio
  healthChecks:
    server:
      path: "/health/live"
      port: 2727
    storage:
      path: "/minio/health/live"
      port: 9000
      scheme: https
    database:
      type: tcp
      port: 3306
    client:
      path: "/"
      port: 443
      scheme: https

environments:
  prod:
    vlan: 130
    cidr: "10.0.130.0/24"
    gateway: "10.0.130.1"
    terraformWorkspace: "prod"
    hosts:
      client: { ip: "10.0.130.10", proxmoxNode: "prx002" }
      server: { ip: "10.0.130.11", proxmoxNode: "prx002" }
      database: { ip: "10.0.130.12", proxmoxNode: "prx002" }
      storage: { ip: "10.0.130.13", proxmoxNode: "prx002" }
    pipeline:
      autoDeployBranch: "master"
      requiresApproval: false
```

NOTE: VLAN 130 and IPs are placeholders — the user will assign actual values when registering with PW. The structure must match what PW expects.

- [ ] **Step 2: Commit**

```bash
git add app.yml
git commit -m "feat: PW deployment manifest — production environment for Proxmox"
```

---

### Task 6: GitHub Actions CI/CD

**Files:**
- Create: `.github/actions/setup-node/action.yml`
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/build.yml`

- [ ] **Step 1: Create setup-node action**

Reusable composite action for Node.js setup (matching EMP pattern):

```yaml
name: 'Setup Node.js'
description: 'Install Node.js and configure npm'
inputs:
  node-version:
    description: 'Node.js version'
    default: '20'
runs:
  using: 'composite'
  steps:
    - uses: actions/setup-node@v4
      with:
        node-version: ${{ inputs.node-version }}
```

- [ ] **Step 2: Create ci.yml**

PR validation workflow (matching EMP CI pattern):

```yaml
name: CI
on:
  pull_request:
    branches: [master]
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  test-client:
    name: Test Client
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/setup-node
      - run: npm ci
        working-directory: client
      - run: npx tsc --noEmit
        working-directory: client
      - run: npm run build
        working-directory: client
        env:
          CI: true

  test-server:
    name: Test Server
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/setup-node
      - run: npm ci
        working-directory: server

  security-audit:
    name: Security Audit
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/setup-node
      - run: npm audit --production --audit-level=high
        working-directory: server
      - run: npm audit --production --audit-level=high
        working-directory: client
```

- [ ] **Step 3: Create build.yml**

Build and deploy workflow (matching EMP pattern):

```yaml
name: Build & Deploy
on:
  push:
    branches: [master]
  workflow_dispatch:

jobs:
  build-client:
    name: Build Client
    runs-on: self-hosted
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/setup-node
      - run: npm ci
        working-directory: client
      - run: npm run build
        working-directory: client
        env:
          CI: true
      - run: tar -czf tally-client.tar.gz -C client/dist .
      - uses: actions/upload-artifact@v4
        with:
          name: tally-client
          path: tally-client.tar.gz
          retention-days: 30

  build-server:
    name: Build Server
    runs-on: self-hosted
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/setup-node
      - run: npm ci
        working-directory: server
      - run: tar -czf tally-server.tar.gz -C server index.js package.json package-lock.json src/
      - uses: actions/upload-artifact@v4
        with:
          name: tally-server
          path: tally-server.tar.gz
          retention-days: 30

  build-db:
    name: Package Database
    runs-on: self-hosted
    steps:
      - uses: actions/checkout@v4
      - run: tar -czf tally-db.tar.gz SQL/
      - uses: actions/upload-artifact@v4
        with:
          name: tally-db
          path: tally-db.tar.gz
          retention-days: 30

  deploy:
    name: Deploy to Production
    needs: [build-client, build-server, build-db]
    runs-on: self-hosted
    environment: prod
    steps:
      - name: Deploy via Orchestrator
        run: |
          RESULT=$(curl -sf -X POST \
            "${{ vars.ORCHESTRATOR_URL }}/api/_y_/apps/tally/envs/prod/deploy" \
            -H "Authorization: Bearer ${{ secrets.ORCHESTRATOR_API_KEY }}" \
            -H "Content-Type: application/json" \
            --max-time 30 \
            -d '{"ref": "${{ github.sha }}"}')
          OP=$(echo "$RESULT" | jq -r '.data.opId')
          ATTEMPTS=0
          while [ $ATTEMPTS -lt 90 ]; do
            STATUS=$(curl -sf --max-time 10 \
              "${{ vars.ORCHESTRATOR_URL }}/api/_x_/ops/$OP" \
              -H "Authorization: Bearer ${{ secrets.ORCHESTRATOR_API_KEY }}" | jq -r '.data.status')
            case "$STATUS" in
              success) echo "Deploy succeeded"; exit 0 ;;
              failed) echo "Deploy failed"; exit 1 ;;
              *) ATTEMPTS=$((ATTEMPTS + 1)); sleep 10 ;;
            esac
          done
          echo "::error::Deploy timed out"
          exit 1
        timeout-minutes: 16
```

- [ ] **Step 4: Commit**

```bash
git add .github/ app.yml
git commit -m "feat: CI/CD pipelines — PR validation, build, deploy via PW orchestrator"
```

---

### Task 7: Final Integration & Build Verification

**Files:**
- Modify: `CLAUDE.md`
- Verify TypeScript + build

- [ ] **Step 1: Verify TypeScript and build**

```bash
cd client && npx tsc --noEmit && npm run build
```

- [ ] **Step 2: Update CLAUDE.md**

Add final modules to routes table: reports, sharing. Add sections on:
- Report types and export formats
- Share links (time-limited, public, no auth)
- Deployment via PW (app.yml manifest, prod-only)
- CI/CD pipelines (ci.yml for PRs, build.yml for deploys)

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat: tally v1.0 complete — all features implemented across 5 phases"
```

---

## Phase Summary

After completing Phase 5, Tally v1.0 is feature-complete:

- **Reports**: Insurance summary, total value, items by location, lending, activity log, tag reports — all exportable as PDF or CSV
- **Sharing**: Time-limited share links with public read-only views, no auth required for viewers
- **Deployment**: PW app.yml manifest for Proxmox production, GitHub Actions CI/CD pipelines
- **Complete feature set across 5 phases:**
  - Phase 1: Foundation, auth, inventory CRUD, UI shell
  - Phase 2: Product catalog, barcode lookup, file uploads, camera scanner
  - Phase 3: Tags, QR labels, scan-scan-done, enhanced search
  - Phase 4: Lending, dates, accessories, audit trail, notifications, recycle bin
  - Phase 5: Reports, sharing, deployment

# Tally — Home Inventory Management System

## Design Specification

**Date:** 2026-03-23
**Status:** Approved
**App Name:** Tally
**Repository:** New (brand new project)

---

## 1. Overview

Tally is a collaborative home inventory management system that enables users to catalog, organize, locate, and track items across multiple physical locations. It features barcode scanning, image-based product lookup, QR-coded asset tags, hierarchical storage organization, and comprehensive reporting for insurance and value tracking.

### Key Goals

- Quickly catalog items via camera (barcode, OCR, image search)
- Organize items in a hierarchy: Property > Area > Container > Item (unlimited container nesting)
- Share locations with other users (owner / editor / viewer roles)
- Track item lifecycle (purchase, condition, lending, depreciation)
- Generate reports for insurance, value tracking, and lending
- Print scannable labels for bins, containers, and individual assets
- Scan-scan-done workflow: scan an item, scan a container, they're linked

---

## 2. System Architecture

### Tech Stack

| Layer | Technology |
|-------|------------|
| **Frontend** | React 18 + TypeScript, Radix UI + Tailwind CSS v4 (OKLCH), Vite |
| **Backend** | Express.js (EMP module pattern, dependency injection) |
| **Database** | MySQL 8.0 (single `TALLY` database) |
| **File Storage** | MinIO (S3-compatible) |
| **Auth** | Microsoft Entra ID (OIDC) |
| **Icons** | Lucide React |
| **Fonts** | Inter (UI), JetBrains Mono (IDs, counts, technical data) |
| **Charts** | Recharts |
| **Class Utils** | clsx + tailwind-merge + class-variance-authority |
| **Deployment** | Prevailing Winds (Docker Compose local, Proxmox production) |

### Architecture Tiers

**Client Tier** — React 18 + TypeScript + Radix UI + Tailwind CSS v4
- Mobile-first responsive design (375px reference, scales to tablet/desktop)
- Light mode + dark mode (system preference detection + manual toggle)
- Camera integration via browser MediaDevices API
- QR code generation and scanning
- Bulk scan mode with AR overlay annotations

**Server Tier** — Express.js (EMP Module Pattern)
- Dependency injection: `{ cache, db, logger, config }`
- API prefix conventions: `_x_` GET, `_y_` POST, `_u_` PUT, `_p_` PATCH, `_d_` DELETE
- Three-tier data pattern: StateStore > Repositories > Services
- Database fields UPPERCASE, API responses camelCase
- 8 modules: auth, inventory, products, files, labels, notifications, reports, sharing

**Data Tier** — MySQL 8.0 + MinIO
- Single `TALLY` database with closure table for container hierarchy
- Full-text indexes for search
- MinIO for file storage (photos, receipts, warranties, manuals)

**External Services**
- Open product databases (UPC Database, Open Food Facts) for barcode lookup
- Web scraping for retailer price/spec data (non-commercial, fallback)
- Reverse image search for items without barcodes

### Deployment

- **Local Development:** Docker Compose (MySQL, API, UI, MinIO, Vault)
- **Production:** Prevailing Winds orchestrator to Proxmox VMs (Client .10, Server .11, DB .12, MinIO .13)
- **No QA environment** — local dev + production only
- **App manifest:** `app.yml` registered with PW orchestrator

---

## 3. Data Model

### Core Hierarchy

#### properties
| Column | Type | Description |
|--------|------|-------------|
| ID | INT PK | Auto-increment |
| NAME | VARCHAR(255) | Property name |
| ADDRESS | TEXT | Physical address |
| DESCRIPTION | TEXT | Optional description |
| OWNER_ID | INT FK → users | Property creator |
| QR_CODE | VARCHAR(20) UNIQUE | Format: TLY-P-{HEX} |
| CREATED_AT | DATETIME | |
| UPDATED_AT | DATETIME | |
| DELETED_AT | DATETIME NULL | Soft delete (30-day recycle bin) |

#### areas
| Column | Type | Description |
|--------|------|-------------|
| ID | INT PK | |
| PROPERTY_ID | INT FK → properties | Parent property |
| NAME | VARCHAR(255) | Area name (Kitchen, Closet, etc.) |
| DESCRIPTION | TEXT | |
| QR_CODE | VARCHAR(20) UNIQUE | Format: TLY-A-{HEX} |
| CREATED_AT | DATETIME | |
| UPDATED_AT | DATETIME | |
| DELETED_AT | DATETIME NULL | Soft delete |

#### containers
| Column | Type | Description |
|--------|------|-------------|
| ID | INT PK | |
| AREA_ID | INT FK → areas | Parent area |
| PARENT_CONTAINER_ID | INT FK → containers NULL | Self-referencing for nesting |
| NAME | VARCHAR(255) | Container name |
| TYPE | VARCHAR(50) | tote, cabinet, shelf, drawer, box, bag, etc. |
| DESCRIPTION | TEXT | |
| QR_CODE | VARCHAR(20) UNIQUE | Format: TLY-C-{HEX} |
| CREATED_AT | DATETIME | |
| UPDATED_AT | DATETIME | |
| DELETED_AT | DATETIME NULL | Soft delete |

#### container_paths (closure table)
| Column | Type | Description |
|--------|------|-------------|
| ANCESTOR_ID | INT FK → containers | |
| DESCENDANT_ID | INT FK → containers | |
| DEPTH | INT | Distance between ancestor and descendant |

Enables efficient queries: "find all items in this container and everything nested inside it."

### Items & Product Catalog

#### items
| Column | Type | Description |
|--------|------|-------------|
| ID | INT PK | |
| CONTAINER_ID | INT FK → containers | Current location |
| PRODUCT_ID | INT FK → products NULL | Linked product data |
| NAME | VARCHAR(255) | Item name |
| DESCRIPTION | TEXT | |
| QUANTITY | INT DEFAULT 1 | |
| PURCHASE_PRICE | DECIMAL(10,2) NULL | USD |
| CURRENT_VALUE | DECIMAL(10,2) NULL | Calculated if depreciation enabled |
| DEPRECIATION_ENABLED | BOOLEAN DEFAULT FALSE | Opt-in per item |
| DEPRECIATION_RATE | DECIMAL(5,4) NULL | Override product default |
| CONDITION | ENUM('new','good','fair','poor') | Current condition |
| QR_CODE | VARCHAR(20) UNIQUE | Format: TLY-I-{HEX} (asset tag) |
| STATUS | ENUM('active','removed','lent') | |
| CREATED_AT | DATETIME | |
| UPDATED_AT | DATETIME | |
| DELETED_AT | DATETIME NULL | Soft delete |

FULLTEXT INDEX on NAME, DESCRIPTION.

#### products (shared catalog)
| Column | Type | Description |
|--------|------|-------------|
| ID | INT PK | |
| BARCODE | VARCHAR(50) UNIQUE | UPC/EAN/ISBN |
| NAME | VARCHAR(255) | |
| BRAND | VARCHAR(255) | |
| CATEGORY | VARCHAR(100) | |
| DESCRIPTION | TEXT | |
| SPECS | JSON | Product specifications |
| IMAGE_URL | TEXT | Product image |
| RETAIL_PRICE | DECIMAL(10,2) NULL | |
| RETAIL_LINKS | JSON | Array of {retailer, url, price} |
| DEPRECIATION_RATE | DECIMAL(5,4) NULL | Suggested annual rate by category |
| DATA_SOURCE | ENUM('upc_db','open_food_facts','scrape','manual') | |
| CREATED_AT | DATETIME | |
| UPDATED_AT | DATETIME | |

FULLTEXT INDEX on NAME, BRAND, DESCRIPTION.

Products are global — shared across all users and properties. Failed barcode lookups are still saved with user-entered data, building the catalog over time.

#### item_dates (flexible user-defined dates)
| Column | Type | Description |
|--------|------|-------------|
| ID | INT PK | |
| ITEM_ID | INT FK → items | |
| DATE_TYPE | VARCHAR(50) | User-defined: "purchased", "warranty_expires", "last_serviced", etc. |
| DATE_VALUE | DATE | |
| NOTES | TEXT NULL | |

#### item_accessories
| Column | Type | Description |
|--------|------|-------------|
| ID | INT PK | |
| ITEM_ID | INT FK → items | Parent item |
| ACCESSORY_ID | INT FK → items | The accessory (also a full item) |

### Condition History & Files

#### condition_snapshots
| Column | Type | Description |
|--------|------|-------------|
| ID | INT PK | |
| ITEM_ID | INT FK → items | |
| CONDITION | ENUM('new','good','fair','poor') | |
| PHOTO_KEY | VARCHAR(255) | S3 key in MinIO |
| NOTES | TEXT NULL | |
| RECORDED_BY | INT FK → users | |
| CREATED_AT | DATETIME | |

#### item_files
| Column | Type | Description |
|--------|------|-------------|
| ID | INT PK | |
| ITEM_ID | INT FK → items | |
| FILE_TYPE | ENUM('receipt','warranty','manual','photo','other') | |
| FILE_KEY | VARCHAR(255) | S3 key in MinIO |
| FILE_NAME | VARCHAR(255) | Original filename |
| MIME_TYPE | VARCHAR(100) | |
| FILE_SIZE | INT | Bytes |
| UPLOADED_BY | INT FK → users | |
| CREATED_AT | DATETIME | |

#### item_lending
| Column | Type | Description |
|--------|------|-------------|
| ID | INT PK | |
| ITEM_ID | INT FK → items | |
| LENT_TO | VARCHAR(255) | Name (not a user — you lend to neighbors, not app users) |
| LENT_AT | DATETIME | |
| DUE_AT | DATETIME NULL | |
| RETURNED_AT | DATETIME NULL | |
| NOTES | TEXT NULL | |
| CREATED_BY | INT FK → users | |

### Tags

#### tags
| Column | Type | Description |
|--------|------|-------------|
| ID | INT PK | |
| NAME | VARCHAR(50) | Unique per property |
| COLOR | VARCHAR(7) | Hex color |
| PROPERTY_ID | INT FK → properties | Scoped to property |

UNIQUE INDEX on (NAME, PROPERTY_ID).

#### entity_tags (polymorphic)
| Column | Type | Description |
|--------|------|-------------|
| TAG_ID | INT FK → tags | |
| ENTITY_TYPE | ENUM('item','container','area') | |
| ENTITY_ID | INT | |

UNIQUE INDEX on (TAG_ID, ENTITY_TYPE, ENTITY_ID).

### Auth & Permissions

#### users
| Column | Type | Description |
|--------|------|-------------|
| ID | INT PK | |
| ENTRA_ID | VARCHAR(255) UNIQUE | From Entra ID token |
| EMAIL | VARCHAR(255) | |
| DISPLAY_NAME | VARCHAR(255) | |
| AVATAR_URL | TEXT NULL | |
| CREATED_AT | DATETIME | |
| LAST_LOGIN_AT | DATETIME | |

#### property_members
| Column | Type | Description |
|--------|------|-------------|
| ID | INT PK | |
| PROPERTY_ID | INT FK → properties | |
| USER_ID | INT FK → users | |
| ROLE | ENUM('owner','editor','viewer') | |
| INVITED_BY | INT FK → users | |
| CREATED_AT | DATETIME | |

UNIQUE INDEX on (PROPERTY_ID, USER_ID).

#### share_links
| Column | Type | Description |
|--------|------|-------------|
| ID | INT PK | |
| TOKEN | VARCHAR(64) UNIQUE | URL-safe random token |
| ENTITY_TYPE | ENUM('property','area','container','item') | |
| ENTITY_ID | INT | |
| CREATED_BY | INT FK → users | |
| EXPIRES_AT | DATETIME | |
| CREATED_AT | DATETIME | |

### Audit & Notifications

#### change_log
| Column | Type | Description |
|--------|------|-------------|
| ID | INT PK | |
| USER_ID | INT FK → users | |
| ENTITY_TYPE | ENUM('property','area','container','item') | |
| ENTITY_ID | INT | |
| ACTION | ENUM('created','updated','moved','deleted','restored','lent','returned') | |
| CHANGES | JSON | {field: {old, new}} |
| PROPERTY_ID | INT FK → properties | For filtering by property |
| CREATED_AT | DATETIME | |

INDEX on (PROPERTY_ID, CREATED_AT).

#### notifications
| Column | Type | Description |
|--------|------|-------------|
| ID | INT PK | |
| USER_ID | INT FK → users | |
| TYPE | ENUM('warranty_expiry','lending_due','item_moved','item_removed','share_expiring','custom_date') | |
| TITLE | VARCHAR(255) | |
| MESSAGE | TEXT | |
| ENTITY_TYPE | ENUM('property','area','container','item') NULL | |
| ENTITY_ID | INT NULL | |
| READ_AT | DATETIME NULL | |
| CREATED_AT | DATETIME | |

#### notification_preferences
| Column | Type | Description |
|--------|------|-------------|
| USER_ID | INT FK → users | |
| NOTIFICATION_TYPE | ENUM('warranty_expiry','lending_due','item_moved','item_removed','share_expiring','custom_date') | |
| ENABLED | BOOLEAN DEFAULT FALSE | All off by default |

UNIQUE INDEX on (USER_ID, NOTIFICATION_TYPE).

---

## 4. Authentication & Permissions

### Authentication Flow

1. User opens Tally — redirected to Microsoft Entra ID login
2. Entra returns ID token with user identity (email, name, avatar)
3. Server validates token via OIDC, creates/updates `users` record
4. Session stored in httpOnly cookie (same pattern as EMP)
5. Refresh token in signed httpOnly cookie for session renewal

No Entra security groups needed — permissions are data-driven via `property_members`.

### Permission Model

| Role | Create/Edit Items | Move/Delete Items | Manage Members | Delete Property |
|------|:-:|:-:|:-:|:-:|
| **Owner** | Yes | Yes | Yes | Yes |
| **Editor** | Yes | Yes | No | No |
| **Viewer** | Read-only | No | No | No |

Permissions are set at the property level and cascade to everything inside (areas, containers, items). No per-area or per-container overrides.

### Share Links

- Generated by owners and editors
- Read-only, time-limited, no authentication required
- Encode entity type and ID — viewer sees the entity and its children
- Useful for insurance adjusters, movers, landlords

### API Authorization

Every API route checks:
1. Is the user authenticated? (auth middleware)
2. Does the request reference a property? Resolve role via `property_members`
3. Does the role permit this action? (permission matrix above)

---

## 5. Scanning & Label System

### QR Code Format

Every entity gets a unique QR code on creation encoding a URL:

```
https://tally.yourdomain.com/s/TLY-{TYPE}-{HEX}

Types:
  P = Property    TLY-P-A1B2
  A = Area        TLY-A-C3D4
  C = Container   TLY-C-E5F6
  I = Item        TLY-I-0A1B  (asset tag)
```

Scanning with any phone camera opens the entity in the app. Unauthenticated users see a login prompt (unless it's a share link).

### Scan-Scan-Done Workflow

Primary physical interaction pattern:
1. Open scanner (or scan with any phone camera — app opens in scan mode)
2. Scan an **item's asset tag** — item identified, held in buffer
3. Scan a **container's bin label** — item is moved into that container
4. Confirmation toast: "Drill Set > Blue Storage Tote"
5. Scanner stays active for the next item

Reverse also works: scan a container first, then scan items to add into it.

### Label Types

| Label | Contents | Use Case |
|-------|----------|----------|
| **Asset Tag** | QR code + item name + TLY ID | Stuck on the item itself |
| **Bin Label** | QR code + container name + location breadcrumb | Stuck on totes, boxes, shelves |
| **Location Label** | QR code + area name + property | Posted on a room/closet door |

### Printing Support

- **Sheet printers:** PDF generation for standard label sheets (Avery compatible)
- **Thermal/direct label printers:** Dymo, Brother, ZEBRA ZPL format
- User configures printer type in Settings
- Bulk printing: select multiple entities, pick template, print sheet

### Bulk Scan Mode

For initial inventory or reorganizing:
1. Select a target container (or scan its label)
2. Camera stays active continuously
3. AR overlay annotates scanned items in real-time (green highlight on items already captured)
4. Running count and item list in a slide-up panel at bottom
5. Product lookups happen in background as items are scanned
6. User reviews and confirms the batch

---

## 6. Item Intelligence & Camera System

### Unified Camera Flow

One camera entry point handling all scenarios:

1. Camera opens — continuously scans for barcodes + runs OCR for text
2. **Barcode found?** — Local `products` table first > Open Product DBs (UPC Database, Open Food Facts) > retailer scraping
3. **No barcode but OCR text found?** — Search product databases and retailers with extracted text
4. **Neither?** — User taps "Search by Image" > captures frame > reverse image search against retailers
5. **Still no match?** — Manual entry form. If a barcode was scanned, it is saved to the local product catalog with the user-entered data
6. **Duplicate check** at every match point: "You already have a Dyson V15 in Kitchen Cabinet — is this a second one or the same item?"

### Product Catalog

- First scan of a barcode creates a `products` record from external data
- All subsequent scans are instant local hits
- Failed lookups still persist the barcode with user-entered data — catalog grows over time
- Products are global across all users and properties

### Depreciation (Opt-In)

- Each product has a suggested `DEPRECIATION_RATE` (annual %, defaults by category)
- Items only calculate `CURRENT_VALUE` if user explicitly enables depreciation
- Formula: `PURCHASE_PRICE * (1 - DEPRECIATION_RATE) ^ years_since_purchase`
- Calculated on demand for reports, not stored/scheduled
- User can override rate per item

---

## 7. Search & Organization

### Full-Text Search

- MySQL FULLTEXT indexes on: items (NAME, DESCRIPTION), products (NAME, BRAND, DESCRIPTION), containers (NAME), areas (NAME)
- Dashboard search bar is the primary entry point
- Results grouped by type: Items > Containers > Areas
- Filters: by property, tag, condition, status (active/removed/lent)
- Also matches tag names and custom date labels

### Tags

- Scoped per property — each property has its own tag vocabulary
- Applied to items, containers, or areas (polymorphic via `entity_tags`)
- User-defined name + color
- Filterable and searchable

---

## 8. Reporting & Notifications

### Reports

| Report | Description | Export |
|--------|-------------|--------|
| Insurance Summary | All items with purchase price, current value (if depreciation enabled), condition, photos | PDF |
| Total Value | Aggregate value by property, area, or tag | PDF, CSV |
| Items by Location | Hierarchical view of all items per property/area/container | PDF, CSV |
| Lending Report | Currently lent items, who has them, due dates | PDF, CSV |
| Activity Log | Filterable audit trail — who did what, when | CSV |
| Tag Report | All items matching selected tags across properties | PDF, CSV |

### Notifications (In-App, Opt-In)

All notification types are off by default. Users enable per type in Settings.

| Trigger | Example |
|---------|---------|
| Lending overdue | "Drill lent to Dave is 3 days past due" |
| Warranty expiring | "Dyson V15 warranty expires in 30 days" |
| Item moved | "Sarah moved Blender from Kitchen to Storage Tote #3" |
| Item removed | "Luke marked Christmas Lights as removed" |
| Share link expiring | "Your share link for Luke's Apartment expires tomorrow" |
| Custom date approaching | Any user-defined date within a configurable reminder window |

Notification bell in header with unread count. Notifications list with mark-as-read and bulk dismiss.

---

## 9. Soft Deletes & Recycle Bin

All hierarchy entities (properties, areas, containers, items) use soft deletes via `DELETED_AT`. Deleted items move to a "Removed Items" view and are permanently purged after 30 days. Users can restore items within the 30-day window.

---

## 10. UI & Design

### Design System

- **Component library:** Radix UI primitives + custom Tailwind styling (not Shadcn)
- **Styling:** Tailwind CSS v4 with OKLCH color tokens
- **Theme:** Light mode + dark mode (system preference detection + manual toggle in Settings)
- **Icons:** Lucide React — no emojis anywhere
- **Typography:** Inter for UI, JetBrains Mono for TLY IDs, item counts, technical data
- **Color approach:** Flat — no gradients, no box shadows, no glows
- **Border radius:** 6-8px
- **Charts:** Recharts for reports and analytics

### Color Palette (Dark Mode)

| Token | Value | Usage |
|-------|-------|-------|
| bg | #1c1c1c | Page background |
| card | #262626 | Card/surface background |
| elevated | #303030 | Elevated surfaces |
| border | #3a3a3a | Borders |
| text | #fafafa | Primary text |
| text-secondary | #a3a3a3 | Secondary text |
| text-muted | #737373 | Muted/label text |
| primary | #6b8aff | Accent, actions, active states |
| green | #5ec793 | Success, add actions |
| amber | #e0a84a | Containers, warnings |
| red | #e06060 | Tags, destructive, alerts |
| purple | #a688e0 | Metadata, tags |

Light mode tokens to be derived as complementary values.

### Navigation (5 tabs, bottom bar)

| Tab | Icon | Purpose |
|-----|------|---------|
| Home | lucide: Home | Search bar + properties list + recent activity feed |
| Inventory | lucide: Layers | Full hierarchy browser (Property > Area > Container > Item) |
| Scan | lucide: ScanLine | Center prominent button. Camera with barcode/QR/OCR detection, bulk mode |
| Reports | lucide: BarChart2 | Insurance, value, lending, activity log, label printing |
| Settings | lucide: Settings | Profile, notification preferences, label printer config, properties, member management |

### Key UI Patterns

- **Search-first dashboard:** Search bar is the primary interaction on the home screen
- **Breadcrumb navigation:** Always shows hierarchy path (Property > Area > Container)
- **Scan always one tap away:** Prominent center tab in nav bar
- **Contextual FAB:** Floating action button adapts per context (add item in containers, add area in properties)
- **Action bar on detail views:** Scan Into, Print Label, Share
- **TLY hex IDs visible:** On every entity for quick reference and label matching
- **JetBrains Mono for technical data:** IDs, counts, dates use monospace font

---

## 11. Backend Modules

Following EMP's modular route architecture with dependency injection:

| Module | Responsibility |
|--------|---------------|
| **auth** | Entra ID OAuth, session management, RBAC middleware |
| **inventory** | Properties, areas, containers, items CRUD. Closure table management. Soft deletes. |
| **products** | Product catalog, barcode lookup (local > open DBs > scraping), OCR text search, image search, duplicate detection |
| **files** | File uploads to MinIO (receipts, warranties, manuals, condition photos), presigned URLs |
| **labels** | QR code generation, asset tag + bin label + location label templates, PDF + ZPL output |
| **notifications** | In-app notification creation, preference management, notification queries |
| **reports** | Insurance summary, value reports, lending report, activity log, tag report. PDF + CSV export. |
| **sharing** | Share link generation, validation, expiry. Public read-only views. |

---

## 12. Deployment Configuration

### Local Development (Docker Compose)

Services:
- `tally-db` — MySQL 8.0 with SSL
- `tally-server` — Express.js API
- `tally-client` — Nginx serving React build
- `tally-minio` — S3-compatible storage
- `tally-vault` — HashiCorp Vault (dev mode)

### Production (Prevailing Winds)

Registered via `app.yml` manifest:
- Client VM (.10) — Nginx reverse proxy
- Server VM (.11) — Node.js API
- Database VM (.12) — MySQL 8.0
- MinIO VM (.13) — S3 storage

Production VLAN only (no QA environment).

### CI/CD

- GitHub Actions for PR validation, build, deploy
- PW orchestrator handles deployment to Proxmox
- Same pipeline pattern as EMP

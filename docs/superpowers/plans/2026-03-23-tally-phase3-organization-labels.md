# Tally Phase 3: Organization & Labels — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add tags, QR code label generation/printing (PDF + ZPL), scan-scan-done workflow, QR deep-link resolution, and enhanced search with filtering to the Tally app.

**Architecture:** New `tags` and `labels` backend modules following EMP patterns. Tags are polymorphic (applied to items, containers, or areas) and scoped per property. Labels module generates QR codes via `qrcode` npm package, renders PDF labels via `pdfkit`, and outputs ZPL for thermal printers. The scan page gains a "move mode" for scan-scan-done (scan item → scan container → item moves). QR deep links (`/s/TLY-X-XXXX`) resolve to the correct entity detail page.

**Tech Stack:** qrcode (QR code generation), pdfkit (PDF label generation), ZPL string templates (thermal printers)

**Spec:** `docs/superpowers/specs/2026-03-23-tally-design.md` — Sections 5 (Scanning & Labels), 7 (Search & Organization)

**Depends on:** Phase 2 complete (`/Users/luke/dev/tally/`)

---

## File Structure

### New Server Files

```
server/src/modules/
├── tags/
│   ├── tags.routes.js          # Tag CRUD + entity tagging/untagging
│   ├── tags.service.js         # Tag management, polymorphic entity_tags
│   └── tags.schema.js          # Joi validation
└── labels/
    ├── labels.routes.js        # Generate labels (single + bulk), resolve QR codes
    ├── labels.service.js       # QR generation, PDF rendering, ZPL output
    └── labels.schema.js        # Joi validation
```

### New Client Files

```
client/src/
├── components/
│   ├── tags/
│   │   ├── tag-badge.tsx       # Colored tag pill
│   │   ├── tag-picker.tsx      # Add/remove tags on an entity
│   │   └── tag-manager.tsx     # Create/edit/delete tags (settings-level)
│   └── labels/
│       ├── label-preview.tsx   # Preview label before printing
│       └── label-print-dialog.tsx  # Select entities + template + printer type
├── hooks/
│   ├── use-tags.ts             # React Query hooks for tags
│   └── use-labels.ts           # Hooks for label generation
└── pages/
    └── qr-redirect.tsx         # /s/:code deep-link resolver
```

### Modified Files

```
server/index.js                     # Register tags + labels routes
server/package.json                 # Add qrcode, pdfkit
client/src/App.tsx                  # Replace Navigate on /s/:code with QrRedirect
client/src/pages/scan.tsx           # Add scan-scan-done move mode
client/src/pages/item-detail.tsx    # Add tags section
client/src/pages/container-detail.tsx # Add tags section
client/src/pages/area-detail.tsx    # Add tags section
client/src/pages/home.tsx           # Enhanced search with tag/filter chips
client/src/pages/settings.tsx       # Add tag management section
client/src/lib/query-client.ts      # Add tags + labels query keys
```

---

## Task Breakdown

### Task 1: Tags Module — Backend

**Files:**
- Create: `server/src/modules/tags/tags.routes.js`
- Create: `server/src/modules/tags/tags.service.js`
- Create: `server/src/modules/tags/tags.schema.js`
- Modify: `server/index.js` — register tags routes

- [ ] **Step 1: Write tags.service.js**

TagsService:
- `init({ db, logger })` — stores refs
- `getByProperty(propertyId)` — SELECT from tags WHERE PROPERTY_ID = ? ORDER BY NAME. Return camelCase.
- `create(data)` — INSERT into tags (NAME, COLOR, PROPERTY_ID). Return camelCase.
- `update(id, data)` — UPDATE tags SET NAME/COLOR. Return camelCase.
- `delete(id)` — DELETE from entity_tags WHERE TAG_ID = ?, then DELETE from tags WHERE ID = ?
- `addToEntity(tagId, entityType, entityId)` — INSERT INTO entity_tags (TAG_ID, ENTITY_TYPE, ENTITY_ID). Handle ER_DUP_ENTRY gracefully (already tagged).
- `removeFromEntity(tagId, entityType, entityId)` — DELETE FROM entity_tags WHERE TAG_ID = ? AND ENTITY_TYPE = ? AND ENTITY_ID = ?
- `getForEntity(entityType, entityId)` — SELECT t.* FROM tags t JOIN entity_tags et ON t.ID = et.TAG_ID WHERE et.ENTITY_TYPE = ? AND et.ENTITY_ID = ? ORDER BY t.NAME. Return camelCase.
- `getPropertyIdForTag(tagId)` — SELECT PROPERTY_ID FROM tags WHERE ID = ?

- [ ] **Step 2: Write tags.schema.js**

```javascript
const Joi = require('joi');

const createTag = Joi.object({
  name: Joi.string().max(50).required(),
  color: Joi.string().pattern(/^#[0-9A-Fa-f]{6}$/).required(),
  propertyId: Joi.number().integer().required(),
});

const updateTag = Joi.object({
  name: Joi.string().max(50),
  color: Joi.string().pattern(/^#[0-9A-Fa-f]{6}$/),
}).min(1);

const tagEntity = Joi.object({
  tagId: Joi.number().integer().required(),
  entityType: Joi.string().valid('item', 'container', 'area').required(),
  entityId: Joi.number().integer().required(),
});

module.exports = { createTag, updateTag, tagEntity };
```

- [ ] **Step 3: Write tags.routes.js**

Routes (all require auth):
- `GET /api/tags/_x_/property/:propertyId` — list tags for property. resolvePropertyRole, check membership.
- `POST /api/tags/_y_/create` — create tag. Resolve property from body.propertyId, requireRole('owner', 'editor').
- `PUT /api/tags/_u_/:tagId` — update tag. Resolve property from tag, requireRole('owner', 'editor').
- `DELETE /api/tags/_d_/:tagId` — delete tag. Resolve property from tag, requireRole('owner').
- `GET /api/tags/_x_/entity/:entityType/:entityId` — get tags for an entity. Auth only.
- `POST /api/tags/_y_/entity` — add tag to entity. Body: `{ tagId, entityType, entityId }`. requireRole('owner', 'editor').
- `DELETE /api/tags/_d_/entity/:tagId/:entityType/:entityId` — remove tag from entity. requireRole('owner', 'editor').

Property resolution: For tag routes, resolve from the tag's PROPERTY_ID. For entity tag routes, resolve from the entity (use existing service methods: PropertiesService doesn't need resolution, AreasService.getPropertyIdForArea, ContainersService.getPropertyIdForContainer, ItemsService.getPropertyIdForItem).

- [ ] **Step 4: Register in index.js**

```javascript
require('./src/modules/tags/tags.routes')({ app, db, logger, config });
```

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/tags/ server/index.js
git commit -m "feat: tags module — CRUD, polymorphic entity tagging"
```

---

### Task 2: Labels Module — Backend (QR + PDF + ZPL)

**Files:**
- Create: `server/src/modules/labels/labels.routes.js`
- Create: `server/src/modules/labels/labels.service.js`
- Create: `server/src/modules/labels/labels.schema.js`
- Modify: `server/package.json` — add qrcode, pdfkit
- Modify: `server/index.js` — register labels routes

- [ ] **Step 1: Install dependencies**

```bash
cd server && npm install qrcode pdfkit
```

- [ ] **Step 2: Write labels.service.js**

LabelsService:
- `init({ db, logger, config })` — stores refs. `baseUrl` = config.clientUrl (for QR code URLs).
- `generateQrDataUrl(code)` — uses `qrcode.toDataURL()` to create a QR code image as data URL. The QR encodes `${baseUrl}/s/${code}`.
- `generateQrBuffer(code, size)` — uses `qrcode.toBuffer()` for embedding in PDFs. Returns PNG buffer.
- `resolveCode(code)` — parses TLY code via `qr.parseCode()`, queries the DB to find the entity, returns `{ type, id, name, exists }`.
- `generateAssetTagPdf(items)` — generates PDF with asset tags for an array of items. Each tag: QR code + item name + TLY ID. Use pdfkit to render. Layout: grid of labels sized for standard Avery sheets (e.g., 2"x1" labels, 30 per page). Return PDF buffer.
- `generateBinLabelPdf(containers)` — generates PDF with bin labels. Each label: QR code + container name + location breadcrumb (Property > Area). Return PDF buffer.
- `generateLocationLabelPdf(areas)` — generates PDF with location labels. Each label: QR code + area name + property name. Return PDF buffer.
- `generateZpl(entity)` — generates ZPL string for a single label. The ZPL includes: ^XA (start), ^FO (field origin), ^BQ (QR barcode), ^FD (field data with TLY code URL), ^FS (separator), ^CF (font), ^FO ^FD (text: entity name), ^FO ^FD (text: TLY ID), ^XZ (end). Return ZPL string.
- `getEntityData(type, id)` — fetches entity from DB with breadcrumb info for label rendering.

- [ ] **Step 3: Write labels.schema.js**

```javascript
const Joi = require('joi');

const generateLabels = Joi.object({
  entityType: Joi.string().valid('item', 'container', 'area').required(),
  entityIds: Joi.array().items(Joi.number().integer()).min(1).max(100).required(),
  format: Joi.string().valid('pdf', 'zpl').default('pdf'),
});

const resolveCode = Joi.object({
  code: Joi.string().pattern(/^TLY-[PACI]-[0-9A-Fa-f]{4}$/).required(),
});

module.exports = { generateLabels, resolveCode };
```

- [ ] **Step 4: Write labels.routes.js**

Routes:
- `POST /api/labels/_y_/generate` — generate labels. Body: `{ entityType, entityIds, format }`. If format is 'pdf', set Content-Type to application/pdf and pipe the PDF buffer. If 'zpl', return JSON with ZPL strings.
- `GET /api/labels/_x_/resolve/:code` — resolve a TLY code. Returns `{ type, id, name, exists }`. Used by the QR deep-link page to know where to redirect. Auth required.
- `GET /api/labels/_x_/qr/:code` — generate QR code image for a single entity. Returns PNG image (Content-Type: image/png). Used for displaying QR in UI.

All routes require auth.

- [ ] **Step 5: Register in index.js**

```javascript
require('./src/modules/labels/labels.routes')({ app, db, logger, config });
```

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/labels/ server/index.js server/package.json server/package-lock.json
git commit -m "feat: labels module — QR generation, PDF labels, ZPL thermal printer output"
```

---

### Task 3: QR Deep-Link Resolution — Frontend

**Files:**
- Create: `client/src/pages/qr-redirect.tsx`
- Modify: `client/src/App.tsx` — replace Navigate with QrRedirect component

- [ ] **Step 1: Create qr-redirect.tsx**

Page component for `/s/:code` route:
- Extracts `:code` from URL params
- Calls `GET /api/labels/_x_/resolve/:code` via api.get
- If entity exists: redirect to the correct detail page (`/property/:id`, `/area/:id`, `/container/:id`, `/item/:id`)
- If not found: show "Entity not found" with link to home
- Loading state while resolving
- Handle unauthenticated users: if 401, redirect to `/login?redirect=/s/${code}` so they come back after auth

- [ ] **Step 2: Update App.tsx routing**

Replace `<Route path="/s/:code" element={<Navigate to="/" />} />` with:
```tsx
<Route path="/s/:code" element={<QrRedirect />} />
```

Import QrRedirect. This route should be OUTSIDE the RootLayout (no bottom nav needed — it's a redirect page).

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/qr-redirect.tsx client/src/App.tsx
git commit -m "feat: QR deep-link resolution — scan any TLY code to navigate to entity"
```

---

### Task 4: Tags UI — Frontend

**Files:**
- Create: `client/src/hooks/use-tags.ts`
- Create: `client/src/components/tags/tag-badge.tsx`
- Create: `client/src/components/tags/tag-picker.tsx`
- Create: `client/src/components/tags/tag-manager.tsx`
- Modify: `client/src/lib/query-client.ts` — add tags query keys
- Modify: `client/src/pages/item-detail.tsx` — add tags section
- Modify: `client/src/pages/container-detail.tsx` — add tags display + picker
- Modify: `client/src/pages/area-detail.tsx` — add tags display + picker
- Modify: `client/src/pages/settings.tsx` — add tag management section

- [ ] **Step 1: Add query keys**

Add to `queryKeys` in `query-client.ts`:
```typescript
tags: {
  all: ['tags'] as const,
  byProperty: (propertyId: number) => [...queryKeys.tags.all, 'byProperty', propertyId] as const,
  forEntity: (entityType: string, entityId: number) => [...queryKeys.tags.all, 'entity', entityType, entityId] as const,
},
labels: {
  all: ['labels'] as const,
},
```

- [ ] **Step 2: Create use-tags.ts**

Hooks:
- `usePropertyTags(propertyId)` — GET /api/tags/_x_/property/:propertyId
- `useEntityTags(entityType, entityId)` — GET /api/tags/_x_/entity/:entityType/:entityId
- `useCreateTag()` — POST mutation
- `useUpdateTag()` — PUT mutation
- `useDeleteTag()` — DELETE mutation
- `useAddTag()` — POST /api/tags/_y_/entity mutation. Invalidates entity tags.
- `useRemoveTag()` — DELETE /api/tags/_d_/entity/:tagId/:entityType/:entityId mutation.

- [ ] **Step 3: Create tag-badge.tsx**

Small colored pill component:
- Props: `tag: { id: number; name: string; color: string }`, `onRemove?: () => void`
- Renders name with background color (use the tag's hex color with 20% opacity for bg, full color for text)
- Optional X button for removal
- Uses Lucide Tag icon prefix

- [ ] **Step 4: Create tag-picker.tsx**

Component to add/remove tags on an entity:
- Props: `entityType: 'item' | 'container' | 'area'`, `entityId: number`, `propertyId: number`
- Shows current tags as TagBadge components (with remove buttons)
- "Add tag" button opens a dropdown of available property tags (filtered to exclude already-applied)
- Quick-create: if desired tag doesn't exist, "Create [typed text]" option at bottom of dropdown

- [ ] **Step 5: Create tag-manager.tsx**

Property-level tag management (for Settings page):
- Props: `propertyId: number`
- Lists all tags for the property with color swatches
- Edit tag name/color inline
- Delete tag (with confirmation — warns it will be removed from all entities)
- Create new tag form (name + color picker using 8 preset colors)

- [ ] **Step 6: Add tags to item-detail, container-detail, area-detail pages**

For each page, add a tags section:
- Show existing tags as `TagBadge` components
- "Manage Tags" button opens `TagPicker`
- Need the `propertyId` — for items, get it from the item's breadcrumb or resolve; for containers from container data; for areas from area data

- [ ] **Step 7: Add tag management to settings page**

Add a "Tags" section in settings that:
- Lists user's properties
- For each property, shows `TagManager` component
- Or: select a property first, then manage its tags

- [ ] **Step 8: Commit**

```bash
git add client/src/hooks/use-tags.ts client/src/components/tags/ client/src/lib/query-client.ts client/src/pages/item-detail.tsx client/src/pages/container-detail.tsx client/src/pages/area-detail.tsx client/src/pages/settings.tsx
git commit -m "feat: tags UI — create, manage, apply tags to items/containers/areas"
```

---

### Task 5: Scan-Scan-Done Workflow

**Files:**
- Modify: `client/src/pages/scan.tsx` — add move mode

- [ ] **Step 1: Add move mode to scan.tsx**

Extend the scanner page with a "Move Mode" toggle/tab. When move mode is active:

**State machine for move mode:**
1. `move_idle` — camera active, "Scan an item or container to start"
2. `move_first_scan` — first entity scanned. If it's an item (TLY-I-*), prompt "Now scan the destination container". If it's a container (TLY-C-*), prompt "Now scan items to add into [container name]".
3. `move_completing` — second scan detected. Call API to move item to container.
4. `move_done` — toast confirmation "Item → Container", return to `move_idle`

**Implementation details:**
- Parse scanned codes with `qr.parseCode()` logic (client-side regex match)
- On first scan: call `GET /api/labels/_x_/resolve/:code` to get entity details
- On second scan: resolve entity, then call `PATCH /api/items/_p_/:itemId/move` with `{ containerId }`
- If item→container: move the item
- If container→item(s): batch mode — keep scanning items, each moves into the container, camera stays active
- Show a running list of moves in a bottom slide-up panel
- Toast for each successful move

**UI:**
- Toggle at top: "Add Item" mode vs "Move" mode (two tabs/buttons)
- Move mode has a distinct visual treatment (different accent color or border)
- Bottom panel shows: current context (what was scanned first) + list of completed moves

- [ ] **Step 2: Commit**

```bash
git add client/src/pages/scan.tsx
git commit -m "feat: scan-scan-done — move items between containers by scanning QR codes"
```

---

### Task 6: Label Printing UI

**Files:**
- Create: `client/src/hooks/use-labels.ts`
- Create: `client/src/components/labels/label-preview.tsx`
- Create: `client/src/components/labels/label-print-dialog.tsx`
- Modify: `client/src/pages/container-detail.tsx` — wire up "Print Label" button
- Modify: `client/src/pages/item-detail.tsx` — add "Print Asset Tag" button
- Modify: `client/src/pages/area-detail.tsx` — add "Print Label" button

- [ ] **Step 1: Create use-labels.ts**

Hooks:
- `useGenerateLabels()` — POST mutation to /api/labels/_y_/generate. For PDF format, returns blob and triggers download. For ZPL, returns text.
- `useQrImage(code)` — GET /api/labels/_x_/qr/:code, returns image URL (used for preview)

- [ ] **Step 2: Create label-preview.tsx**

Preview a single label before printing:
- Props: `entity: { type, name, qrCode, breadcrumb? }`, `qrImageUrl: string`
- Shows a card mockup of what the printed label will look like
- QR code image + entity name + TLY ID + breadcrumb (for containers/areas)

- [ ] **Step 3: Create label-print-dialog.tsx**

Dialog for printing labels:
- Props: `entities: Array<{type, id, name, qrCode}>`, `isOpen`, `onOpenChange`
- Shows list of entities that will be printed
- Format selector: PDF (sheet printer) or ZPL (thermal printer)
- "Print" button:
  - PDF: calls generate API, receives blob, creates download link, clicks it
  - ZPL: calls generate API, receives ZPL text, copies to clipboard or triggers print dialog
- Loading state during generation

- [ ] **Step 4: Wire up Print buttons**

**container-detail.tsx:** The "Print Label" action bar button opens `LabelPrintDialog` with the current container.

**item-detail.tsx:** Add "Print Asset Tag" button that opens `LabelPrintDialog` with the current item.

**area-detail.tsx:** Add "Print Label" button that opens `LabelPrintDialog` with the current area.

Also add bulk printing: on container-detail, add a "Print All Labels" option that includes the container + all items inside it.

- [ ] **Step 5: Commit**

```bash
git add client/src/hooks/use-labels.ts client/src/components/labels/ client/src/pages/container-detail.tsx client/src/pages/item-detail.tsx client/src/pages/area-detail.tsx
git commit -m "feat: label printing — PDF sheets, ZPL thermal, preview, bulk print"
```

---

### Task 7: Enhanced Search with Tag Filtering

**Files:**
- Modify: `client/src/pages/home.tsx` — add tag filter chips and search result grouping

- [ ] **Step 1: Enhance home page search**

Improve the dashboard search:
- Below the search input, show filter chips:
  - Tag filter: dropdown to select tags (from user's properties)
  - Condition filter: chips for new/good/fair/poor
  - Status filter: active/removed/lent
- When filters are applied, add query params to the search API call
- Search results grouped by type: Items first, then Containers, then Areas
- Each result group has a header ("Items (12)", "Containers (3)", "Areas (1)")
- Tag badges shown on each result card

Note: The backend search already supports basic FULLTEXT. For tag-based filtering, extend the search to:
- If tag filter is selected, add JOIN to entity_tags and filter by TAG_ID
- This may require a backend change — add an optional `tagIds` query param to the items search endpoint

- [ ] **Step 2: Add tag filter support to items search API**

Modify `server/src/modules/inventory/items.service.js` `search()` method:
- Accept optional `tagIds` array parameter
- If provided, add `JOIN TALLY.entity_tags et ON et.ENTITY_ID = i.ID AND et.ENTITY_TYPE = 'item' WHERE et.TAG_ID IN (?)` to the search query

Modify `server/src/modules/inventory/items.schema.js` `searchItems` schema:
- Add `tagIds: Joi.array().items(Joi.number().integer()).allow(null)`

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/home.tsx server/src/modules/inventory/items.service.js server/src/modules/inventory/items.schema.js
git commit -m "feat: enhanced search — tag filtering, condition/status filters, grouped results"
```

---

### Task 8: Final Integration & Build Verification

**Files:**
- Modify: `CLAUDE.md` — update with Phase 3 modules
- Verify TypeScript compiles and builds

- [ ] **Step 1: Verify TypeScript**

```bash
cd client && npx tsc --noEmit
```

- [ ] **Step 2: Verify build**

```bash
cd client && npm run build
```

- [ ] **Step 3: Update CLAUDE.md**

Add to registered routes table:
- tags module
- labels module

Add notes about:
- QR deep-link resolution (`/s/TLY-X-XXXX`)
- Scan-scan-done workflow
- Label printing (PDF + ZPL)
- Tag system (polymorphic, property-scoped)

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: phase 3 complete — tags, QR labels, scan-scan-done, enhanced search"
```

---

## Phase Summary

After completing Phase 3, you will have:

- **Tags module**: Property-scoped tags with colors, polymorphic application to items/containers/areas, tag management UI
- **Labels module**: QR code generation, PDF label sheets (Avery compatible), ZPL thermal printer output, bulk printing
- **QR deep-links**: `/s/TLY-X-XXXX` routes resolve to correct entity pages
- **Scan-scan-done**: Move mode — scan item then container (or vice versa) to relocate items
- **Enhanced search**: Tag-based filtering, condition/status filters, grouped search results
- **Print integration**: Print buttons on item/container/area detail pages

**Next: Phase 4 — Lifecycle & Notifications** (lending, flexible dates, depreciation, audit trail, notifications, soft delete purge)

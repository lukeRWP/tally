# Tally Phase 2: Item Intelligence & Files — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add product catalog with barcode lookup, file uploads to MinIO, condition tracking, and a camera-based scanner page to the Tally app.

**Architecture:** New `products` and `files` backend modules following the existing EMP pattern (routes/service/schema with dependency injection). Camera page uses the browser MediaDevices API with `html5-qrcode` for barcode detection. File uploads go through multer → S3 SDK → MinIO. Condition snapshots store photos in MinIO with metadata in MySQL. External product lookups hit Open Food Facts and UPC Database APIs, with results cached in the local `products` table.

**Tech Stack:** html5-qrcode (barcode scanning), @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner (MinIO), multer (file uploads), sharp (image processing/thumbnails), axios (external API calls)

**Spec:** `docs/superpowers/specs/2026-03-23-tally-design.md` — Sections 6 (Item Intelligence), 3 (Data Model: products, item_files, condition_snapshots), 11 (Backend Modules: products, files)

**Depends on:** Phase 1 complete (`/Users/luke/dev/tally/`)

---

## File Structure

### New Server Files

```
server/src/
├── modules/
│   ├── products/
│   │   ├── products.routes.js      # Product CRUD + barcode lookup + duplicate check
│   │   ├── products.service.js     # Local catalog + external lookup orchestration
│   │   ├── products.schema.js      # Joi validation
│   │   └── lookup/
│   │       ├── lookup-orchestrator.js  # Chains: local → UPC DB → Open Food Facts → manual
│   │       ├── upc-database.js         # UPC Database API adapter
│   │       └── open-food-facts.js      # Open Food Facts API adapter
│   └── files/
│       ├── files.routes.js         # Upload, download, list, delete files
│       ├── files.service.js        # MinIO operations + DB metadata
│       ├── files.schema.js         # Joi validation
│       ├── condition.routes.js     # Condition snapshot CRUD
│       ├── condition.service.js    # Snapshot creation with photo upload
│       └── condition.schema.js     # Joi validation
├── infrastructure/
│   └── storage.js                  # S3/MinIO client wrapper (bucket ops, presigned URLs)
```

### New Client Files

```
client/src/
├── components/
│   ├── scanner/
│   │   ├── camera-scanner.tsx      # Camera access + html5-qrcode barcode detection
│   │   ├── scan-result.tsx         # Product match display + actions
│   │   ├── product-search.tsx      # Manual search / OCR text search results
│   │   └── duplicate-check.tsx     # "You already have this" dialog
│   ├── files/
│   │   ├── file-upload.tsx         # Drag-and-drop / tap-to-upload component
│   │   └── file-list.tsx           # List of attached files with type icons (click opens presigned URL)
│   └── condition/
│       ├── condition-form.tsx      # New condition snapshot (photo + rating + notes)
│       └── condition-timeline.tsx  # Timeline of condition snapshots
├── hooks/
│   └── use-products.ts             # React Query hooks for products + file operations
├── types/
│   └── files.ts                    # File, ConditionSnapshot types
```

### Modified Files

```
server/index.js                     # Register products + files routes
server/package.json                 # Add axios dependency
client/package.json                 # Add html5-qrcode dependency
client/src/pages/scan.tsx           # Replace placeholder with camera scanner
client/src/pages/item-detail.tsx    # Wire up files + condition sections
client/src/lib/query-client.ts      # Add products + files query keys
client/src/types/inventory.ts       # Extend with file/condition types
```

---

## Task Breakdown

### Task 1: MinIO Storage Infrastructure

**Files:**
- Create: `server/src/infrastructure/storage.js`

- [ ] **Step 1: Create storage.js — S3/MinIO client wrapper**

```javascript
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand, CreateBucketCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const config = require('../config');
const logger = require('../utils/logger');

let s3Client = null;

function init() {
  s3Client = new S3Client({
    endpoint: config.storage.endpoint,
    region: config.storage.region,
    credentials: {
      accessKeyId: config.storage.accessKeyId,
      secretAccessKey: config.storage.secretAccessKey,
    },
    forcePathStyle: true, // Required for MinIO
  });
}

async function ensureBucket() {
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: config.storage.bucket }));
  } catch {
    await s3Client.send(new CreateBucketCommand({ Bucket: config.storage.bucket }));
    logger.info(`Created bucket: ${config.storage.bucket}`);
  }
}

async function upload(key, body, contentType) {
  await s3Client.send(new PutObjectCommand({
    Bucket: config.storage.bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
  return key;
}

async function getPresignedUrl(key, expiresIn = 3600) {
  return getSignedUrl(s3Client, new GetObjectCommand({
    Bucket: config.storage.bucket,
    Key: key,
  }), { expiresIn });
}

async function remove(key) {
  await s3Client.send(new DeleteObjectCommand({
    Bucket: config.storage.bucket,
    Key: key,
  }));
}

module.exports = { init, ensureBucket, upload, getPresignedUrl, remove };
```

- [ ] **Step 2: Initialize storage in server/index.js**

Add after DB init, before route registration:
```javascript
const storage = require('./src/infrastructure/storage');
storage.init();
// ensureBucket on startup (non-blocking)
storage.ensureBucket().catch(err => logger.warn('MinIO bucket check failed', { error: err.message }));
```

- [ ] **Step 3: Commit**

```bash
git add server/src/infrastructure/storage.js server/index.js
git commit -m "feat: MinIO storage infrastructure — S3 client, bucket management, presigned URLs"
```

---

### Task 2: Files Module — Backend

**Files:**
- Create: `server/src/modules/files/files.routes.js`
- Create: `server/src/modules/files/files.service.js`
- Create: `server/src/modules/files/files.schema.js`
- Modify: `server/index.js` — register files routes

- [ ] **Step 1: Write files.service.js**

FilesService:
- `init({ db, logger })` — stores refs
- `getByItem(itemId)` — SELECT from item_files WHERE ITEM_ID = ? ORDER BY CREATED_AT DESC. For each file, generate a presigned URL. Return camelCase.
- `upload(itemId, file, fileType, userId)` — Process upload:
  1. Generate S3 key: `items/${itemId}/${fileType}/${uuid}-${file.originalname}`
  2. If file is an image, use sharp to create a thumbnail (200px wide) and upload both
  3. Upload original to MinIO via storage.upload()
  4. INSERT into item_files (ITEM_ID, FILE_TYPE, FILE_KEY, FILE_NAME, MIME_TYPE, FILE_SIZE, UPLOADED_BY)
  5. Return file record with presigned URL
- `delete(fileId, userId)` — Get file record, verify ownership/permissions, delete from MinIO, DELETE from item_files
- `getPresignedUrl(fileId)` — Get file record, return presigned URL

Use multer for multipart handling. Configure in routes: `multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } })` (100MB limit).

- [ ] **Step 2: Write files.schema.js**

```javascript
const Joi = require('joi');

const uploadFile = Joi.object({
  fileType: Joi.string().valid('receipt', 'warranty', 'manual', 'photo', 'other').required(),
});

module.exports = { uploadFile };
```

- [ ] **Step 3: Write files.routes.js**

```javascript
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

module.exports = function filesRoutes({ app, db, logger, config }) {
  const FilesService = require('./files.service');
  FilesService.init({ db, logger });

  const validate = require('../../middleware/validate');
  const schemas = require('./files.schema');
  const { success, error } = require('../../utils/response');
  const { requireAuth, resolvePropertyRole, requireRole } = app.locals;
  const ItemsService = require('../inventory/items.service');

  // Resolve property from itemId for authorization
  async function resolvePropertyFromItem(req, res, next) {
    const itemId = req.params.itemId;
    const propertyId = await ItemsService.getPropertyIdForItem(itemId);
    if (!propertyId) return error(res, 'Item not found', 404);
    req.params.propertyId = propertyId;
    next();
  }

  // GET /api/files/_x_/item/:itemId — list files for item
  app.get('/api/files/_x_/item/:itemId', requireAuth, resolvePropertyFromItem, resolvePropertyRole, async (req, res) => {
    if (!req.propertyRole) return error(res, 'Access denied', 403);
    const files = await FilesService.getByItem(req.params.itemId);
    success(res, files);
  });

  // POST /api/files/_y_/item/:itemId/upload — upload file
  app.post('/api/files/_y_/item/:itemId/upload', requireAuth, resolvePropertyFromItem, resolvePropertyRole, requireRole('owner', 'editor'), upload.single('file'), async (req, res) => {
    if (!req.file) return error(res, 'No file provided', 400);
    const fileType = req.body.fileType || 'other';
    const result = await FilesService.upload(req.params.itemId, req.file, fileType, req.user.id);
    success(res, result, 'File uploaded', 201);
  });

  // GET /api/files/_x_/:fileId/url — get presigned download URL
  app.get('/api/files/_x_/:fileId/url', requireAuth, async (req, res) => {
    const url = await FilesService.getPresignedUrl(req.params.fileId);
    success(res, { url });
  });

  // DELETE /api/files/_d_/:fileId — delete file (owner/editor only)
  app.delete('/api/files/_d_/:fileId', requireAuth, async (req, res) => {
    await FilesService.delete(req.params.fileId, req.user.id);
    success(res, null, 'File deleted');
  });
};
```

- [ ] **Step 4: Register files routes in index.js**

```javascript
require('./src/modules/files/files.routes')({ app, db, logger, config });
```

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/files/ server/index.js
git commit -m "feat: files module — upload, download, list, delete with MinIO storage"
```

---

### Task 3: Condition Snapshots — Backend

**Files:**
- Create: `server/src/modules/files/condition.routes.js`
- Create: `server/src/modules/files/condition.service.js`
- Create: `server/src/modules/files/condition.schema.js`
- Modify: `server/index.js` — register condition routes

- [ ] **Step 1: Write condition.service.js**

ConditionService:
- `init({ db, logger })` — stores refs
- `getByItem(itemId)` — SELECT from condition_snapshots WHERE ITEM_ID = ? ORDER BY CREATED_AT DESC. Generate presigned URL for each PHOTO_KEY. Return camelCase.
- `create(itemId, data, photoFile, userId)` — Process:
  1. Upload photo to MinIO: `items/${itemId}/conditions/${uuid}-${photoFile.originalname}`
  2. Create thumbnail via sharp
  3. INSERT into condition_snapshots (ITEM_ID, CONDITION, PHOTO_KEY, NOTES, RECORDED_BY)
  4. UPDATE items SET CONDITION = data.condition WHERE ID = itemId (update current condition)
  5. Return snapshot with presigned URL
- `delete(snapshotId)` — Get record, delete photo from MinIO, DELETE from condition_snapshots

- [ ] **Step 2: Write condition.schema.js**

```javascript
const Joi = require('joi');

const createSnapshot = Joi.object({
  condition: Joi.string().valid('new', 'good', 'fair', 'poor').required(),
  notes: Joi.string().allow('', null),
});

module.exports = { createSnapshot };
```

- [ ] **Step 3: Write condition.routes.js**

```javascript
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

module.exports = function conditionRoutes({ app, db, logger }) {
  const ConditionService = require('./condition.service');
  ConditionService.init({ db, logger });

  const { success, error } = require('../../utils/response');
  const { requireAuth, resolvePropertyRole, requireRole } = app.locals;
  const ItemsService = require('../inventory/items.service');

  // Resolve property from itemId for authorization
  async function resolvePropertyFromItem(req, res, next) {
    const itemId = req.params.itemId;
    const propertyId = await ItemsService.getPropertyIdForItem(itemId);
    if (!propertyId) return error(res, 'Item not found', 404);
    req.params.propertyId = propertyId;
    next();
  }

  // GET /api/conditions/_x_/item/:itemId — condition history for item
  app.get('/api/conditions/_x_/item/:itemId', requireAuth, resolvePropertyFromItem, resolvePropertyRole, async (req, res) => {
    if (!req.propertyRole) return error(res, 'Access denied', 403);
    const snapshots = await ConditionService.getByItem(req.params.itemId);
    success(res, snapshots);
  });

  // POST /api/conditions/_y_/item/:itemId — create condition snapshot
  app.post('/api/conditions/_y_/item/:itemId', requireAuth, resolvePropertyFromItem, resolvePropertyRole, requireRole('owner', 'editor'), upload.single('photo'), async (req, res) => {
    if (!req.file) return error(res, 'Photo is required', 400);
    const data = { condition: req.body.condition, notes: req.body.notes };
    const snapshot = await ConditionService.create(req.params.itemId, data, req.file, req.user.id);
    success(res, snapshot, 'Condition recorded', 201);
  });

  // DELETE /api/conditions/_d_/:snapshotId — delete snapshot (owner only)
  app.delete('/api/conditions/_d_/:snapshotId', requireAuth, async (req, res) => {
    await ConditionService.delete(req.params.snapshotId);
    success(res, null, 'Snapshot deleted');
  });
};
```

- [ ] **Step 4: Register in index.js**

```javascript
require('./src/modules/files/condition.routes')({ app, db, logger, config });
```

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/files/condition.* server/index.js
git commit -m "feat: condition snapshots — photo upload, history, condition tracking"
```

---

### Task 4: Products Module — Backend (Catalog + Barcode Lookup)

**Files:**
- Create: `server/src/modules/products/products.routes.js`
- Create: `server/src/modules/products/products.service.js`
- Create: `server/src/modules/products/products.schema.js`
- Create: `server/src/modules/products/lookup/lookup-orchestrator.js`
- Create: `server/src/modules/products/lookup/upc-database.js`
- Create: `server/src/modules/products/lookup/open-food-facts.js`
- Modify: `server/package.json` — add axios
- Modify: `server/index.js` — register products routes

- [ ] **Step 1: Install axios**

```bash
cd server && npm install axios
```

- [ ] **Step 2: Write open-food-facts.js**

Open Food Facts API adapter:
```javascript
const axios = require('axios');

const BASE_URL = 'https://world.openfoodfacts.org/api/v2';

async function lookupBarcode(barcode) {
  try {
    const { data } = await axios.get(`${BASE_URL}/product/${barcode}`, {
      timeout: 5000,
      headers: { 'User-Agent': 'Tally/1.0 (home-inventory)' },
    });
    if (data.status !== 1 || !data.product) return null;
    const p = data.product;
    return {
      barcode,
      name: p.product_name || p.generic_name || null,
      brand: p.brands || null,
      category: p.categories_tags?.[0]?.replace('en:', '') || null,
      description: p.generic_name || null,
      imageUrl: p.image_url || null,
      specs: {
        quantity: p.quantity,
        ingredients: p.ingredients_text,
        nutriscore: p.nutriscore_grade,
      },
      dataSource: 'open_food_facts',
    };
  } catch {
    return null;
  }
}

module.exports = { lookupBarcode };
```

- [ ] **Step 3: Write upc-database.js**

UPC Database API adapter (https://www.upcitemdb.com/):
```javascript
const axios = require('axios');

const BASE_URL = 'https://api.upcitemdb.com/prod/trial/lookup';

async function lookupBarcode(barcode) {
  try {
    const { data } = await axios.get(BASE_URL, {
      params: { upc: barcode },
      timeout: 5000,
      headers: { 'User-Agent': 'Tally/1.0 (home-inventory)' },
    });
    if (!data.items?.length) return null;
    const item = data.items[0];
    return {
      barcode,
      name: item.title || null,
      brand: item.brand || null,
      category: item.category || null,
      description: item.description || null,
      imageUrl: item.images?.[0] || null,
      retailPrice: item.lowest_recorded_price ? parseFloat(item.lowest_recorded_price) : null,
      retailLinks: (item.offers || []).map(o => ({
        retailer: o.merchant,
        url: o.link,
        price: o.price ? parseFloat(o.price) : null,
      })),
      specs: { ean: item.ean, upc: item.upc, model: item.model, weight: item.weight },
      dataSource: 'upc_db',
    };
  } catch {
    return null;
  }
}

module.exports = { lookupBarcode };
```

- [ ] **Step 4: Write lookup-orchestrator.js**

Chains lookup sources: local DB → UPC Database → Open Food Facts.

```javascript
const upcDatabase = require('./upc-database');
const openFoodFacts = require('./open-food-facts');

let db = null;

function init(dbRef) { db = dbRef; }

async function lookupByBarcode(barcode) {
  // Step 1: Check local catalog
  const local = await db.query(
    'SELECT * FROM TALLY.products WHERE BARCODE = ?',
    [barcode]
  );
  if (local.length > 0) {
    return { source: 'local', product: mapToResult(local[0]) };
  }

  // Step 2: Try UPC Database
  const upcResult = await upcDatabase.lookupBarcode(barcode);
  if (upcResult?.name) {
    return { source: 'upc_db', product: upcResult };
  }

  // Step 3: Try Open Food Facts
  const offResult = await openFoodFacts.lookupBarcode(barcode);
  if (offResult?.name) {
    return { source: 'open_food_facts', product: offResult };
  }

  // Step 4: No match — return barcode only so it can be saved with manual data
  return { source: 'not_found', product: { barcode } };
}

function mapToResult(row) {
  return {
    id: row.ID,
    barcode: row.BARCODE,
    name: row.NAME,
    brand: row.BRAND,
    category: row.CATEGORY,
    description: row.DESCRIPTION,
    imageUrl: row.IMAGE_URL,
    retailPrice: row.RETAIL_PRICE ? parseFloat(row.RETAIL_PRICE) : null,
    retailLinks: row.RETAIL_LINKS || [],
    specs: row.SPECS || {},
    depreciationRate: row.DEPRECIATION_RATE ? parseFloat(row.DEPRECIATION_RATE) : null,
    dataSource: row.DATA_SOURCE,
  };
}

module.exports = { init, lookupByBarcode };
```

- [ ] **Step 5: Write products.service.js**

ProductsService:
- `init({ db, logger })` — stores refs, calls `lookupOrchestrator.init(db)`
- `getById(id)` — SELECT from products WHERE ID = ?. Return camelCase.
- `getByBarcode(barcode)` — SELECT from products WHERE BARCODE = ?. Return camelCase or null.
- `lookupBarcode(barcode)` — calls `lookupOrchestrator.lookupByBarcode(barcode)`. If source is not 'local' and product has a name, auto-save to products table. Return result with source indicator.
- `create(data)` — INSERT into products. Return camelCase.
- `update(id, data)` — UPDATE products. Return camelCase.
- `checkDuplicate(barcode, userId)` — If barcode exists in products, find all items linked to that product that belong to the user's properties. Return array of existing items with their locations.
- `searchByText(query)` — FULLTEXT search on products (NAME, BRAND, DESCRIPTION). Return matches.

- [ ] **Step 6: Write products.schema.js**

```javascript
const Joi = require('joi');

const createProduct = Joi.object({
  barcode: Joi.string().max(50).required(),
  name: Joi.string().max(255).required(),
  brand: Joi.string().max(255).allow('', null),
  category: Joi.string().max(100).allow('', null),
  description: Joi.string().allow('', null),
  imageUrl: Joi.string().uri().allow('', null),
  retailPrice: Joi.number().precision(2).allow(null),
  retailLinks: Joi.array().items(Joi.object({
    retailer: Joi.string(),
    url: Joi.string().uri(),
    price: Joi.number().precision(2).allow(null),
  })).allow(null),
  specs: Joi.object().allow(null),
  depreciationRate: Joi.number().precision(4).min(0).max(1).allow(null),
  dataSource: Joi.string().valid('upc_db', 'open_food_facts', 'scrape', 'manual').default('manual'),
});

const updateProduct = Joi.object({
  name: Joi.string().max(255),
  brand: Joi.string().max(255).allow('', null),
  category: Joi.string().max(100).allow('', null),
  description: Joi.string().allow('', null),
  retailPrice: Joi.number().precision(2).allow(null),
  depreciationRate: Joi.number().precision(4).min(0).max(1).allow(null),
}).min(1);

const lookupBarcode = Joi.object({
  barcode: Joi.string().max(50).required(),
});

module.exports = { createProduct, updateProduct, lookupBarcode };
```

- [ ] **Step 7: Write products.routes.js**

Routes:
- `GET /api/products/_x_/:productId` — get product by ID
- `GET /api/products/_x_/barcode/:barcode` — get product by barcode (local only)
- `POST /api/products/_y_/lookup` — lookup barcode (local → external APIs). Body: `{ barcode }`. Returns `{ source, product }`.
- `POST /api/products/_y_/create` — create/save product manually (for failed lookups with user data)
- `PUT /api/products/_u_/:productId` — update product
- `GET /api/products/_x_/search` — text search products. Query: `?q=...`
- `POST /api/products/_y_/check-duplicate` — check if barcode already exists as items in user's inventory. Body: `{ barcode }`. Returns array of existing items.

All routes require auth.

- [ ] **Step 8: Register products routes in index.js**

```javascript
require('./src/modules/products/products.routes')({ app, db, logger, config });
```

- [ ] **Step 9: Commit**

```bash
git add server/src/modules/products/ server/index.js server/package.json server/package-lock.json
git commit -m "feat: products module — catalog CRUD, barcode lookup, duplicate detection"
```

---

### Task 5: Client — Scanner Page (Camera + Barcode Detection)

**Files:**
- Modify: `client/package.json` — add html5-qrcode
- Create: `client/src/components/scanner/camera-scanner.tsx`
- Create: `client/src/components/scanner/scan-result.tsx`
- Create: `client/src/components/scanner/product-search.tsx`
- Create: `client/src/components/scanner/duplicate-check.tsx`
- Modify: `client/src/pages/scan.tsx` — replace placeholder

- [ ] **Step 1: Install html5-qrcode**

```bash
cd client && npm install html5-qrcode
```

- [ ] **Step 2: Create camera-scanner.tsx**

Camera component using html5-qrcode:
- On mount, request camera permission and start scanning
- Detects barcodes (UPC, EAN, QR codes) continuously
- On barcode detected: calls `onBarcodeScanned(barcode)` callback
- Shows camera preview with scanning overlay
- Stop/start controls
- Props: `onBarcodeScanned: (code: string) => void`, `onClose: () => void`, `isActive: boolean`

```tsx
import { useEffect, useRef } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface CameraScannerProps {
  onBarcodeScanned: (code: string) => void;
  onClose: () => void;
  isActive: boolean;
}

export function CameraScanner({ onBarcodeScanned, onClose, isActive }: CameraScannerProps) {
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const containerRef = useRef<string>('scanner-container');

  useEffect(() => {
    if (!isActive) return;

    const scanner = new Html5Qrcode(containerRef.current);
    scannerRef.current = scanner;

    scanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 250, height: 250 } },
      (decodedText) => {
        onBarcodeScanned(decodedText);
      },
      () => {} // ignore scan failures
    ).catch(console.error);

    return () => {
      scanner.stop().catch(() => {});
    };
  }, [isActive, onBarcodeScanned]);

  return (
    <div className="relative">
      <div id={containerRef.current} className="w-full rounded-[var(--radius-lg)] overflow-hidden" />
      <Button variant="ghost" size="icon" className="absolute top-2 right-2 z-10" onClick={onClose}>
        <X className="w-5 h-5" />
      </Button>
    </div>
  );
}
```

- [ ] **Step 3: Create scan-result.tsx**

Displays the product lookup result after a barcode scan:
- Shows product image, name, brand, category, price if found
- "Add to Inventory" button → navigates to item create flow
- "Not the right product? Search manually" link
- Shows source badge (local / UPC Database / Open Food Facts)
- If source is 'not_found': shows "No product found" with manual entry form

- [ ] **Step 4: Create duplicate-check.tsx**

Dialog shown when a scanned barcode matches existing items in inventory:
- "You already have [product name] in [location]"
- List of existing items with their locations
- Options: "This is a new one" (proceed to add) or "Take me to existing" (navigate to item)

- [ ] **Step 5: Create product-search.tsx**

Manual product search component:
- Text input for searching products by name/brand
- Uses products text search API
- Shows results as selectable cards
- "Can't find it? Create manually" option

- [ ] **Step 6: Rewrite scan.tsx**

Replace the placeholder with the full scanner page:
- Camera scanner component at top
- Scan flow state machine:
  1. `idle` → camera active, waiting for scan
  2. `looking_up` → barcode detected, calling API
  3. `found` → product found, show result + duplicate check
  4. `not_found` → no match, show manual entry / text search
  5. `adding` → user is filling in item details to add to inventory
- Container/location selector: user picks where to place the scanned item
- After adding: toast confirmation, camera returns to scanning

- [ ] **Step 7: Commit**

```bash
git add client/src/components/scanner/ client/src/pages/scan.tsx client/package.json client/package-lock.json
git commit -m "feat: camera scanner — barcode detection, product lookup, add-to-inventory flow"
```

---

### Task 6: Client — File Upload & Condition History UI

**Files:**
- Create: `client/src/types/files.ts`
- Create: `client/src/hooks/use-files.ts`
- Create: `client/src/components/files/file-upload.tsx`
- Create: `client/src/components/files/file-list.tsx`
- Create: `client/src/components/condition/condition-form.tsx`
- Create: `client/src/components/condition/condition-timeline.tsx`
- Modify: `client/src/lib/query-client.ts` — add files + conditions query keys
- Modify: `client/src/pages/item-detail.tsx` — wire up files and condition sections

- [ ] **Step 1: Create types/files.ts**

```typescript
export interface ItemFile {
  id: number;
  itemId: number;
  fileType: 'receipt' | 'warranty' | 'manual' | 'photo' | 'other';
  fileKey: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  uploadedBy: number;
  createdAt: string;
  url?: string; // presigned URL
}

export interface ConditionSnapshot {
  id: number;
  itemId: number;
  condition: 'new' | 'good' | 'fair' | 'poor';
  photoKey: string;
  notes: string | null;
  recordedBy: number;
  recordedByName?: string;
  createdAt: string;
  photoUrl?: string; // presigned URL
}
```

- [ ] **Step 2: Create hooks/use-files.ts**

React Query hooks:
- `useItemFiles(itemId)` — GET /api/files/_x_/item/:itemId
- `useUploadFile()` — POST mutation with FormData (multipart)
- `useDeleteFile()` — DELETE mutation
- `useConditionHistory(itemId)` — GET /api/conditions/_x_/item/:itemId
- `useCreateCondition()` — POST mutation with FormData (multipart)

For upload mutations, use FormData:
```typescript
export function useUploadFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ itemId, file, fileType }: { itemId: number; file: File; fileType: string }) => {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('fileType', fileType);
      const res = await fetch(`/api/files/_y_/item/${itemId}/upload`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.message);
      return json.data;
    },
    onSuccess: (_, vars) => qc.invalidateQueries({ queryKey: queryKeys.files.byItem(vars.itemId) }),
  });
}
```

- [ ] **Step 3: Add query keys to query-client.ts**

Add to the existing queryKeys object:
```typescript
files: {
  all: ['files'] as const,
  byItem: (itemId: number) => [...queryKeys.files.all, 'byItem', itemId] as const,
},
conditions: {
  all: ['conditions'] as const,
  byItem: (itemId: number) => [...queryKeys.conditions.all, 'byItem', itemId] as const,
},
products: {
  all: ['products'] as const,
  detail: (id: number) => [...queryKeys.products.all, 'detail', id] as const,
  barcode: (barcode: string) => [...queryKeys.products.all, 'barcode', barcode] as const,
  search: (q: string) => [...queryKeys.products.all, 'search', q] as const,
},
```

- [ ] **Step 4: Create file-upload.tsx**

File upload component:
- Tap/click to select file (or drag-and-drop on desktop)
- File type selector (receipt, warranty, manual, photo, other)
- Upload progress indicator
- Uses useUploadFile() mutation
- Props: `itemId: number`

- [ ] **Step 5: Create file-list.tsx**

List of attached files:
- Groups by file type (receipts, warranties, manuals, photos, other)
- Each file shows: icon by type (FileText for docs, Image for photos), file name, size, date
- Click to open presigned URL in new tab
- Delete button (with confirmation)
- Props: `itemId: number`

- [ ] **Step 6: Create condition-form.tsx**

New condition snapshot form:
- Condition selector (new/good/fair/poor) as radio buttons with colored badges
- Camera capture button (opens camera to take photo) or file picker
- Notes text area
- Submit creates the snapshot via useCreateCondition()
- Props: `itemId: number`, `onComplete: () => void`

- [ ] **Step 7: Create condition-timeline.tsx**

Timeline of condition snapshots:
- Chronological list (newest first)
- Each entry: photo thumbnail, condition badge, notes, date, recorded by
- Click photo to view full size
- Props: `itemId: number`

- [ ] **Step 8: Update item-detail.tsx**

Replace the "Coming soon" placeholders:
- **Files section**: Render `FileList` + `FileUpload` components
- **Condition History section**: Render `ConditionTimeline` + button to open `ConditionForm` dialog
- Keep Dates, Accessories, Lending as placeholders (those are Phase 4)

- [ ] **Step 9: Commit**

```bash
git add client/src/types/files.ts client/src/hooks/use-files.ts client/src/components/files/ client/src/components/condition/ client/src/lib/query-client.ts client/src/pages/item-detail.tsx
git commit -m "feat: file upload UI, condition history — attach files, track condition over time"
```

---

### Task 7: Client — Products Integration & Hook Wiring

**Files:**
- Create: `client/src/hooks/use-products.ts`
- Modify: `client/src/pages/home.tsx` — improve search to include product data
- Modify: `client/src/components/inventory/item-card.tsx` — show product image if available

- [ ] **Step 1: Create hooks/use-products.ts**

```typescript
import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-client';

interface LookupResult {
  source: 'local' | 'upc_db' | 'open_food_facts' | 'not_found';
  product: Record<string, unknown>;
}

interface DuplicateItem {
  id: number;
  name: string;
  containerName: string;
  areaName: string;
  propertyName: string;
}

export function useLookupBarcode() {
  return useMutation({
    mutationFn: (barcode: string) =>
      api.post<LookupResult>('/api/products/_y_/lookup', { barcode }),
  });
}

export function useCheckDuplicate() {
  return useMutation({
    mutationFn: (barcode: string) =>
      api.post<DuplicateItem[]>('/api/products/_y_/check-duplicate', { barcode }),
  });
}

export function useSearchProducts(query: string) {
  return useQuery({
    queryKey: queryKeys.products.search(query),
    queryFn: () => api.get<unknown[]>(`/api/products/_x_/search?q=${encodeURIComponent(query)}`),
    enabled: query.length >= 2,
  });
}

export function useCreateProduct() {
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      api.post('/api/products/_y_/create', data),
  });
}
```

- [ ] **Step 2: Update item-card.tsx**

If the item has a product with an imageUrl, show the product image instead of the placeholder Image icon.

- [ ] **Step 3: Commit**

```bash
git add client/src/hooks/use-products.ts client/src/components/inventory/item-card.tsx client/src/pages/home.tsx
git commit -m "feat: products integration — barcode lookup hooks, product images on cards"
```

---

### Task 8: Final Integration & Build Verification

**Files:**
- Modify: `CLAUDE.md` — update with Phase 2 modules
- Verify TypeScript compiles
- Verify Vite builds

- [ ] **Step 1: Verify TypeScript compiles**

```bash
cd client && npx tsc --noEmit
```

Fix any errors.

- [ ] **Step 2: Verify client builds**

```bash
cd client && npm run build
```

Fix any errors.

- [ ] **Step 3: Update CLAUDE.md**

Add to the registered routes table:
- products module routes
- files module routes
- conditions module routes

Add notes about:
- MinIO storage infrastructure
- External API integrations (Open Food Facts, UPC Database)
- Camera scanning via html5-qrcode

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: phase 2 complete — product lookup, file uploads, condition tracking, camera scanner"
```

---

## Phase Summary

After completing Phase 2, you will have:

- **Products module**: Barcode lookup (local → UPC Database → Open Food Facts), product catalog CRUD, duplicate detection, text search
- **Files module**: Upload/download files to MinIO (receipts, warranties, manuals, photos), presigned URLs, file management
- **Condition tracking**: Photo-based condition snapshots with timeline history, auto-updates item condition
- **Camera scanner**: Browser-based barcode scanning, product lookup flow, add-to-inventory workflow
- **Enhanced item detail**: Files section, condition history, product info display

**Next: Phase 3 — Organization & Labels** (tags, QR codes, label printing, scan-scan-done)

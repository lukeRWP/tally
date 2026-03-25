# Tally Phase 4: Lifecycle & Notifications — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add item lending/checkout tracking, flexible user-defined dates, accessories, depreciation calculation, audit trail, in-app notifications with opt-in preferences, soft delete recycle bin with 30-day purge, and notification bell UI.

**Architecture:** New `lending`, `dates`, `accessories`, `audit`, and `notifications` backend service modules. Audit trail hooks into existing CRUD services via a shared `logChange()` helper. Notifications are created reactively when auditable events occur and when date-based triggers fire. A lightweight scheduled check (on API request, not cron) evaluates upcoming dates for notification generation. Recycle bin is a UI view over soft-deleted entities with a purge endpoint.

**Tech Stack:** No new npm dependencies — uses existing Express, MySQL, and React stack.

**Spec:** `docs/superpowers/specs/2026-03-23-tally-design.md` — Sections 3 (item_dates, item_accessories, item_lending, change_log, notifications, notification_preferences), 8 (Notifications), 9 (Soft Deletes & Recycle Bin)

**Depends on:** Phase 3 complete (`/Users/luke/dev/tally/`)

---

## File Structure

### New Server Files

```
server/src/modules/
├── lending/
│   ├── lending.routes.js       # Lend, return, list active/history
│   ├── lending.service.js      # item_lending CRUD, item status toggling
│   └── lending.schema.js       # Joi validation
├── dates/
│   ├── dates.routes.js         # CRUD for item_dates
│   ├── dates.service.js        # Flexible date management
│   └── dates.schema.js         # Joi validation
├── accessories/
│   ├── accessories.routes.js   # Link/unlink accessories
│   ├── accessories.service.js  # item_accessories management
│   └── accessories.schema.js   # Joi validation
├── audit/
│   ├── audit.routes.js         # Query change_log (activity feed)
│   ├── audit.service.js        # logChange() + query methods
│   └── audit.schema.js         # Joi validation
└── notifications/
    ├── notifications.routes.js  # List, mark read, preferences
    ├── notifications.service.js # Create, query, preferences, date-based checks
    └── notifications.schema.js  # Joi validation
```

### New Client Files

```
client/src/
├── components/
│   ├── lending/
│   │   ├── lend-form.tsx       # Lend item dialog
│   │   ├── lending-list.tsx    # Active + history list
│   │   └── return-dialog.tsx   # Mark as returned
│   ├── dates/
│   │   ├── date-form.tsx       # Add/edit custom date
│   │   └── date-list.tsx       # List of dates on item
│   ├── accessories/
│   │   ├── accessory-picker.tsx # Link/unlink accessories
│   │   └── accessory-list.tsx  # List of linked accessories
│   ├── notifications/
│   │   ├── notification-bell.tsx    # Header bell with unread count
│   │   ├── notification-list.tsx    # Full notification list page
│   │   └── notification-prefs.tsx   # Preferences toggles in settings
│   └── recycle-bin/
│       └── recycle-bin-list.tsx # Soft-deleted items with restore/purge
├── hooks/
│   ├── use-lending.ts
│   ├── use-dates.ts
│   ├── use-accessories.ts
│   └── use-notifications.ts
└── pages/
    └── recycle-bin.tsx          # Recycle bin page
```

### Modified Files

```
server/index.js                         # Register 5 new modules
client/src/App.tsx                      # Add recycle bin + notifications routes
client/src/pages/item-detail.tsx        # Wire dates, accessories, lending sections
client/src/pages/settings.tsx           # Add notification preferences
client/src/components/layout/header.tsx # Add notification bell
client/src/lib/query-client.ts          # Add new query keys
```

---

## Task Breakdown

### Task 1: Lending Module — Backend

**Files:**
- Create: `server/src/modules/lending/lending.routes.js`
- Create: `server/src/modules/lending/lending.service.js`
- Create: `server/src/modules/lending/lending.schema.js`
- Modify: `server/index.js`

- [ ] **Step 1: Write lending.service.js**

LendingService:
- `init({ db, logger })` — stores refs
- `lend(itemId, data, userId)` — INSERT into item_lending (ITEM_ID, LENT_TO, LENT_AT, DUE_AT, NOTES, CREATED_BY). UPDATE items SET STATUS = 'lent' WHERE ID = itemId. Call `AuditService.logChange(userId, 'item', itemId, 'lent', { lentTo: data.lentTo }, propertyId)`. Return camelCase.
- `return(lendingId, userId)` — UPDATE item_lending SET RETURNED_AT = NOW(). Get ITEM_ID, UPDATE items SET STATUS = 'active'. Call `AuditService.logChange(userId, 'item', itemId, 'returned', { returnedFrom: lending.LENT_TO }, propertyId)`. Return camelCase.
- `getActive(itemId)` — SELECT from item_lending WHERE ITEM_ID = ? AND RETURNED_AT IS NULL. Return camelCase or null.
- `getHistory(itemId)` — SELECT from item_lending WHERE ITEM_ID = ? ORDER BY LENT_AT DESC. Return camelCase array.
- `getOverdue(userId)` — SELECT all item_lending WHERE RETURNED_AT IS NULL AND DUE_AT < NOW() AND the item belongs to a property the user is a member of. JOIN items → containers → areas → property_members. Return camelCase array with item and location info.

- [ ] **Step 2: Write lending.schema.js**

```javascript
const Joi = require('joi');

const lendItem = Joi.object({
  lentTo: Joi.string().max(255).required(),
  dueAt: Joi.date().iso().allow(null),
  notes: Joi.string().allow('', null),
});

module.exports = { lendItem };
```

- [ ] **Step 3: Write lending.routes.js**

Routes (all require auth + property authorization via item resolution):
- `POST /api/lending/_y_/item/:itemId/lend` — lend item. resolvePropertyFromItem, requireRole('owner', 'editor'). Validate lendItem schema.
- `PATCH /api/lending/_p_/:lendingId/return` — return item. Resolve property from lending record's item. requireRole('owner', 'editor').
- `GET /api/lending/_x_/item/:itemId` — get lending history for item. resolvePropertyFromItem, check membership.
- `GET /api/lending/_x_/item/:itemId/active` — get active lending for item.
- `GET /api/lending/_x_/overdue` — get all overdue items for current user (no property filter needed — scoped by user).

Use same `resolvePropertyFromItem` pattern as files/conditions modules.

- [ ] **Step 4: Register and commit**

```bash
git add server/src/modules/lending/ server/index.js
git commit -m "feat: lending module — lend, return, history, overdue tracking"
```

---

### Task 2: Flexible Dates Module — Backend

**Files:**
- Create: `server/src/modules/dates/dates.routes.js`
- Create: `server/src/modules/dates/dates.service.js`
- Create: `server/src/modules/dates/dates.schema.js`
- Modify: `server/index.js`

- [ ] **Step 1: Write dates.service.js**

DatesService:
- `init({ db, logger })` — stores refs
- `getByItem(itemId)` — SELECT from item_dates WHERE ITEM_ID = ? ORDER BY DATE_VALUE ASC. Return camelCase.
- `create(itemId, data)` — INSERT into item_dates (ITEM_ID, DATE_TYPE, DATE_VALUE, NOTES). Return camelCase.
- `update(dateId, data)` — UPDATE item_dates SET dynamic fields. Return camelCase.
- `delete(dateId)` — DELETE FROM item_dates WHERE ID = ?
- `getUpcoming(userId, daysAhead = 30)` — SELECT dates where DATE_VALUE is within the next N days AND the item belongs to user's properties. JOIN items → containers → areas → property_members. Return camelCase with item name and location.

- [ ] **Step 2: Write dates.schema.js**

```javascript
const Joi = require('joi');

const createDate = Joi.object({
  dateType: Joi.string().max(50).required(),
  dateValue: Joi.date().iso().required(),
  notes: Joi.string().allow('', null),
});

const updateDate = Joi.object({
  dateType: Joi.string().max(50),
  dateValue: Joi.date().iso(),
  notes: Joi.string().allow('', null),
}).min(1);

module.exports = { createDate, updateDate };
```

- [ ] **Step 3: Write dates.routes.js**

Routes:
- `GET /api/dates/_x_/item/:itemId` — list dates for item. Auth + resolvePropertyFromItem.
- `POST /api/dates/_y_/item/:itemId` — create date. requireRole('owner', 'editor').
- `PUT /api/dates/_u_/:dateId` — update date. Resolve property from the date's item.
- `DELETE /api/dates/_d_/:dateId` — delete date.
- `GET /api/dates/_x_/upcoming` — upcoming dates for current user. Query param: `?days=30`.

- [ ] **Step 4: Register and commit**

```bash
git add server/src/modules/dates/ server/index.js
git commit -m "feat: flexible dates — user-defined date types per item"
```

---

### Task 3: Accessories Module — Backend

**Files:**
- Create: `server/src/modules/accessories/accessories.routes.js`
- Create: `server/src/modules/accessories/accessories.service.js`
- Create: `server/src/modules/accessories/accessories.schema.js`
- Modify: `server/index.js`

- [ ] **Step 1: Write accessories.service.js**

AccessoriesService:
- `init({ db, logger })` — stores refs
- `getForItem(itemId)` — SELECT ia.*, i.NAME, i.QR_CODE, i.CONDITION FROM item_accessories ia JOIN items i ON ia.ACCESSORY_ID = i.ID WHERE ia.ITEM_ID = ?. Return camelCase with accessory item details.
- `getParent(accessoryId)` — SELECT ia.*, i.NAME FROM item_accessories ia JOIN items i ON ia.ITEM_ID = i.ID WHERE ia.ACCESSORY_ID = ?. Return parent item or null.
- `link(itemId, accessoryId)` — INSERT into item_accessories. Handle ER_DUP_ENTRY. Validate that accessoryId is not the same as itemId (no self-reference).
- `unlink(itemId, accessoryId)` — DELETE FROM item_accessories WHERE ITEM_ID = ? AND ACCESSORY_ID = ?

- [ ] **Step 2: Write accessories.schema.js**

```javascript
const Joi = require('joi');

const linkAccessory = Joi.object({
  accessoryId: Joi.number().integer().required(),
});

module.exports = { linkAccessory };
```

- [ ] **Step 3: Write accessories.routes.js**

Routes:
- `GET /api/accessories/_x_/item/:itemId` — list accessories. Auth + resolvePropertyFromItem.
- `POST /api/accessories/_y_/item/:itemId/link` — link accessory. requireRole('owner', 'editor'). Body: `{ accessoryId }`.
- `DELETE /api/accessories/_d_/item/:itemId/unlink/:accessoryId` — unlink. requireRole('owner', 'editor').

- [ ] **Step 4: Register and commit**

```bash
git add server/src/modules/accessories/ server/index.js
git commit -m "feat: accessories — link/unlink items as accessories"
```

---

### Task 4: Audit Trail — Backend

**Files:**
- Create: `server/src/modules/audit/audit.routes.js`
- Create: `server/src/modules/audit/audit.service.js`
- Create: `server/src/modules/audit/audit.schema.js`
- Modify: `server/index.js`

- [ ] **Step 1: Write audit.service.js**

AuditService:
- `init({ db, logger })` — stores refs
- `logChange(userId, entityType, entityId, action, changes, propertyId)` — INSERT into change_log. This is the core method called by other services.
- `getByProperty(propertyId, { limit = 50, offset = 0 })` — SELECT from change_log cl JOIN users u ON cl.USER_ID = u.ID WHERE cl.PROPERTY_ID = ? ORDER BY cl.CREATED_AT DESC LIMIT ? OFFSET ?. Return camelCase with user display name.
- `getByEntity(entityType, entityId, { limit = 50, offset = 0 })` — SELECT by entity. Return camelCase.
- `getRecent(userId, limit = 20)` — SELECT recent changes across all user's properties. JOIN property_members. Return camelCase with entity names.

The `logChange` method is designed to be called from within other services (properties, areas, containers, items) when CRUD operations happen. However, to avoid modifying all existing services in this task, we'll add the audit logging in a lightweight way:

Create a helper function that can be imported by any service:
```javascript
// Can be called from any service after a successful operation
async function logChange(userId, entityType, entityId, action, changes, propertyId) {
  try {
    await db.query(
      `INSERT INTO TALLY.change_log (USER_ID, ENTITY_TYPE, ENTITY_ID, ACTION, CHANGES, PROPERTY_ID)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, entityType, entityId, action, JSON.stringify(changes), propertyId]
    );
  } catch (err) {
    // Audit logging should never block the main operation
    logger.error('Failed to log change', { err: err.message, entityType, entityId, action });
  }
}
```

- [ ] **Step 2: Write audit.schema.js**

```javascript
const Joi = require('joi');

const queryLog = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(50),
  offset: Joi.number().integer().min(0).default(0),
  entityType: Joi.string().valid('property', 'area', 'container', 'item'),
  action: Joi.string().valid('created', 'updated', 'moved', 'deleted', 'restored', 'lent', 'returned'),
});

module.exports = { queryLog };
```

- [ ] **Step 3: Write audit.routes.js**

Routes:
- `GET /api/audit/_x_/property/:propertyId` — activity log for property. resolvePropertyRole, check membership. Query params: limit, offset, entityType, action.
- `GET /api/audit/_x_/entity/:entityType/:entityId` — activity for specific entity. Auth only.
- `GET /api/audit/_x_/recent` — recent activity across user's properties.

- [ ] **Step 4: Add audit calls to existing inventory services**

After creating the audit module, add `AuditService.logChange()` calls to the existing inventory services (items, containers, areas, properties) for create, update, move, delete, and restore operations. Import AuditService in each service and call `logChange` after successful mutations. The call is fire-and-forget (wrapped in try/catch — never blocks the main operation).

Key integration points in `server/src/modules/inventory/`:
- `items.service.js`: create → 'created', update → 'updated', move → 'moved', softDelete → 'deleted', restore → 'restored'
- `containers.service.js`: create → 'created', update → 'updated', move → 'moved', softDelete → 'deleted'
- `areas.service.js`: create → 'created', update → 'updated', softDelete → 'deleted'
- `properties.service.js`: create → 'created', update → 'updated', softDelete → 'deleted'

Each call needs: `userId` (from req.user.id, passed as parameter to service methods — add userId parameter where missing), `entityType`, `entityId`, `action`, `changes` (JSON diff), `propertyId`.

- [ ] **Step 5: Register and commit**

```bash
git add server/src/modules/audit/ server/src/modules/inventory/ server/index.js
git commit -m "feat: audit trail — change log with activity feed, integrated into all CRUD ops"
```

---

### Task 5: Notifications Module — Backend

**Files:**
- Create: `server/src/modules/notifications/notifications.routes.js`
- Create: `server/src/modules/notifications/notifications.service.js`
- Create: `server/src/modules/notifications/notifications.schema.js`
- Modify: `server/index.js`

- [ ] **Step 1: Write notifications.service.js**

NotificationsService:
- `init({ db, logger })` — stores refs
- `create(userId, type, title, message, entityType, entityId)` — Check if user has this type enabled in preferences. If not, skip. INSERT into notifications. Return camelCase or null if skipped.
- `getForUser(userId, { limit = 50, offset = 0, unreadOnly = false })` — SELECT from notifications WHERE USER_ID = ?. If unreadOnly, add AND READ_AT IS NULL. ORDER BY CREATED_AT DESC. Return camelCase.
- `getUnreadCount(userId)` — SELECT COUNT(*) FROM notifications WHERE USER_ID = ? AND READ_AT IS NULL.
- `markRead(notificationId, userId)` — UPDATE SET READ_AT = NOW() WHERE ID = ? AND USER_ID = ?
- `markAllRead(userId)` — UPDATE SET READ_AT = NOW() WHERE USER_ID = ? AND READ_AT IS NULL
- `dismiss(notificationId, userId)` — DELETE WHERE ID = ? AND USER_ID = ?
- `getPreferences(userId)` — SELECT from notification_preferences WHERE USER_ID = ?. Return map of type → enabled.
- `updatePreference(userId, type, enabled)` — INSERT INTO notification_preferences ON DUPLICATE KEY UPDATE ENABLED = ?
- `checkDateNotifications(userId)` — Check for upcoming dates (item_dates) and overdue lendings. For each, create a notification if one doesn't already exist for that entity+type within the last 24 hours (prevent duplicates). This runs lazily when the user fetches notifications.

- [ ] **Step 2: Write notifications.schema.js**

```javascript
const Joi = require('joi');

const queryNotifications = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(50),
  offset: Joi.number().integer().min(0).default(0),
  unreadOnly: Joi.boolean().default(false),
});

const updatePreference = Joi.object({
  type: Joi.string().valid('warranty_expiry', 'lending_due', 'item_moved', 'item_removed', 'share_expiring', 'custom_date').required(),
  enabled: Joi.boolean().required(),
});

module.exports = { queryNotifications, updatePreference };
```

- [ ] **Step 3: Write notifications.routes.js**

Routes:
- `GET /api/notifications/_x_/list` — list notifications for user. Query: limit, offset, unreadOnly. Also triggers `checkDateNotifications` lazily.
- `GET /api/notifications/_x_/unread-count` — unread count.
- `PATCH /api/notifications/_p_/:notificationId/read` — mark single read.
- `PATCH /api/notifications/_p_/read-all` — mark all read.
- `DELETE /api/notifications/_d_/:notificationId` — dismiss.
- `GET /api/notifications/_x_/preferences` — get user's notification preferences.
- `PUT /api/notifications/_u_/preferences` — update a preference. Body: `{ type, enabled }`.

All routes require auth (user-scoped, no property resolution needed).

- [ ] **Step 4: Register and commit**

```bash
git add server/src/modules/notifications/ server/index.js
git commit -m "feat: notifications — in-app alerts, preferences, date-based checks"
```

---

### Task 6: Recycle Bin & Soft Delete Purge — Backend

**Files:**
- Modify: `server/src/modules/inventory/properties.service.js` — add getDeleted, purge methods
- Modify: `server/src/modules/inventory/items.service.js` — add getDeleted, purge methods
- Add routes for recycle bin queries

- [ ] **Step 1: Add recycle bin methods to existing services**

Add to PropertiesService (or create a shared recycle service):
- `getDeletedItems(userId, { limit = 50, offset = 0 })` — SELECT items WHERE DELETED_AT IS NOT NULL AND DELETED_AT > NOW() - INTERVAL 30 DAY, scoped to user's properties. Include container/area/property breadcrumb info. Return camelCase.
- `getDeletedContainers(userId)` — same for containers
- `purgeExpired()` — DELETE FROM items WHERE DELETED_AT IS NOT NULL AND DELETED_AT < NOW() - INTERVAL 30 DAY. Same for containers, areas, properties. This runs lazily (called on recycle bin page load).

Add a `recycle` route set (can be in inventory module or a new endpoint):
- `GET /api/recycle/_x_/items` — deleted items for user
- `POST /api/recycle/_y_/purge` — purge expired items (owner only)

Or simpler: add to existing items routes:
- `GET /api/items/_x_/deleted` — list soft-deleted items for current user
- `PATCH /api/items/_p_/:itemId/restore` — restore (already exists in items.service)
- `DELETE /api/items/_d_/:itemId/permanent` — permanently delete

- [ ] **Step 2: Commit**

```bash
git add server/src/modules/inventory/
git commit -m "feat: recycle bin — view deleted items, restore, permanent purge after 30 days"
```

---

### Task 7: Frontend — Lending, Dates, Accessories UI

**Files to create:**
- `client/src/hooks/use-lending.ts`
- `client/src/hooks/use-dates.ts`
- `client/src/hooks/use-accessories.ts`
- `client/src/components/lending/lend-form.tsx`
- `client/src/components/lending/lending-list.tsx`
- `client/src/components/lending/return-dialog.tsx`
- `client/src/components/dates/date-form.tsx`
- `client/src/components/dates/date-list.tsx`
- `client/src/components/accessories/accessory-picker.tsx`
- `client/src/components/accessories/accessory-list.tsx`

**Files to modify:**
- `client/src/pages/item-detail.tsx` — replace Phase 4 placeholders with real components
- `client/src/lib/query-client.ts` — add new query keys

- [ ] **Step 1: Add query keys**

Add to queryKeys:
```typescript
lending: {
  all: ['lending'] as const,
  byItem: (itemId: number) => [...queryKeys.lending.all, 'byItem', itemId] as const,
  active: (itemId: number) => [...queryKeys.lending.all, 'active', itemId] as const,
  overdue: () => [...queryKeys.lending.all, 'overdue'] as const,
},
dates: {
  all: ['dates'] as const,
  byItem: (itemId: number) => [...queryKeys.dates.all, 'byItem', itemId] as const,
  upcoming: () => [...queryKeys.dates.all, 'upcoming'] as const,
},
accessories: {
  all: ['accessories'] as const,
  byItem: (itemId: number) => [...queryKeys.accessories.all, 'byItem', itemId] as const,
},
notifications: {
  all: ['notifications'] as const,
  list: () => [...queryKeys.notifications.all, 'list'] as const,
  unreadCount: () => [...queryKeys.notifications.all, 'unreadCount'] as const,
  preferences: () => [...queryKeys.notifications.all, 'preferences'] as const,
},
audit: {
  all: ['audit'] as const,
  byProperty: (propertyId: number) => [...queryKeys.audit.all, 'byProperty', propertyId] as const,
  recent: () => [...queryKeys.audit.all, 'recent'] as const,
},
```

- [ ] **Step 2: Create hooks**

Standard React Query hooks for each module following existing patterns (use-inventory.ts as reference).

- [ ] **Step 3: Create lending components**

**lend-form.tsx:** Dialog with fields: "Lent to" (text), "Due date" (date picker or input type="date"), "Notes" (textarea). Submit calls useLendItem().

**lending-list.tsx:** Shows active lending (if any) with return button, plus history below. Each entry: lent to, date, due date, status (active/returned/overdue). Uses useLendingHistory().

**return-dialog.tsx:** Simple confirmation: "Mark [item] as returned from [person]?" Submit calls useReturnItem().

- [ ] **Step 4: Create dates components**

**date-form.tsx:** Dialog: date type (text input with suggestions like "Purchased", "Warranty expires"), date value (input type="date"), notes. Submit calls useCreateDate().

**date-list.tsx:** List of dates sorted chronologically. Each: type label, date value, notes. Edit/delete buttons.

- [ ] **Step 5: Create accessories components**

**accessory-picker.tsx:** Search for items in the same property to link as accessories. Uses item search API. Shows results, click to link.

**accessory-list.tsx:** List of linked accessories. Each: item name, QR code, condition badge. Click navigates to accessory's item detail. Unlink button.

- [ ] **Step 6: Add depreciation calculation to item detail**

In item-detail.tsx, display depreciation info when `item.depreciationEnabled` is true:
- Show current estimated value: `purchasePrice * (1 - depreciationRate) ^ yearsSincePurchase`
- `yearsSincePurchase` is calculated from the item's "purchased" date in item_dates (or item.createdAt as fallback)
- Display: "Estimated Value: $XXX (depreciated X% annually since YYYY-MM-DD)"
- This is client-side calculation only — no backend endpoint needed

- [ ] **Step 7: Wire into item-detail.tsx**

Replace "Coming in Phase 4" placeholders:
- **Dates section:** `<DateList itemId={id} />` + "Add Date" button → `<DateForm>`
- **Accessories section:** `<AccessoryList itemId={id} />` + "Link Accessory" button → `<AccessoryPicker>`
- **Lending section:** `<LendingList itemId={id} />` + "Lend Item" button → `<LendForm>` (only if item status is 'active')

- [ ] **Step 7: Commit**

```bash
git add client/src/hooks/ client/src/components/lending/ client/src/components/dates/ client/src/components/accessories/ client/src/pages/item-detail.tsx client/src/lib/query-client.ts
git commit -m "feat: lending, dates, accessories UI — full item lifecycle on detail page"
```

---

### Task 8: Frontend — Notifications & Recycle Bin

**Files to create:**
- `client/src/hooks/use-notifications.ts`
- `client/src/components/notifications/notification-bell.tsx`
- `client/src/components/notifications/notification-list.tsx`
- `client/src/components/notifications/notification-prefs.tsx`
- `client/src/components/recycle-bin/recycle-bin-list.tsx`
- `client/src/pages/recycle-bin.tsx`

**Files to modify:**
- `client/src/components/layout/header.tsx` — replace placeholder bell with NotificationBell
- `client/src/pages/settings.tsx` — add notification preferences
- `client/src/App.tsx` — add recycle bin + notifications routes
- `client/src/pages/home.tsx` — replace placeholder activity feed with real audit data

- [ ] **Step 1: Create use-notifications.ts**

Hooks:
- `useNotifications(options)` — GET /api/notifications/_x_/list
- `useUnreadCount()` — GET /api/notifications/_x_/unread-count, refetchInterval: 60000 (poll every minute)
- `useMarkRead()` — PATCH mutation
- `useMarkAllRead()` — PATCH mutation
- `useDismissNotification()` — DELETE mutation
- `useNotificationPreferences()` — GET preferences
- `useUpdatePreference()` — PUT mutation

- [ ] **Step 2: Create notification-bell.tsx**

Header component:
- Bell icon (Lucide Bell)
- Unread count badge (red circle with number, hidden when 0)
- Click navigates to `/notifications` page
- Uses `useUnreadCount()` hook with polling

- [ ] **Step 3: Create notification-list.tsx**

Full notifications page:
- List of notifications, newest first
- Each: icon by type, title (bold), message, relative time
- Unread items have a left border accent or dot indicator
- Click marks as read + navigates to entity (if entity link exists)
- "Mark all read" button at top
- Dismiss (X) button per notification
- Empty state: "No notifications"

- [ ] **Step 4: Create notification-prefs.tsx**

Settings component:
- List of notification types with toggle switches
- Uses useNotificationPreferences() and useUpdatePreference()
- Types: Warranty expiry, Lending due, Item moved, Item removed, Share expiring, Custom date

- [ ] **Step 5: Create recycle-bin page**

`recycle-bin.tsx`:
- Lists soft-deleted items grouped by property
- Each item: name, deleted date, "X days until permanent deletion"
- Restore button (calls PATCH /api/items/_p_/:id/restore)
- "Purge expired" button (items older than 30 days)
- Empty state: "Recycle bin is empty"

`recycle-bin-list.tsx`: Reusable list component.

- [ ] **Step 6: Wire up header, settings, routing, home page**

**header.tsx:** Replace the static Bell button with `<NotificationBell />`

**settings.tsx:** Add "Notifications" section with `<NotificationPrefs />`

**App.tsx:** Add routes:
```tsx
<Route path="/notifications" element={<NotificationList />} />
<Route path="/recycle-bin" element={<RecycleBin />} />
```

**home.tsx:** Replace the static "Recent Activity" section with real audit data using `useRecentActivity()` hook (calls GET /api/audit/_x_/recent).

- [ ] **Step 7: Commit**

```bash
git add client/src/hooks/use-notifications.ts client/src/components/notifications/ client/src/components/recycle-bin/ client/src/pages/recycle-bin.tsx client/src/components/layout/header.tsx client/src/pages/settings.tsx client/src/App.tsx client/src/pages/home.tsx
git commit -m "feat: notifications UI, recycle bin, real activity feed on dashboard"
```

---

### Task 9: Final Integration & Build Verification

**Files:**
- Modify: `CLAUDE.md`
- Verify TypeScript + build

- [ ] **Step 1: Verify TypeScript and build**

```bash
cd client && npx tsc --noEmit && npm run build
```

Fix any errors.

- [ ] **Step 2: Update CLAUDE.md**

Add to routes table: lending, dates, accessories, audit, notifications. Add notes about:
- Audit trail system
- Notification preferences (opt-in)
- Recycle bin with 30-day purge
- Depreciation formula

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: phase 4 complete — lending, dates, accessories, audit, notifications, recycle bin"
```

---

## Phase Summary

After completing Phase 4:

- **Lending**: Lend/return items, overdue tracking, lending history
- **Flexible dates**: User-defined date types per item (purchased, warranty expires, etc.)
- **Accessories**: Link items as accessories to other items
- **Audit trail**: Change log for all CRUD operations, activity feed on dashboard
- **Notifications**: In-app with opt-in preferences, date-based checks (warranty expiry, lending due, custom dates), notification bell with unread count
- **Recycle bin**: View deleted items, restore within 30 days, automatic purge
- **Depreciation**: Calculated on-demand via formula (opt-in per item, already in data model from Phase 1)

**Next: Phase 5 — Reports, Sharing & Deployment** (PDF/CSV export, share links, PW app.yml, CI/CD)

# Label Redesign — Design (Phase 1)

**Status:** Approved (operator, 2026-08-03)
**Scope:** Redesign tally's label output for the Munbyn ITPP941 thermal printer — a single-label renderer with three size presets (item tag, bin/location tag, contents manifest), a unified inverted-title/location-banner visual language, and correctly-sized PDF output. This is **Phase 1** of a two-phase effort; **Phase 2** (pull-based auto-print to a Raspberry Pi) gets its own spec.

Mockup that this spec captures: the approved proof sheet (`label-mockups.html`, three presets rendered black-on-white at true relative scale).

## 1. Context & the printer reality

The target printer is a **Munbyn ITPP941** (USB → Raspberry Pi, 203 dpi). It speaks **TSPL/TSPL2** — *not* ZPL (Zebra) or ESC/POS — so the existing ZPL generator cannot drive it. Rather than hand-write TSPL, we **render each label as a PDF at its exact stock dimensions** and let the Pi's CUPS + Munbyn `rastertolabel` driver rasterize it (Phase 2). Rendering to PDF also gives full layout control (fonts, QR, wrapping) — which is what the redesign needs — and reuses **pdfkit**, already a server dependency for the Avery sheets.

Consequences:
- **ZPL is removed** (targets Zebra, which the operator does not have).
- The **Avery 30-up sheet PDF is kept** (still useful for laser bulk printing).
- All label output is now **PDF**.

## 2. Visual language (applies to all presets)

- **Inverted title bar** — the entity name renders as **white text on a solid black bar** (rounded 3px), at the top of the label / header. Solid black lays down crisp on a thermal head, and it reads as the label's headline.
- **Inverted location banner** — a **vertical black strip down the LEFT edge** with the parent-zone location in **white, rotated 90°** (uppercase, letter-spaced). Present on Medium and Large (not on the item tag). "Parent zone" = one meaningful level up:
  - a **container's** banner shows its **Area**;
  - an **area's** banner shows its **Property**.
  - (If that level is absent, the banner is omitted and its width reclaimed.)
- **Body/labels** always render **black-on-white** (physical thermal reality) regardless of app theme. Codes use a monospace face (echoing tally's JetBrains-Mono-for-codes convention).
- QR encodes the existing `TLY-{TYPE}-{HEX}` deep link, generated at a resolution appropriate for 203 dpi (the existing `qrcode` buffer, upscaled).

## 3. The three presets

Dimensions given in inches, PDF points (72/in), and device px (203/in). One label = one PDF page at exactly these dimensions.

### Small — item tag · 2 × 1 in (144 × 72 pt · 406 × 203 px)
- **Default for:** items.
- **Layout:** QR on the left (square, ~label height minus padding); right column = **inverted title bar** (item name, truncates to fit) above the **TLY code** (mono).
- **No location banner** (item tags stay minimal).

### Medium — bin & location tag · 3 × 3 in (216 × 216 pt · 609 × 609 px)
- **Default for:** containers, areas.
- **Layout:** left **vertical location banner** (parent zone); main area = **inverted title bar** across the top (centered), **QR centered below it** (filling the middle), and a footer row with the **TLY code** (mono) + the entity type label.

### Large — contents manifest · 4 × 6 in (288 × 432 pt · 812 × 1218 px)
- **Input:** exactly **one container or area** (not items — see validation). Renders that entity's **direct contents** as a list. (Nested/subtree contents are out of scope this pass.)
- **Layout:** left **vertical location banner** (parent zone); main column top-to-bottom:
  1. **Header** — QR + **inverted title bar** (the container/area name) + the remaining breadcrumb (below the top level, which is in the banner) + TLY code; bottom-bordered.
  2. **Column header** — a mono "CONTENTS / QTY" row.
  3. **Item list** — one row per direct item: **item name** (left, truncates) + **quantity** (right, mono, tabular). Alternating faint row shading for scan-ability.
  4. **Footer** — total item count + "Page X of N".
- **Overflow / pagination:** if the list exceeds one 4×6 page, it **continues on additional 4×6 pages**, each repeating the header + column header, footer paging as "Page X of N". **Nothing is truncated.**

## 4. Server — rendering & API

### API
`POST /api/labels/_y_/generate` — body becomes:
```
{ entityType: 'item'|'container'|'area',
  entityIds: number[] (1..100),
  preset:    'small'|'medium'|'large'|'sheet' }   // default 'small' for items, 'medium' for container/area
```
- Returns a **PDF** (`application/pdf`, attachment) in every case. The `zpl` format and its response branch are removed.
- `small` / `medium`: one label-sized page **per entity id**.
- `large`: **only valid for `entityType` of `container` or `area`** — Joi rejects `large` with `item` (422). For each id, renders that entity's contents manifest (paginated).
- `sheet`: the existing Avery 30-up sheet PDF, unchanged.
- **Membership scoping is unchanged** — the route already threads `req.user.id` into `getEntityData` / the manifest query via `property_members` (the IDOR fix). The manifest's item query is likewise `USER_ID`-scoped to the caller's membership.

### Service (`labels.service.js`)
- Replace `generateZpl` with the preset renderers. Keep a single source of truth for preset geometry — a `PRESETS` map: `{ small, medium, large }` each defining `{ widthPt, heightPt, qrPt, fonts, bannerWidthPt, ... }`, referenced by both the renderer and (mirrored) the client.
- New/changed methods:
  - `getEntityData(type, ids, userId)` — already membership-scoped; extend the returned shape with the **parent-zone name** (Area for containers, Property for areas) and the **remaining breadcrumb** so the renderer has what it needs.
  - `getManifest(entityType, entityId, userId)` — resolves the entity (membership-scoped) + its **direct items** (name, quantity), for the Large preset. Returns null / 404 if not owned or not a container/area.
  - `renderLabelPdf(entities, preset)` — draws single-label pages (small/medium).
  - `renderManifestPdf(entity, items, preset)` — draws the paginated 4×6 manifest.
  - `generatePdf(entities, labelType)` — the existing Avery-sheet renderer, retained for `preset: 'sheet'`.
- `generateQrBuffer` retained (used by all renderers).

## 5. Client

- **Print dialog** (`label-print-dialog.tsx`): replace the PDF/ZPL toggle with a **preset selector** — Small / Medium / Large / Avery sheet — defaulting by entity type (item→Small, container/area→Medium). **Large is shown only for a single container or area** (hidden/disabled for items and for multi-select where it doesn't apply).
- **Preview** (`label-preview.tsx`): render a **to-scale preview** of the selected preset — the inverted title bar, QR, location banner, and (for Large) a few manifest rows — using the same geometry constants, so the user sees the label before printing. Uses the existing QR image endpoint (`/api/labels/_x_/qr/:code`).
- On generate: download the returned PDF (the current flow, minus the ZPL clipboard branch).
- Client validation/UX mirrors the server: don't offer `large` for items; a preset's field set matches §3.

## 6. Testing

- **Server (fakeDb + node:test):** preset geometry constants are internally consistent (dimensions/QR sizes); `large` + `item` is rejected (422); `large` + container/area renders a manifest; manifest pagination math (N items → correct page count, header repeated); the manifest item query is `USER_ID`-scoped (membership); `getEntityData` returns the parent-zone name + remaining breadcrumb; ZPL path is gone (no `format:'zpl'` acceptance). PDF output is a non-empty `application/pdf` buffer with the expected page count.
- **Client:** `tsc` / eslint / build; a manual **print-and-measure** check on real 2×1 / 3×3 / 4×6 stock once a printer path exists (Phase 2), and a visual check of the preview against the approved mockup.

## 7. Non-goals (this phase)
- Auto-printing to the Pi (Phase 2 — pull-based print-job queue + Pi agent).
- Nested/subtree contents on the Large manifest (direct items only for now).
- A free-form label designer (fixed presets only — YAGNI).
- Per-item QR on the manifest rows (the row is name + qty; the header QR covers the container).
- Re-introducing ZPL / other printer command languages.

## 8. Phase 2 preview (separate spec)
Pull-based auto-print: a `print_jobs` queue (property-scoped, holds the rendered label / its params + status), an **agent token** so a lightweight **Raspberry Pi agent** can poll tally for pending jobs, download the rendered PDF, and print via CUPS (`lp`) to the ITPP941, then ack. Outbound-only from the Pi — no inbound firewall changes. Phase 1's `renderLabelPdf` / `renderManifestPdf` output is the artifact the agent prints.

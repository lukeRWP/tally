# Tally — Consolidated Improvement Roadmap

> Synthesis of three reviews run 2026-06-12/13: a code review (security / correctness / data / architecture / testing / deploy-contract), a UX review, and a GUI/visual review. ~56 raw findings, deduplicated and sequenced here. Findings marked **✓verified** were spot-checked directly against the source; deploy-contract claims were checked against the Prevailing Winds `composeGenerator`.

## TL;DR

Tally is a well-built app with a strong spine and a soft middle. The security fundamentals are genuinely good (OIDC/PKCE done right, parameterized SQL, prod-hard `BYPASS_AUTH` guard, DB-backed sessions), the module architecture is uniform, the scan-to-add flow is well-designed, and the visual language (oklch token system, semantic palette, 3-way theme) is intentional. What undermines it is concentrated and mostly cheap to fix: **no database transactions, a few reachable write-path bugs, UI that lies about actions it doesn't perform, failed fetches that masquerade as empty data, a keyboard-/zoom-hostile a11y baseline, and a couple of deploy-contract gaps.** Almost every high-impact fix is small.

The work below is sequenced into phases. **Phase 0 is a single half-day PR** of unambiguous quick wins that each land on multiple axes at once.

---

## Corrections carried forward (read before acting)

The automated code review's single "critical" was a false alarm; verifying it changed the top of the list:

- **`TALLY_DB` is NOT missing in prod.** PW's `composeGenerator` emits per-database env vars as `<DBNAME>_DB`, and Tally's database is named `TALLY`, so it auto-produces `TALLY_DB=TALLY` — exactly what `config.js`/`db.js` read. **Do not rename `MAIN_DATABASE`** in pw.json; that line is the redundant, unread one. (✓verified against composeGenerator.js + config.js.)
- **The `./init-db.sql` mount in pw.json is fine.** PW generates that file at deploy time and appends the repo's `SQL/init/*.sql` to it; the "schema never created" alarm was wrong.
- **The real deploy gap is `S3_BUCKET`** (below) — provided by neither the generator nor pw.json, and `config.js` has no default.

---

## Phase 0 — Quick wins (one PR, ~half a day)

Each is trivial/small and high-leverage. Several fix UX + a11y + visual simultaneously.

| Fix | File | Lands on |
|-----|------|----------|
| Add `S3_BUCKET=tally-files` to pw.json prod `environment` | `pw.json` | **deploy (prevents file-storage outage)** |
| Fix area-delete route typo `/properties/` → `/property/` ✓verified | `area-detail.tsx:37` | UX (no more bounce to Home) |
| Add `focus-visible:ring-2 ring-[var(--color-primary)] ring-offset-2` to Button base + global `:focus-visible` fallback | `button.tsx:7`, `globals.css` | **UX + GUI + a11y (app-wide)** |
| Remove `maximum-scale=1.0, user-scalable=no` (the 16px-input rule already stops iOS focus-zoom) | `index.html:5` | UX + a11y (WCAG 1.4.4) |
| Mount the themed `Toaster` instead of raw sonner; move to top-center ✓verified | `main.tsx:5,15` | UX + GUI (dark-mode toasts, clears nav) |
| Remove the `navigate(-1)` from the Delete stub (and ideally the stubs themselves) ✓verified | `item-detail.tsx:292` | UX (stop pretending it deleted) |
| Add `hasTagSelect:true` to the `tags` report ✓verified | `reports.tsx:79` | UX (Tag Report is currently broken) |
| Update `theme-color` meta inside `applyTheme()` to the resolved light/dark bg | `auth-store.ts:48` | GUI (status-bar mismatch) |
| Add a `prefers-reduced-motion: reduce` block zeroing the keyframes | `globals.css:97-134` | GUI + a11y |
| Darken muted-text token (light ~`oklch(0.50)`, dark ~`oklch(0.62)`) to clear AA | `globals.css:19,40` | GUI + a11y (it carries prices/counts/QR) |
| MySQL TLS: throw at startup if SSL requested but CA missing, instead of `rejectUnauthorized:false` | `db.js:38-43` | security |
| CSV export: prefix cells starting with `= + - @ tab` with `'` | `reports.service.js:753` | security |
| FAB `pulse-ring`: one onboarding burst, not infinite loop | `bottom-nav.tsx:56` | GUI |
| Bottom-nav: keep Inventory lit during `/property|/area|/container|/item` drill-down (`startsWith`) | `bottom-nav.tsx:45` | UX |

---

## Phase 1 — Data integrity & deploy correctness

The "silently corrupts or breaks on a fresh deploy" tier.

1. **`withTransaction` helper, threaded through every multi-statement write.** `getConnection()` is exported but called by nobody; `beginTransaction` appears zero times. Closure moves, cascade deletes, `create`+membership, and `permanentDelete`'s 7 sequential deletes can all partially commit. Do MinIO object removal *after* commit. *(high, large — single highest-leverage reliability fix.)*
2. **`S3_BUCKET` in the deploy contract** (also in Phase 0; it's the deploy headliner). Without it `config.storage.bucket` is `undefined` → upload/presign/ensureBucket all target an undefined bucket. *(high, trivial.)*
3. **Connect as `tally_api`, not `root`.** pw.json sets `MYSQL_USER=root`; the init SQL creates a least-privilege `tally_api` (with a hardcoded dev password) that the app never uses. Set `MYSQL_USER=tally_api`, source its password from the `MYSQL_PASSWORD` secret. *(med, small.)*
4. **Migration runner.** `SQL/migrations/` is empty, no `schema_migrations` table, no tooling — schema can't evolve after the one-time init. Add the table + numbered migrations and wire PW's `db-migrate-all-v2`. Ship the missing indexes (below) as the first migration. *(med, medium.)*
5. **Closure rows on soft-delete.** Soft-deleting a container/area `DELETE`s its `container_paths` with no rebuild on restore; `PropertiesService.restore` doesn't cascade. Prefer keeping rows and filtering reads by `DELETED_AT`. Currently masked because `restore` has no route — fix before wiring the recycle bin. *(med, medium.)*
6. **Orphaned thumbnails.** The thumbnail key is uploaded but never persisted (`files.service.js:71`), so it leaks in MinIO forever on every image delete. Persist a `THUMBNAIL_KEY` and delete both. *(med, small.)*
7. **Missing indexes:** `entity_tags(ENTITY_TYPE,ENTITY_ID)`, `items(CONTAINER_ID,STATUS,DELETED_AT)`, `items(DELETED_AT)`; rewrite `_buildContainerTree` (N+1) to set-based queries. *(low, small — bundle with #4.)*

---

## Phase 2 — Security hardening

1. **Container-move route: cross-property IDOR + no cycle guard.** ✓The route authorizes from the source only and never checks the destination property (the item-move route already does, `items.routes.js:182`); `moveNode` has no descendant check, so moving a container under its own child corrupts the closure table. Mirror the item-move destination check + reject `newParent ∈ descendants(id)`. *(high, small.)*
2. **SSRF in the product URL extractor.** The private-IP guard is `resolve4`-only (no IPv6/decimal forms) and `axios` then follows up to 5 redirects without re-validating. Resolve A+AAAA, block reserved CIDRs, set `maxRedirects:0` + re-validate each hop, pin to the validated IP — or just allowlist retailer domains. *(high; realistic risk medium given trusted-user threat model.)*
3. **Uploaded files: trust real bytes, not the client.** Stored with client-declared MIME and served inline; public share links hand these presigned URLs out. Magic-byte sniff, store a server-derived `ContentType`, force `Content-Disposition: attachment`. *(med, small.)*
4. **OAuth login-CSRF.** PKCE `state` is stored server-side only, never bound to the browser. Set a short-lived httpOnly `oauth_state` cookie and require it to match in the callback. *(low, small.)*

---

## Phase 3 — UI honesty & safety

The "stop lying, guard the irreversible, distinguish error from empty" tier — the highest-felt UX wins.

1. **Real Delete / Move / Edit on item-detail.** ✓All three are `toast('… coming soon')` stubs; Delete even `navigate(-1)`s away as if it worked. Wire real soft-delete behind a confirm; implement in-page Move (reuse the scan cascade) or deep-link to it; same for Edit. *(high, medium.)*
2. **Error states + retry + ErrorBoundary.** ✓No `isError` anywhere, no boundary — a 500/offline is indistinguishable from empty data. Render an error+Retry block before the empty/not-found fallback in each consumer; add a top-level `ErrorBoundary`; fix the broken 401-retry predicate (`query-client.ts:7`). *(high, medium.)*
3. **Confirm every destructive action.** ✓Purge Expired (permanent!) fires with no dialog; share-revoke and restore have none; property/area/file use native `confirm()`. Standardize on the themed Dialog. *(high → purge is the urgent one.)*
4. **Lending double-action guard (server + client, unified).** Server `lend()` has no double-lend check and `return()` lacks `AND RETURNED_AT IS NULL`; client shows the Lend button on already-lent items. Add the server guards (+ a unique index on `(ITEM_ID) WHERE RETURNED_AT IS NULL`) and hide/disable Lend client-side. *(med, small.)*
5. **EntityForm feedback + no data loss.** ✓Registers `{required}` but never reads `formState.errors`; `reset()`+close run before the mutation resolves. Render inline errors; `await mutateAsync`; close only on success. *(high, small.)*
6. **Scanner resilience.** No manual barcode entry, no torch, no permission priming; denial is a dead end. Add a "type the barcode" field on the idle + error screens. *(high, medium.)*
7. **Scan/search: error ≠ not-found.** A thrown lookup error and a real "no such barcode" both render `not_found`; Home search ignores `isFetching`. *(med, small.)*

---

## Phase 4 — Navigation, mobile & accessibility

1. **Keyboard-accessible navigation cards.** ✓All four entity cards are `onClick` on a bare `<div>` — the entire hierarchy is unreachable by keyboard / unannounced to screen readers (`notification-list.tsx` already shows the right pattern). Wrap in react-router `<Link>`. *(high, medium.)*
2. **Surface orphaned destinations.** Recycle Bin + Notifications aren't in primary nav; the notification bell is mobile-only (`lg:hidden`), so desktop users can't reach notifications at all. *(med, small.)*
3. **Global search beyond items + Home.** Search is items-only and lives only on Home; no way to jump to a container/area. Broaden scope (or relabel) and surface it persistently. *(med, medium.)*
4. **PWA.** No manifest, icons, service worker, or offline — for a one-handed-in-the-garage inventory app this is a real gap. *(med, medium.)*
5. **Camera keep-alive for batch entry** (don't tear down on each save); **real 404 page** (the catch-all silently teleports to Home); **breadcrumb contract** (typed `propertyName/areaName` instead of silent degradation); **hand-rolled menus → Radix DropdownMenu** (also Phase 5 — gives Escape/scroll-close/roles/focus for free). *(med, mixed.)*

---

## Phase 5 — Design system & visual polish

1. **Register color tokens in `@theme`.** They live as raw CSS vars in `:root`/`.dark`, so no `bg-card`/`text-primary` utilities exist and color is applied via **700+ arbitrary values** (`bg-[var(--color-card)]`) — the root cause of most drift, and typos fail silently. Move to `@theme --color-*`, then convert. *(med, large — foundational.)*
2. **Badge text contrast** on 8% same-hue tints (condition/status labels) fails AA — darken the text independent of hue. *(med, small.)*
3. **`fade-up` opt-in, not baked into every Card** — it replays on every navigation and reads as flicker. Gate to first paint, cap stagger. *(med, medium.)*
4. **DropdownMenu primitive** (replaces the two hand-rolled menus; a11y + dedup). **TagBadge → Badge primitive** (square hex-alpha pills next to rounded token pills). **Single radius spelling.** **Dark-mode elevation tokens** (4% black shadows are invisible on the dark canvas). **`border-…/50` on a `var()`** likely drops the alpha modifier. *(low, mixed.)*
5. **Optimistic mutations** for tag/notification toggles (currently pessimistic → laggy on mobile); **branded cold-load splash** instead of bare "Loading…". *(low/med, small.)*

---

## Phase 6 — Foundations

1. **A test gate.** ✓Zero tests; server CI is only ESLint + `node --check` (parse-only) while master auto-deploys to prod. Add `"test":"node --test"` + a CI step, make it a required check. Write ~8 high-value unit tests against the DI'd services: closure-table cycle prevention, session create/validate (token stored hashed, expiry), `requireRole`, `_calcDepreciatedValue`, `sanitizeOrderBy`. *(high, medium.)*
2. **Standardize the validation contract.** Three patterns coexist (400 vs 422, different body shapes); the unused `validate.js` middleware already implements the intended one. Adopt it everywhere — fixes the client contract *and* removes ~30 inline blocks *and* enables the EntityForm inline-error work (Phase 3 #5). *(med, medium.)*
3. **`BaseRepository` decision.** Fully built, 100% dead code, while 18 services hardcode `TALLY.` ~350× with 21 duplicate row mappers. Either adopt it for the CRUD-shaped modules or delete it so it stops misleading. *(low, large.)*

---

## Cross-cutting items (fixed once, counted in multiple reviews)

- **Focus ring** — code + UX + GUI + a11y. *(Phase 0.)*
- **Themed Toaster** — UX + GUI. *(Phase 0.)*
- **Pinch-zoom block** — UX + a11y + GUI. *(Phase 0.)*
- **Double-lend** — server bug + client UX. *(Phase 3 #4.)*
- **Validation** — server contract + client feedback. *(Phase 6 #2 + Phase 3 #5.)*
- **Hand-rolled menus** — UX (no Escape/a11y) + GUI (style drift). *(Phase 4/5.)*
- **`@theme` color registration** — GUI consistency + the server-side `BaseRepository`/`TALLY.`-prefix repetition are the same "verbose, un-abstracted" theme on each side. *(Phase 5 #1 + Phase 6 #3.)*

---

*Reviews + this synthesis: Claude (Fable 5 / Opus 4.8), 2026-06-12/13. The PW-platform docs refresh from earlier in the session (branch `docs/dev-docs-refresh-2026-06-10`, issues #260–#265) is a separate, still-open thread.*

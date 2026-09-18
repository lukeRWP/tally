# PW IAM step 4 (tally) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tally signs in through pwiam instead of its own Entra registration — the second app of rollout step 4 (spec §11), on the template docket set (docket #45, `docs/superpowers/plans/2026-09-17-pw-iam-step4-docket.md` there); daybook follows.

**Architecture:** Replace tally's hand-rolled Entra OIDC flow (`auth.service.js` + `auth.middleware.js`'s `requireAuth`) with `@pw/auth-express` v0.1.0 (plan 2c). The shim owns login, callback, session cookie, silent refresh, logout (RP-initiated end-session) and back-channel logout; tally keeps exactly one hook, `resolveUser(claims)`, which maps a pwiam subject onto `TALLY.users`. `req.user` keeps its shape; `resolvePropertyRole` / `requireRole` and everything above the auth module are untouched. `pw.json` gains the `iam` block; on deploy the orchestrator reconciles the `tally-prod` client and renders `PW_IAM_ISSUER` / `PW_IAM_CLIENT_ID` / `PW_IAM_CLIENT_SECRET` into `.env`.

**Tech Stack:** Express 5 (CommonJS), `@pw/auth-express` (git tag `github:lukeRWP/pw-auth-express#v0.1.0`), MySQL 8.4, `node --test`; React 19 + TypeScript, zustand, Vitest.

**Spec:** `prevailing-winds/docs/superpowers/specs/2026-09-08-pw-iam-design.md` §5 (roles), §6 (logout), §7 (the shim, app changes, one additive migration), §11 step 4. Shim contract: `pw-auth-express/README.md`. Onboarding: `prevailing-winds/docs/APP-ONBOARDING.md` §3a, `docs/IAM-RUNBOOK.md`.

**Decisions taken here (where the spec leaves room):**
- **Roles declared to pwiam are `admin` and `member`** (spec §5: "tally `admin` may manage any property's members, `member` is today's behaviour"). A pwiam assignment is the sign-in gate; `TALLY.property_members` stays the authority on every request and this step changes nothing there. The token's roles ride on `req.auth.roles`; the cross-property `admin` power is a follow-up (GH issue), not this PR.
- **The Pi print agent keeps its `tp_` bearer token.** The spec's "Pi agent becomes a service account" (`requireApiKey('print-agent')`) needs the agent-side change too and is a follow-up (GH issue), so this PR stays independently revertible.
- **`LAST_LOGIN_AT` = pwiam's `auth_time`.** `resolveUser` runs at login *and* on every silent refresh (≤ 15 min), so stamping `NOW()` there would turn the column into "last seen". Writing `auth_time` only when it is newer than the stored value keeps it meaning "last authenticated".
- **Route paths are the shim's** (`/api/auth/login`, `/callback`, `/session`, `/logout`, `/backchannel-logout`), not tally's `_x_`/`_y_` convention — they are the package's contract and must match the redirect URI pwiam registers. Their bodies are not tally's `{ success, data }` envelope either, so the client's auth store reads them with a raw `fetch`, not `api.get`.
- **The client callback page goes away.** The redirect URI is now a server route (`/api/auth/callback`, proxied by the container nginx like every `/api/` path), so `client/src/pages/oauth-callback.tsx` and `ENTRA_REDIRECT_URI` have no job left.
- **CSRF keys on the session cookie's presence, not cookie-parser's signature.** The shim signs `session_token` with its own HMAC (`value.sig`), which cookie-parser does not recognise as a signed cookie — so `req.signedCookies.session_token` would always be empty and the double-submit check would silently never run. `csrf.js` reads `req.cookies.session_token` instead.

## Global Constraints

- `BYPASS_AUTH=true` keeps working with **no pwiam anywhere** (spec §7): the shim is constructed with placeholder client credentials under bypass, its `/login` answers 503, and `requireAuth` serves the fixed dev principal through `resolveUser`. Production still refuses `BYPASS_AUTH` (`config.js`).
- **Never list `PW_IAM_*` in `pw.json` `secrets`/`external_secrets`** — reconcile writes them to Vault and the generator renders them (APP-ONBOARDING §3a).
- Migration 015 is additive and idempotent (`information_schema` guards, the 001/002 pattern); `SQL/expected-schema.sql` is regenerated alongside it and the migration gate proves both.
- **Migrations are not part of deploy**: after merge, `migrate-all` must run before the deploy can pass the schema gate (CLAUDE.md deployment rules; PW #969).
- Whatever `resolveUser` returns is sealed into the session row and served verbatim by `GET /api/auth/session` — return the projection `_mapUser` already produces, never a raw row.
- Never weaken a test assertion or a security guard to make a test pass.
- `npm`: always `--no-audit`.

---

## File Map

| Path | Responsibility |
|---|---|
| `SQL/migrations/015_pwiam_identity.sql` | `users.SUB` (+ unique), `users.ENTRA_ID` nullable, `sessions.SUB/SID/IAM_STATE` (+ indexes) |
| `SQL/expected-schema.sql` | regenerated |
| `server/package.json` | `@pw/auth-express` dependency |
| `server/src/config.js` | `auth.iam { issuer, clientId, clientSecret }` from `PW_IAM_*`; Entra block removed |
| `server/src/modules/auth/auth.service.js` | `resolveUser(claims, { tokens })`, `_mapUser`; no sessions, no OAuth |
| `server/src/modules/auth/auth.routes.js` | builds `pwAuth(...)`, mounts `auth.routes()`, exports `app.locals.requireAuth/requireMember/requireRole`, hourly session sweep |
| `server/src/modules/auth/auth.middleware.js` | `requireMember`, `requireRole` only |
| `server/src/modules/auth/auth.schema.js` | deleted (the Joi callback schema has no caller) |
| `server/src/middleware/csrf.js` | presence check on `req.cookies.session_token`; `/api/auth/backchannel-logout` exempt |
| `server/index.js` | auth limiter skips back-channel logout |
| `pw.json` | `iam` block, `environments.prod.publicHost`, Entra external secrets and `ENTRA_REDIRECT_URI` removed |
| `.env.template`, `CLAUDE.md` | `PW_IAM_*`, the new auth section |
| `client/src/store/auth-store.ts` | raw-fetch `session`/`logout`; logout follows the issuer's end-session redirect |
| `client/src/pages/login.tsx` | one "Sign in" button → `/api/auth/login` |
| `client/src/pages/oauth-callback.tsx`, `App.tsx` | page and route removed |
| `client/src/pages/settings.tsx` | unchanged — passes `logout` to the button, and `logout()` now navigates itself |
| `server/test/auth.*.test.js`, `config.test.js` | rewritten for the shim |

---

### Task 1: Migration 015 — pwiam identity columns

- [ ] `SQL/migrations/015_pwiam_identity.sql`: `users.SUB VARCHAR(26) NULL` + `UNIQUE uq_users_sub`; `users.ENTRA_ID` → `NULL` (a pwiam-only user has none); `sessions.SUB VARCHAR(64) NULL`, `SID VARCHAR(64) NULL`, `IAM_STATE TEXT NULL`, `KEY idx_sessions_sid`, `KEY idx_sessions_sub`. Every statement guarded by `information_schema` so pass 2 of the gate is a no-op.
- [ ] Regenerate `SQL/expected-schema.sql` (`SQL/ci/migration-gate.sh --write`, or by hand to mysqldump's exact output when docker is unavailable — CI's gate is the proof either way).

### Task 2: `resolveUser` — the one app hook

- [ ] `auth.service.js`: `init({ db, config, logger })`, `resolveUser(claims, { tokens })`:
  1. `SELECT * FROM TALLY.users WHERE SUB = ?`;
  2. miss and `claims.entra_oid` → match `ENTRA_ID`, backfill `SUB` (one-time; under bypass the legacy dev row `ENTRA_ID='dev-user'` is matched the same way so an existing local DB keeps its dev user);
  3. miss → `INSERT` (`SUB`, `ENTRA_ID` = `entra_oid` or NULL, `EMAIL` = `claims.email || ''`, `DISPLAY_NAME` = `claims.name || claims.preferred_username || claims.sub`);
  4. stamp `LAST_LOGIN_AT` from `claims.auth_time` when newer;
  5. return `_mapUser(row)`.
- [ ] Tests (`auth.resolve-user.test.js`, fake `db.query` recorder): SUB hit; entra_oid backfill writes `SUB`; insert path (display-name and empty-email fallbacks); the dev row only under bypass; `LAST_LOGIN_AT` predicate carries `auth_time`; the unique race.

### Task 3: Wire the shim

- [ ] `config.js`: `auth.iam` from `PW_IAM_ISSUER` (default the prod issuer), `PW_IAM_CLIENT_ID`, `PW_IAM_CLIENT_SECRET`; production throws when the id/secret are missing (bypass is already blocked there); dev warns unless bypass.
- [ ] `auth.routes.js`: `pwAuth({ issuer, clientId, clientSecret, baseUrl: config.clientUrl, secret: config.auth.cookieSecret, session: pwAuth.mysqlSession(db, { table: 'TALLY.sessions' }), resolveUser, bypassAuth, cookie: { secure: config.isProduction }, logger })`; `app.use(auth.routes())`; `app.locals.requireAuth = auth.requireAuth`; hourly `sweepExpiredSessions()` (unref'd, as before).
- [ ] `auth.middleware.js` drops `requireAuth`; `auth.schema.js` and `auth.oauth-state.test.js` deleted (the state table is unused; dropped in step 7).
- [ ] `csrf.js`: presence via `req.cookies`; exempt `/api/auth/backchannel-logout`.
- [ ] `index.js`: `authLimiter` `skip`s `/api/auth/backchannel-logout` (a dropped issuer POST is a session that outlives its revocation).
- [ ] Tests: `auth.routes.test.js` boots the real wiring under bypass with `memorySession` and proves `GET /api/auth/session` serves the dev principal through `resolveUser`, `/login` is 503, a `requireAuth`-guarded route gets `req.user` + `req.auth.roles`; `csrf` test for the presence check.

### Task 4: Client

- [ ] `auth-store.ts`: `checkSession` → `fetch('/api/auth/session')` (`{ user }`, 401 = signed out); `logout` → `POST /api/auth/logout` with `X-CSRF-Token`, then `window.location.assign(redirect)` (pwiam's end-session page; falls back to `/login`).
- [ ] `login.tsx`: one button → `/api/auth/login`; copy stops naming Microsoft (pwiam's page offers the methods).
- [ ] Remove `oauth-callback.tsx` and its route; `settings.tsx` already passes `logout` straight to the button.
- [ ] Vitest: auth-store logout follows the redirect; `tsc --noEmit`, eslint `--max-warnings 0`, `vite build` clean.

### Task 5: Contract + docs

- [ ] `pw.json`: `"iam": { "roles": ["admin","member"], "redirectUris": ["/api/auth/callback"] }`, `environments.prod.publicHost`, drop `ENTRA_*` from `external_secrets` and `ENTRA_REDIRECT_URI` from the app environment. Run it through PW's real `ServiceCatalog.validatePwJson` + `iamDeclarations.buildDeclaration`.
- [ ] `.env.template`: the `PW_IAM_*` block; `CLAUDE.md`: Auth row, routes table, migrations table, the Authentication section; `docs/entra-id-setup.md` marked superseded.

### Task 6: Ship

- [ ] `cd server && npm run lint && npm test`; `cd client && tsc && eslint && npm test && npm run build`.
- [ ] PR. After merge, in order: `migrate-all` (015) → deploy (reconcile creates `tally-prod`, writes `PW_IAM_*`) → assign `member` (or `admin`) on `tally/prod` to each household member in the PW dashboard → prove sign-in in Chromium/Firefox (IAM-RUNBOOK: `form-action`, not only a phone).

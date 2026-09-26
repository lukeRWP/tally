# Property invites through PW IAM — plan (2026-09-26)

**Goal:** a tally property owner invites a brand-new person to a property (space). The invitee gets a
link, creates their own PW IAM (pwiam) account, and on their first tally sign-in lands as a member of
that property with the role the owner chose.

**Decision (Luke, 2026-09-26):** property owners may invite directly. Tally gets a narrow pwiam
endpoint that mints an enrolment ticket granting ONLY `tally/prod user` (never `admin`), capped per day,
audited, announced on ntfy at mint and at redemption, and revocable.

Existing tally users are still added by email (unchanged `POST .../members`).

## Why this shape

- pwiam refuses sign-in without a `tally/prod` role (`oidc/policy.js` `no_assignment`), so a tally-only
  pending invite cannot work: the grant must come from pwiam.
- The invite is keyed by the invitee's **pwiam `sub`**, never by email. pwiam pre-allocates the new
  user's ULID when the ticket is minted; tally stores it on the pending invite; `resolveUser` claims it
  when that `sub` signs in. A self-asserted email could capture someone else's invite (the 09-26
  registration-review trap); a `sub` cannot be chosen.
- pwiam's `/enrol` fixes the handle at invite time (TOTP label, passkey user), so the invitee first picks
  a handle on a `/join/<token>` page (the `/register` form, reused), which then mints the ordinary
  30-minute invite link and redirects into the unchanged `/enrol` flow.

## Contract

### pwiam

`RP_INVITES` env: comma list of `app:role`, e.g. `tally:user`. Parsed in `config.js`; boot FAILS if any
entry's role is `admin` or the entry is malformed. Unset/empty = feature off (routes answer 404).
`RP_INVITE_DAILY_CAP` (default 20, non-negative integer, per app, rolling 24h; garbled = boot failure).

`POST /rp/invites` — Basic auth with the app's WEB client credentials (same rule as
`/apikeys/introspect`: `apps.verifyClientSecret` + `kind === 'web'`; any failure = 401
`invalid_client`). The client's `appId` must be in `RP_INVITES`, else 403 `not_enabled`.
Body JSON `{ displayName, invitedBy: { sub, name } }`; displayName 1-120 chars, no Cc/Cf chars
(`CONTROL_OR_FORMAT_RE`), whitespace collapsed; invitedBy.sub ≤ 64, invitedBy.name ≤ 120 same char rule.
Under `db.withLock('pwiam_rp_invite', …)`: count `RP_INVITES` rows for this APP_ID created in the last
24h; at cap → 429 `cap_reached` (+ one ntfy per window, same pattern as register's
`alertCapReachedOnce`). Otherwise insert a row (7-day TTL, pre-allocated `USER_ID = ulid()`, random
32-byte base64url token stored as sha256) + audit `rp_invite.create` (actor `rp:<clientId>`) in ONE
transaction, then ntfy "PW IAM: app invite" (fixed facts first, user-supplied values JSON-quoted last).
201 `{ id, userId, url: "<issuer>/join/<token>", expiresAt }`. Role and env come from config + the
client — never from the body.

`POST /rp/invites/:id/revoke` — same auth; row must match the client's APP_ID and ENV, else 404.
Sets REVOKED_AT, deletes any unconsumed LINKS row for that USER_ID, audits `rp_invite.revoke`.
200 `{ revoked: true }`; already redeemed (USERS row exists) → 409 `redeemed`.

`GET /join/:token` — HTML. Usable = exists, not revoked, not expired, and no USERS row with ID = USER_ID
yet. Unusable → `linkExpiredPage()` 410. Usable → a join page: "<inviter name> invited you to
<app display name>" + the register form (display name prefilled, handle) posting to `/join/:token`.
`Cache-Control: no-store`.

`POST /join/:token` — same cross-site guard, validation, reserved-handle rule and generic "unavailable"
copy as `POST /register` (export/share the helpers rather than copying). Deletes any earlier unconsumed
LINKS row for the invite's USER_ID, then `links.createInvite({ handle, displayName, assignments:
[{ appId, env, role }] }, { actor: 'rp-invite:<id>', ttlMs: 30 min, userId: <invite USER_ID> })`
(`createInvite` gains an optional `userId`), stores the link id on the row, 303 → `/enrol/<token>`.
Does NOT count against the self-registration cap (the ticket already counted).

`enrol.routes.js complete()`: also notify ntfy ("PW IAM: invited account") when `link.createdBy`
starts with `rp-invite:`. Nothing else in `/enrol` changes.

Rate limits: `/rp/*` keyed like introspection (`introspectionKey`), 60/min; `/join` 30/min by IP.
Sweep job: delete RP_INVITES rows expired or revoked more than 7 days ago.
Migration `006_rp_invites.sql` (idempotent): `RP_INVITES(ID CHAR(26) PK, TOKEN_HASH CHAR(64) UQ,
APP_ID VARCHAR(40), ENV VARCHAR(20), ROLE VARCHAR(20), USER_ID CHAR(26), DISPLAY_NAME VARCHAR(120),
INVITED_BY_SUB VARCHAR(64), INVITED_BY_NAME VARCHAR(120), CLIENT_ID VARCHAR(80), LINK_ID CHAR(26) NULL,
EXPIRES_AT DATETIME(3), REVOKED_AT DATETIME(3) NULL, CREATED_AT DATETIME(3))`, keys on USER_ID and
(APP_ID, CREATED_AT). Match APPS/CLIENTS column widths actually in `SQL/expected-schema.sql`.
pw.json prod env: `RP_INVITES=tally:user`, `RP_INVITE_DAILY_CAP=20`.

### tally

Migration `017_property_invites.sql` (idempotent, rules 8-10): `property_invites(ID INT AI PK,
PROPERTY_ID INT FK properties, ROLE ENUM('editor','viewer'), DISPLAY_NAME VARCHAR(120),
INVITEE_SUB VARCHAR(26) NOT NULL, PWIAM_INVITE_ID VARCHAR(26) NOT NULL UNIQUE, INVITED_BY INT FK users,
EXPIRES_AT DATETIME, ACCEPTED_AT DATETIME NULL, ACCEPTED_USER_ID INT NULL FK users,
REVOKED_AT DATETIME NULL, CREATED_AT DATETIME DEFAULT CURRENT_TIMESTAMP)`, index on INVITEE_SUB.

pwiam client (`server/src/modules/auth/pwiam-invites.client.js`): `createInvite({displayName, invitedBy})`
and `revokeInvite(id)` over `fetch` with Basic `PW_IAM_CLIENT_ID:PW_IAM_CLIENT_SECRET` to
`${PW_IAM_ISSUER}/rp/invites…`, 10s timeout. Maps 429 → 429 "Invite limit reached for today",
403 → 503 "Invites are not enabled", network/5xx → 502; logs at error level (prod logs errors only)
without secrets or the returned URL.

Routes (owner-gated like members, `properties.routes.js`):
`GET  /api/properties/_x_/:propertyId/invites` → pending (not accepted, not revoked, not expired).
`POST /api/properties/_y_/:propertyId/invites` `{ displayName, role: 'editor'|'viewer' }` → pwiam mint,
then insert row + audit; 201 `{ invite, url }` (url returned ONCE, never stored).
`DELETE /api/properties/_d_/:propertyId/invites/:inviteId` → pwiam revoke (404 from pwiam is fine;
409 `redeemed` still marks tally-side revoked), set REVOKED_AT, audit.

`resolveUser`: after any successful branch, claim invites `WHERE INVITEE_SUB = sub AND ACCEPTED_AT IS NULL
AND REVOKED_AT IS NULL` in one transaction (`FOR UPDATE`): insert `property_members` (existing membership
= keep the existing row, never downgrade), stamp ACCEPTED_AT/ACCEPTED_USER_ID, audit. Tally-side
EXPIRES_AT does not gate claiming (the sub only exists if pwiam's window was honoured). A claim failure is
logged at error level and never blocks sign-in.

Client: `PropertyMembers` gains "Invite someone new" (name + editor/viewer) → result dialog with the
link, Copy, and `navigator.share` when available; share text names the property and expiry. Pending
invites list with Revoke. Hooks `usePropertyInvites`/`useCreateInvite`/`useRevokeInvite` in
`use-members.ts`, `queryKeys.properties.invites`, type `PropertyInvite`.

## Tasks and order (migrations first — tally-migration-ordering rule)

1. pwiam PR 1: migration 006 + expected-schema. Merge, `migrate-all` PWIAM.
2. pwiam PR 2: config, rp-invite service + routes, join page, notify, sweep, tests, CLAUDE.md, pw.json.
   Merge → auto-deploy → `/health/ready` ok.
3. tally PR 1: migration 017 + expected-schema. Merge, `migrate-all` TALLY.
4. tally PR 2: pwiam client, service, routes, resolveUser claim, client UI, tests, CLAUDE.md.
   Merge → deploy → deploy-verifier proof → ui-verifier.
5. Live proof: owner creates an invite on a test property, `/join` renders, revoke works (no real account
   needs to be created to prove the mint/revoke path; a full redemption is Luke's first real invite).

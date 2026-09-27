# Property invites — existing pwiam accounts (2026-09-27)

Follow-up to `2026-09-26-property-invites.md` (same trust model, approved by Luke 2026-09-26:
a property owner's invite may grant `tally/prod user`, never more).

**Gap:** an invitee who already has a pwiam account (self-registered, or uses docket/daybook) can only
accept by creating a SECOND account on `/join`. Goal: "Already have an account? Sign in instead" on
`/join`, which attaches the invite to the account they prove they own.

## Why this shape

- Without a tally role, pwiam's `no_assignment` gate stops the person before tally ever sees them, so
  **pwiam must redeem the ticket during its own sign-in interaction**, after authentication.
- An existing account has its own `sub`, not the ticket's pre-allocated `USER_ID`, so tally cannot
  match by `INVITEE_SUB`. pwiam records `REDEEMED_USER_ID`; tally asks pwiam which of its invites a
  `sub` redeemed.
- Someone already signed in to pwiam (SSO) with a tally role passes straight through `/auth` with no
  interaction. A new policy check forces the interaction whenever a valid join claim is present, so
  every path — password, passkey, Microsoft, existing session — meets ONE redemption point.

## pwiam

Migration `007_rp_invites_redeemed.sql` (additive, idempotent): `RP_INVITES.REDEEMED_USER_ID CHAR(26) NULL`,
`REDEEMED_AT DATETIME(3) NULL`, index on `REDEEMED_USER_ID`.

**Usable** ticket (join GET/POST, claim, redemption) now also requires `REDEEMED_AT IS NULL`.
`revoke` answers 409 `redeemed` when either the pre-allocated user exists OR `REDEEMED_AT` is set.
`enrol complete()` for an `rp-invite:` link refuses (`consumed`) when the ticket has `REDEEMED_AT` set
(checked under the existing `RP_INVITES … FOR UPDATE`).

`POST /join/:token/existing` — same cross-site guard as `/join`; ticket must be usable. Mints a
random claim nonce held server-side (in-memory Map, like `entraEnrolNonces`, TTL 30 min, swept) →
`{ inviteId }`, sets `__Host-pwiam_join` (httpOnly, secure, sameSite lax, path /, max-age 30 min),
303 → the app's login URL = origin of the calling client's first registered redirect URI +
`/api/auth/login` (every estate RP mounts `@pw/auth-express` at `/api/auth`; document it). The `/join`
page gains the "Already have an account? Sign in instead" form. The token never reaches the cookie,
a log line or the redirect.

Policy: a `login`-prompt Check `join_claim` — REQUEST_PROMPT when the request carries a
`__Host-pwiam_join` cookie whose nonce maps to a usable ticket for THIS client's app+env. Otherwise
NO_NEED_TO_PROMPT (an unrelated or stale cookie never blocks a login; a stale nonce clears itself).

One helper `redeemJoinClaim({ req, res, user, app, clientId })`, called on every completed-sign-in path
BEFORE the role check: password `finishLogin`, passkey, Microsoft (`entra.routes.js`), and the GET
`/interaction/:uid` path when `details.session.accountId` exists and the prompt reason is `join_claim`
(then finish the interaction with that session's account). It:
1. resolves the nonce → invite; no cookie / unknown nonce / different app+env → no-op;
2. one transaction: `SELECT … FROM RP_INVITES WHERE ID = :id FOR UPDATE`, re-check usable; if the user
   ALREADY holds any role on that app+env → assign nothing (never downgrade an admin), else
   `apps.assign(user, app, env, invite.role)`; set `REDEEMED_USER_ID/AT`; delete unconsumed LINKS for the
   ticket's `USER_ID`; audit `rp_invite.redeem_existing` (actor = the user, details: invite id, whether a
   role was granted);
3. after commit: ntfy "PW IAM: invite accepted by existing account" (fixed facts first, user-supplied
   values JSON-quoted last); clear the nonce and the cookie.
A break-glass account never redeems (skip + audit). A redemption failure must not turn a good sign-in
into a 500: log at error, clear the claim, carry on to the normal role check.

`POST /rp/invites/redeemed` — same web-client auth as `/rp/invites`; body `{ sub }` (≤ 64 chars) →
`{ invites: [{ id }] }` for the caller's app+env where `REDEEMED_USER_ID = sub`. Rate-limited like
`/rp/*`.

Tests: each sign-in path redeems (password, passkey if the harness allows, Microsoft if stubbed, existing
session with and without a role); role never downgraded; wrong app/env cookie ignored; revoked/expired/
already-redeemed ticket not redeemed; redeem vs revoke race (row lock) — exactly one wins; enrol
refused after existing-account redemption; `/rp/invites/redeemed` scoped to own app+env; cross-site
POST refused; no token in cookie/logs.

## tally

No migration. `pwiam-invites.client.js` gains `redeemedBy(sub)` → invite ids (same error mapping; a
failure is non-fatal to the caller).

`resolveUser`: after the existing `claimPending(sub, …)`, when this is a **fresh sign-in** (the insert
branch, or `auth_time` newer than the stored `LAST_LOGIN_AT` — the same comparison that already guards
that write; never on a silent refresh), call `redeemedBy(sub)` and `claimRedeemed(ids, userId)`: same
transaction semantics as `claimPending` (`FOR UPDATE`, pending rows only, never downgrade an existing
membership, audit), matching `PWIAM_INVITE_ID IN (…)` instead of `INVITEE_SUB`. Failure logged at
error and swallowed.

## Order

1. pwiam migration 007 → `migrate-all` from the branch → pwiam code PR → merge → `/health/ready`.
2. tally PR (no migration) → merge → deploy proof.

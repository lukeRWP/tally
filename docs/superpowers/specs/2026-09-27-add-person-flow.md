# Add person flow — Settings → Members (2026-09-27)

Luke: "improve the add users flow"; chose ONE "Add person" flow over two paths / invite-only.

## Problem (current `property-members.tsx`)
- Two unlabelled rows (email → add, name → invite) force the owner to know whether the person already
  has a Tally account; a wrong guess with an email dead-ends on "User not found".
- Icon-only submit buttons (UserPlus vs Send) don't say what they do; roles are unexplained.
- Pending invites render as a separate, differently-styled card list; a lost link can't be re-sent.
- Share text is generic (no inviter, no property).

## Design
**Members list** (one list, one style):
- Header row: section already titled "Members" by the page; add a right-aligned primary button
  **"Add person"** (UserPlus icon + label, full size, ≥44px on coarse pointer).
- Member rows unchanged in behaviour (role select, remove, last-owner lock, self-demote confirm).
- **Pending invites render as rows in the same list** after members: same avatar-initial square, name,
  a mono uppercase sub-line `INVITED · EXPIRES OCT 3` (muted), role shown as text (not a select), and two
  actions: **New link** and **Revoke** (text buttons; revoke confirms: "Revoke Jordan's invite? The link
  stops working.").

**Add person dialog** (existing Dialog primitives):
- Fields: **Name** (required, 1–120, autofocus), **Email** (optional; helper: "Optional — if they already
  use Tally, they're added straight away."), **Role** as a two-option radio group with one-line meaning:
  Editor — "Add, edit and move items"; Viewer — "Can look, can't change anything". Default Editor.
  Owner is still never offered here (promote from the row afterwards — existing rule).
- Submit **"Add person"**:
  1. Email present → `POST …/members {email, role}`.
     - 200 → close, toast "{name} added as {role}" (use the member's displayName from the response).
     - `ApiError.status === 404` (no Tally account) or `409` with the ambiguous-email message
       (more than one account) → fall through to 2. For 409 "Already a member" → inline error in the
       dialog, no fallthrough. Any other error → inline error.
  2. No email (or fallthrough) → `POST …/invites {displayName: name, role}` → dialog switches to the
     **Invite ready** step: "{Name} isn't on Tally yet — send them this link. It works once and expires
     {date}." + link box + **Copy link** + **Share** (when `navigator.share`). If we fell through from an
     email, say so in one muted line: "No Tally account uses {email}, so we made an invite link instead."
- Pending/disabled states on the submit button (spinner), Enter submits, errors inline under the form
  (not only toasts).

**New link** (pending row): revoke then create an invite with the same name + role → open the Invite
ready step. Revoke answering 409 "already accepted" → toast "{name} already accepted — they're a member
now" and refresh members + invites. Any failure after revoke succeeded must still surface clearly
(toast) and refresh the list.

**Share text:** `{myDisplayName} invited you to "{propertyName}" on Tally. This link works once and
expires {date}.` → `PropertyMembers` gains a `propertyName` prop from settings.tsx.

## Constraints
- Client-only change: existing endpoints (`members`, `invites`), existing hooks in `use-members.ts`
  (extend if needed), invalidate members AND invites after add/invite/revoke/new-link.
- Keep all existing guards/tests (last owner, self-demote confirm, url shown once and never persisted).
- Tailwind/Radix primitives from `components/ui`; match the Settings visual language (mono uppercase
  sub-lines, `--color-rule` dividers). Chrome by orientation / input by pointer (tally rule): 44px targets
  on coarse pointer.
- No horizontal overflow at 390; dialog usable at 390 (full-width with margins).

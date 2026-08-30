# A tally dev environment — a staged plan

**Goal:** give tally somewhere other than prod to find out that a change is
wrong. Closes #85.

**Status:** committed plan, 2026-08-30. This is a PLAN, not an
implementation; no production code changes ride with it.

**Recommendation in one paragraph:** don't build a hosted dev tier yet.
Most of the value #85 is reaching for — catching a bad migration before it
reaches prod — is available with **zero infrastructure**, because the
failure mode that cost us fourteen hours is reproducible in CI and in local
docker compose. Build that first (Stages 0–1). A real `tally-dev` VM
(Stage 2) is worth doing afterwards, but it is emphatically *not* the small
config change the issue implies: it is **blocked on an orchestrator
endpoint that does not exist**, it needs a sixth VLAN leg added to the
orchestrator VM itself, and it touches the UniFi network resource whose last
unguarded apply wedged the estate's control plane for eight hours. Stage 3 —
dev with a name and real Entra login — turns out to be cheaper than
expected, but is still optional.

All PW-side facts below were read out of
`/Users/luketurner/dev/prevailing-winds` on 2026-08-30 and are cited to
file and line. The canonical operator runbook for any of this is that
repo's `docs/APP-ONBOARDING.md`.

---

## 0. Four corrections to the issue

#85 was written 2026-08-03, before the v2 cutover settled. Every one of its
"repo config" premises is now wrong, and one of its "just delete the legacy
file" implications is dangerous.

### 0.1 There is no `dev` stub to flesh out

`pw.json`'s `environments` object has exactly one member, `prod`
(`pw.json:55–89`). A `dev` block would be written from scratch.

### 0.2 The `app.yml` sync is gone — but the file is **load-bearing**

The dual-manifest model is dead: tally is on the v2 contract, `pw.json` is
the only *deployment* manifest, and PW's own CLAUDE.md says `pw.json`
"replaces the old dual-manifest model". So **drop the "sync app.yml to the
orchestrator repo" step from the issue.**

But do not read that as "the file is dead". `orchestrator/apps/tally/app.yml`
is still read, and `adminDb.js:33–58` carries a 55-line comment saying so in
capitals:

> `LOAD-BEARING: orchestrator/apps/<app>/app.yml IS NOT DEAD. DO NOT DELETE IT.`
> … "tally is a single-DB app that made its main DB the admin DB, so it is
> the one app whose ledger is NOT `<APP>_ADMIN`. Nothing in pw.json records
> that; the v1 manifest is the sole source."

Deleting it would silently resolve tally's migration ledger back to
`TALLY_ADMIN` — a database that exists but is frozen at
`002_entity_indexes` — and resurrect a false "N pending migrations" banner.
The same comment ties this to a real outage: tally prod served 500s on item
pages for 14h17m on 2026-08-15.

Two consequences for this plan. First, **tally's CLAUDE.md rule 1 is
misleading** where it calls the file "v1 legacy; don't resurrect it" — true
of the *sync*, false of the *file*. Worth a one-line correction in a
separate PR. Second, and helpfully: `adminDb` resolution is **per-app, not
per-env** (`adminDb.js:127–150`), so a `dev` environment inherits
`adminDb = TALLY` automatically. Nothing to add to `app.yml`.

### 0.3 imp is not four hosts per environment any more

PW v2 "consolidates from the previous 4-VM-per-environment model … to a
single Docker VM per environment at `.10` on its VLAN"
(`prevailing-winds/CLAUDE.md:20`). `imp-dev` is one VM (VMID 103,
10.0.100.10), `imp-qa` one VM (VMID 104, 10.0.110.10)
(`docs/INFRASTRUCTURE.md:159–168`). The 4-host layout still written in
`orchestrator/apps/imp/app.yml:116–146` is aspirational v1;
`terraform/unifi.tf:290–293` says the per-role `.11/.12/.13` entries "would
404 if used as DNS targets". **An environment cannot be anything but one
VM** — `modules/app-environment/main.tf:29–31` calls `proxmox-vm` with
`count = 1`, and the registry stores a single scalar `vm_ip`, not a map.

Also: `terraformWorkspace` for a v2 environment is `${app}-${env}` —
`tally-dev`, not `dev` (`v2/executor.js:175`, `register.js:146`).

### 0.4 prx002, not prx001 — and that is a known bug

The registration route hard-codes `proxmoxNode: 'prx001'`
(`register.js:145`), but the VM template 9999 is **prx002-local-lvm-only**
(#480). `docs/APP-ONBOARDING.md:88–92` prescribes a manual SQLite
`UPDATE app_environments SET proxmox_node='prx002'` after registration, and
the troubleshooting table at `:218` lists the symptom: "Clone fails `unable
to find … VM 9999 on node X`". Budget the flip; don't discover it.

---

## 1. What a dev environment is actually for

The honest list is short, and each item has a different cheapest answer.

### 1.1 Testing migrations before prod — the real one

This repo's worst outage was a migration-ordering failure: merging code
before its additive migration was applied cost ~14 h of prod on 2026-08-15.
The near-miss shape is migration 002, which was non-idempotent, died with
`ERROR 1061 Duplicate key name` on any database built from the *current*
base schema, and **blocked 003 behind it** — leaving the print tables absent
while the deploy reported success (CLAUDE.md, CI/CD rule 9). This is live
today: `d603428` shipped migration 011, and per rule 8 the deploy will not
apply it; someone must fire `migrate-all` from the management VLAN by hand.

The migration chain is **currently clean** — verified 2026-08-30: 002,
004–011 carry `information_schema` guards, 003 uses
`CREATE TABLE IF NOT EXISTS`, and 001's `ALTER … MODIFY ENUM` is idempotent
by nature. That is the state to *hold*, and it drifted once already.

What would actually have caught each failure:

| Failure | Caught by a hosted dev env? | Caught by CI? |
|---|---|---|
| 002 non-idempotent, blocks 003 | yes | **yes** — apply the chain twice against a fresh MySQL |
| Base schema drifts ahead of the chain | yes | **yes** — diff the resulting schema against a committed expectation |
| Merge-before-migrate ordering | only if dev deploys are migrate-gated by discipline | **yes** — a required job on any PR touching `SQL/` |
| Migration valid as DDL but wrong against real prod *data* | **yes** | no |
| The `migrate-all` playbook's own mechanics | yes | no |

Three of five are CI's job and CI has no VM cost. That asymmetry is the
whole reason this plan is staged.

### 1.2 Flushing out prod config that isn't in `pw.json`

`pw.json` declares neither `NODE_ENV`, `S3_PUBLIC_ENDPOINT`,
`ANTHROPIC_API_KEY`, nor `BYPASS_AUTH` — verified by grep, 2026-08-30. Yet
prod serves photos (which requires `S3_PUBLIC_ENDPOINT`, rule 13) and runs
vision (which requires the key). So **prod is not fully described by its own
manifest**: some values are computed by the compose generator, which writes
`.env` from "Vault secrets + computed values"
(`prevailing-winds/CLAUDE.md:258`), and some arrived out of band.

A second environment built from `pw.json` alone would therefore not be a
faithful copy of the first. Standing up dev is what forces the hidden config
into the file — but note the audit can be done *without* standing up dev, by
reading the generated `.env` on the prod VM. See Stage 1.

`NODE_ENV` deserves its own callout. Unset, the server does not enforce
required env vars (`server/src/config.js:29–36` warns instead of throwing),
sets session cookies without `secure` (`middleware/csrf.js:30`), returns
verbose errors (`middleware/error-handler.js:29,71`), and **permits
`BYPASS_AUTH`** (`config.js:80–88` blocks it only when
`NODE_ENV === 'production'`). `docs/entra-id-setup.md:69` claims PW injects
`NODE_ENV=production`; `pw.json` does not. **Verify this on the prod VM
before anything else in this plan.** If it is unset, that is a prod security
finding with its own ticket, independent of #85.

### 1.3 Proving the two build pipelines agree

CI/CD rule 5: `build.yml` builds on the self-hosted runner, the orchestrator
builds on VM112 from a fresh clone, and they must agree. A dev environment
gives the orchestrator path a rehearsal target. Real, but modest — the
orchestrator build already runs on every prod deploy, so the gap it closes
is "find out earlier", not "find out at all".

### 1.4 What a dev environment is *not* for

**Feature and UI work.** Local compose is strictly better and it isn't
close — hot reload, `BYPASS_AUTH=true`, `task db:reset`, the vitest suites,
the fake-camera harness, real devtools. Say so plainly so nobody builds a
VM for that reason.

---

## 2. What local compose already covers

`docker-compose.yml` runs five services — `tally-db` (mysql:8.4),
`tally-minio`, `tally-server`, `tally-client`, `tally-vault` — with source
mounted live; `Taskfile.yml` wraps the lifecycle.

| Capability | Local compose | Hosted dev | Verdict |
|---|---|---|---|
| Run the app, iterate on UI | yes, hot reload | worse | **local wins** |
| Migrations against a fresh schema | yes (`SQL/init/002_apply_migrations.sh`) | yes | **local wins** (faster loop) |
| Migrations against an *existing populated* schema | no — `db:reset` always rebuilds | yes | **gap** |
| The `migrate-all` playbook itself | no | yes | **gap** |
| Orchestrator build + compose generator | no | yes | **gap** |
| Real Entra OIDC login | no (`BYPASS_AUTH=true`) | yes, with an internal vhost (§3.5) | **gap** |
| The nginx `web` service as prod has it | **no** — there is no nginx in compose, and `client/nginx.conf` is dev-only, not what serves prod (rule 11) | yes | **gap** |
| Presigned-URL host binding (rules 12/13) | partially — one host, one port | yes | **gap** |
| Realistic data | **no seed fixture exists anywhere in the repo** (verified by grep) | only with a prod copy | **gap in both** |

The two that hurt are the last one and "existing populated schema", and they
are the same problem: *we have no realistic database to migrate*. That is a
tally-repo gap, not an infrastructure gap, and it caps the value of a dev
environment as hard as it caps local testing. Fix it first regardless of
which path is taken.

---

## 3. What tally-dev would cost

### 3.1 The VM

One VM. Defaults are **4 cores / 6144 MiB / 50 GiB** — agreed across three
layers (`services/operationQueue.js:67–69`,
`terraform/modules/app-environment/variables.tf:31–45`,
`docs/APP-ONBOARDING.md:25`).

Per-environment overrides exist in the schema (`vm_cores_override`,
`vm_memory_override`, `vm_disk_override`, resolved by
`registry.getEffectiveVmSpec()`, `registry.js:128–141`) — but **there is no
API to set them**. `docs/APP-ONBOARDING.md:86`: "set them at register time —
per-env overrides are DB-write-only afterward." Since tally cannot be
re-registered (§3.3), sizing dev down to 2 / 3072 / 30 means a hand-written
SQLite update, the same escape hatch already prescribed for the prx002 flip.

**Capacity is the real constraint.** Each Proxmox node has a single 64 GB
SODIMM, ~60.5 GiB usable, and
`docs/PHYSICAL-DEEP-DIVE-2026-08-02.md:69` measured **44–47 of 60.5 GiB in
use** — so roughly 13–16 GiB free per node, with a second SODIMM tracked as
#591. prx002 already carries six VMs including the whole `pw-*` control
plane. A default 6 GiB dev VM eats ~40% of remaining headroom on the node it
must land on. **Size it down; this is not a free VM.**

Everything else runs as containers inside that one VM: app, MySQL, MinIO,
nginx. **No second DB host, no second MinIO host, no separate bucket cost** —
the `TALLY` database and the `tally-files` bucket are declared once
(`pw.json:26–37`) and generated per-environment.

### 3.2 The VLAN, and the eight things it drags with it

The VLAN *number* is free: the pool is 140–199, 140 is daybook's, and
`allocate()` takes the lowest free — so **141**, `10.0.141.0/24`, VM at
`10.0.141.10`. (A tidier `136` is not in the seeded pool at all and would
need a `vlanPool.preAllocate(136, …)` line added next to the existing
pre-allocations in `api/index.js:84–87`. Not worth it.)

What is *not* free — `docs/APP-ONBOARDING.md` §0, prereqs 0.2–0.7:

1. **A UDM network** — a new entry in `local.app_vlans`,
   `terraform/unifi-networks.tf:11–20` (which today holds exactly five:
   IMP-DEV/QA/PROD, TALLY-PROD, DAYBOOK-PROD). **This is the single most
   dangerous file in the plan.** The resource carries
   `lifecycle { ignore_changes = all }` because of a 20-line incident note
   at `:40–60`: the provider re-PUTs the full networkconf object on apply,
   the PUT omits `firewall_zone_id`, the controller clears it, the network
   is orphaned from its zone, and UniFi's gateway-config generator then
   NullPointerExceptions on *every* device inform — "a single redis-drop
   apply blanked TALLY-PROD's zone at 07:55 and wedged the whole control
   plane for ~8h" (2026-07-13). Any apply here is a maintenance-window
   operation with console access to the UDM.
2. **Joining the network to a firewall zone, by hand in the UI** — the
   provider cannot set `firewall_zone_id` at all. A network in no zone is
   the blank-zone condition the `udm-firewall-zones` monitor exists to
   catch. **See the zone recommendation below.**
3. **`env_cidrs`** — append to the hand-maintained map at
   `terraform/security.tf:16–23`, which drives the per-environment app
   security groups. Note `docs/APP-ONBOARDING.md:27`: Proxmox accepts rules
   referencing groups that don't exist yet, so nothing errors — traffic just
   drops. **The groups must exist before provisioning.**
4. **An orchestrator NIC leg, in two layers.** VM112 does not route to app
   VLANs; it carries a tagged leg on each one, so deploys are L2-direct and
   survive a UDM outage (`prevailing-winds/CLAUDE.md:361`). Terraform:
   `additional_vlans = [100, 110, 120, 135, 140]` at `main.tf:136` plus
   `orchestrator_env_ips` at `variables.tf:258–261`. Ansible:
   `orchestrator_env_nics` in `inventories/shared/hosts.yml:104–140`.
   `docs/APP-ONBOARDING.md:28` is explicit that **both** are required —
   "a bare `qm set` gets **stripped by the next imp-shared apply**" (#467).
   This is an `imp-shared` apply against the workspace that also holds
   Vault, the runner and the cluster firewall, and it may bounce the
   orchestrator.
5. **A proxy NIC leg** is listed as prereq 0.6 — but see §3.4; imp-dev and
   imp-qa demonstrate it is optional.
6. **A Proxmox pool** `tally-dev`, created by hand with `pvesh` (#479 will
   automate).
7. **Vault** at `secret/data/apps/tally/dev`. The five `pw.json.secrets`
   auto-generate; the three `external_secrets` (`ENTRA_*`) only ever get
   empty placeholders and must be filled by hand — and never clobbered,
   which `register.js:162` notes "is exactly the bug that broke Tally's
   Entra login on the v2 cutover". **But secrets are only minted by the
   registration route** (`register.js:163–193`), which cannot run again
   (§3.3), so for a hand-added environment this is `vault kv patch
   secret/apps/tally/dev …` or the Secrets page.
8. **An orchestrator restart.** Monitor checks discover environments only at
   startup (`monitor.js:625–654`; `docs/APP-ONBOARDING.md:191`), so dev is
   unmonitored until VM112 restarts.

Plus one timing trap: `docs/APP-ONBOARDING.md:26` — "Gateway can lag
**hours** after creation — verify `ping 10.0.<vlan>.1` from the orchestrator
before provisioning."

**Zone recommendation: put VLAN 141 in the existing `TALLY-PROD` zone, and
verify an intra-zone block exists.** The precedent is exact — IMP's three
environments share one zone and their separation is carried by the per-VM
Proxmox firewall (`policy_in/out=DROP` plus scoped security groups), which
`prevailing-winds/CLAUDE.md:146` calls "the durable isolation contract".
Reuse is also *cheaper on firewall rules*: the existing zone-level
`Servers→Tally` and `Admin→Tally` allows would cover the new VLAN with no
new policies. Two things to be deliberate about rather than surprised by:

- `docs/INFRASTRUCTURE-GOLD-STANDARD.md:83` records that "'Admin to Tally'
  remains zone-wide ANY (benign: Tally zone = tally-prod only …)". Adding a
  second network extends that ANY to dev. For a dev box you want to reach
  from a laptop, that is the desired outcome — but the word "benign" in that
  note stops being load-bearing, and #275's governance guard
  (`scripts/unifi-governance-check.js:111–120`) should be re-run after.
- `docs/INFRASTRUCTURE-GOLD-STANDARD.md:959` warns that cross-environment
  *web* isolation "rests on the UniFi `IMP→IMP Block All` default alone —
  the per-VM `.fw` would accept cross-env `:80/:443` from any source".
  So the TALLY zone needs the equivalent intra-zone block, or tally-dev can
  reach tally-prod's web tier. **Confirm before, not after.**

Creating a separate `TALLY-DEV` zone is the alternative; it means eight new
zone-pair policies and more time in the surface that #469 and the
`ignore_changes = all` note both describe as a loaded gun. Don't.

### 3.3 The blocker: no way to add an environment to a registered app

This is the finding that changes the shape of the work.

`registry.createEnvironment()` has **exactly one caller**
(`routes/register.js:139`), and so does `vlanPool.allocate()`
(`register.js:125`). Both sit inside `POST /api/_y_/apps/register`, which
refuses outright if the app already exists:

```js
const existing = registry.getApp(appId);
if (existing) {
  return error(res, `App '${appId}' is already registered`, 409);
}
```
— `orchestrator/api/src/routes/register.js:102–106`

Tally is already registered, with `prod` only. There is a `DELETE
/api/_y_/apps/:app/envs/:env` to *destroy* an environment, but no `POST` to
add one — and `orchestrator/apps/imp/app.yml:114` cheerfully instructs the
reader to "POST /api/_y_/apps/imp/envs", a route that has never existed.

Three ways forward, in order of preference:

- **(a) Add the endpoint to PW.** Small and well-scoped: validate `pw.json`,
  `vlanPool.allocate()`, `registry.createEnvironment()`, merge Vault
  secrets, accept optional VM sizing. Every piece already exists inside the
  register route and needs lifting into a reusable function — which also
  fixes the `pipelineConfig: null` and hard-coded-`prx001` warts in passing.
  **File this as a PW issue before anything else in Stage 2.**
- (b) Hand-write the registry row into
  `/opt/orchestrator/data/operations.db` (`app_environments` requires
  `app_id, env_name, vlan_id, cidr, vm_ip, proxmox_node,
  terraform_workspace`; `status` defaults to `pending`, which is what
  `provision` needs) plus the `vlan_pool` allocation. This is the same
  escape hatch `docs/APP-ONBOARDING.md:90` already prescribes for the
  prx002 flip, so it is not unprecedented — but it is unrepeatable and
  undocumented for the next person.
- (c) De-register and re-register tally with `["prod","dev"]`. **No.** It
  re-runs VLAN allocation and Vault merge against a live prod environment
  for no benefit.

### 3.4 Naming: internal-only, and cheaper than expected

I initially read `additional_vlans = [120, 135, 140]` on the shared proxy
(`terraform/main.tf:174`) — imp-prod, tally-prod, daybook-prod — as meaning
imp-dev and imp-qa have no web presence. That is wrong. They *do*:
`ansible/inventories/shared/hosts.yml:200–215` defines
`web.dev.razorwire-productions.com` → `http://10.0.100.10` and
`web.qa.…` → `10.0.110.10`, both `type: passthrough`, `tls: internal`. The
proxy reaches those VLANs from the management side by ordinary routing; the
tagged legs on 120/135/140 are a resilience optimisation for prod, not a
requirement for a vhost.

So dev's naming cost is **one `proxy_sites` entry plus one internal
`unifi_dns_record`** — no proxy NIC leg, no public DNS, no Let's Encrypt.
`tls: internal` issues from the RWP CA (`hosts.yml:194–199`: "No public DNS
/ LE HTTP-01 needed — that's why these can't use certbot"). Follow the imp
precedent and call it `web.tally-dev.razorwire-productions.com`.

**Do not add tally-dev to public DNS.** That means no entry in
`orchestrator/api/src/config/public-dns.json` (`dynamicA`/`proxiedA`) and no
Cloudflare reconcile. There is one trap if a vhost is created: #488 — the
proxy role's placeholder cert blocks certbot for a *new* site
("live directory exists"), with recovery steps at
`docs/APP-ONBOARDING.md:159`.

### 3.5 Entra

Entra rejects non-HTTPS redirect URIs except for `localhost`. With §3.4's
internal `tls: internal` vhost, dev *can* do real OIDC — the browser
performs the redirect, so an internally-resolvable HTTPS name is sufficient
provided the client machine trusts the RWP CA (it already must, for
`web.dev.…`). Without a vhost, at `http://10.0.141.10`, OIDC is impossible —
not "needs another registration", impossible.

No code change either way: the redirect URI is derived, not configured —
`auth.service.js:91,129` build it as
`` `${config.clientUrl}/api/auth/_x_/oauth/callback` ``, and `CLIENT_URL` is
a per-environment `pw.json` value (`pw.json:79`). And **a second app
registration is not required**: an Entra app registration holds many
redirect URIs, so the cost is one added URI. The trade is that dev and prod
would then share a client secret, so a dev compromise is a prod credential
compromise — which is the argument for a separate registration if this is
ever taken up.

**Recommendation: Stage 2 runs `BYPASS_AUTH=true` with no vhost.** That
requires `NODE_ENV` not to be `production` (`config.js:80–88`), and brings
non-`secure` cookies and verbose errors with it — acceptable on a VLAN
reachable only from management, and *exactly why dev must never hold a copy
of prod data* (§4). Real login is Stage 3, and now known to be affordable.

### 3.6 Cost summary

| Item | Cost |
|---|---|
| VM | 1 × 6 GiB by default on a node with ~13–16 GiB free — **size it down** |
| Second DB / MinIO host, bucket | **none** — containers, generated per env |
| Entra registration | **none** with `BYPASS_AUTH`; one extra redirect URI otherwise |
| VLAN number | free from pool (141) |
| UDM network + zone join | 1 TF apply on the `ignore_changes = all` resource + 1 UI action |
| Orchestrator NIC leg | 1 `imp-shared` apply **and** 1 Ansible run; may bounce VM112 |
| `env_cidrs`, Proxmox pool, Vault, orchestrator restart | 4 small operator steps |
| Public DNS / LE cert / proxy NIC leg | **none** |
| GH Actions runner | **none** — `tally-runner-shared` is per-repo |
| PW orchestrator feature | **1 new endpoint** — the blocker (§3.3) |

---

## 4. What data dev holds

**Not a prod snapshot.** The share-disclosure work that landed today (#298,
migration 011) exists because tally's contents are sensitive in a specific
way: `properties.ADDRESS`, `items.PURCHASE_PRICE`, `items.CURRENT_VALUE`,
`users.EMAIL`, `item_files` rows typed `receipt`/`warranty`, and free-text
`NOTES` on dates, conditions and loans
(`SQL/init/001_TALLY_Init.sql:29,50,67,158–159,182,208,222,244`). Together
that is *a list of the household's valuables, what they cost, and exactly
which bin each one is in*, plus the paperwork. #298's premise is that
publishing that without the sharer's say-so is unacceptable — copying it
wholesale into an environment running `BYPASS_AUTH=true` contradicts the
finding we shipped this week.

In order of preference:

1. **Schema-only, always.** `mysqldump --no-data` is sufficient for what dev
   is *for* (§1.1): DDL migrations care about schema shape, not rows. Zero
   privacy exposure. This is the default.
2. **A synthetic seed fixture** at `SQL/seed/`, committed, with enough shape
   to be interesting: containers nested deeply enough to exercise the
   closure table, items with FULLTEXT-searchable text, a share link or two,
   a print job, a delete batch. Nothing like this exists today and its
   absence is felt locally as much as it would be in dev. **This is the
   single highest-value item in the plan and it needs no infrastructure.**
3. **A scrubbed prod copy**, only if an investigation genuinely needs real
   volume: restore, then run a *committed* scrub script that nulls
   `ADDRESS`, both price columns, `EMAIL` and every `NOTES` column, and
   deletes `item_files` / `condition_snapshots` rows (the MinIO objects
   aren't copied, so those rows would dangle anyway). Committed, so it can't
   be improvised at 1am.
4. **A raw prod copy** — no. Not in an environment with auth bypassed.

Mechanically, 1 and 3 need no new tooling: `POST …/db/backup` takes a dump,
`GET …/db/backups` lists and `GET …/db/backups/:filename` downloads one, and
`POST …/db/restore` / `…/db/restore/upload` push one back
(`orchestrator/api/src/routes/database.js:179–306`). All management-VLAN
only — and a dump sitting on a workstation is the same disclosure by another
route, which is the second reason to prefer `--no-data`.

---

## 5. How deploys and migrations reach dev

### Deploys

`build.yml` is prod-hardcoded: it posts to
`…/apps/tally/envs/prod/v2/deploy`, declares `environment: prod`, and uses
`concurrency: group: deploy-prod`. **Note that `pw.json`'s `pipeline` block
is dead code** — `register.js:147` stores `pipelineConfig: null`
unconditionally, and `docs/APP-ONBOARDING.md:58` states it plainly:
"pw.json's `pipeline` block is NOT consumed by v2 … `build.yml` *is* the
auto-deploy." So `environments.dev.pipeline.autoDeployBranch` would do
nothing; the trigger has to live in a workflow.

**Recommendation: manual-first.** Add a `workflow_dispatch` input to
`build.yml` (env + ref) or a small separate `deploy-dev.yml`, with its own
concurrency group. Dev deploys should be an act, not a consequence — on a
single shared VM, branch-triggering mostly means feature branches fighting
over it. imp's workflow does env discovery via `GET /apps/v2/imp`
(`docs/CICD-FLOW.md:85–86`) if a general version is ever wanted.

### Migrations

They stay a separate op (rule 8) — and that *is* the point: dev is where you
rehearse firing `migrate-all` before doing it to prod. Four specifics:

- **Pass `ref: master`.** `db-migrate-all` is in neither `TERRAFORM_OPS` nor
  `INLINE_OPS`, so the executor pulls the orchestrator's repo clone first,
  and without a ref it enumerates a stale `SQL/migrations`
  (`docs/ops-memory/pw-codebase-gotchas.md:29`).
- **Tally's ledger lives in `TALLY`, not `TALLY_ADMIN`** (§0.2). The
  playbook's own fallback resolves `<APP>_ADMIN`; `services/executor.js:901`
  passes `mysql_admin_db` unconditionally to override it, and `adminDb.js`
  says in capitals not to restore the old "only set it when truthy" guard.
  **Any hand-run `ansible-playbook db-migrate-all-v2.yml` for tally without
  `-e mysql_admin_db=TALLY` writes the ledger to the wrong database.**
- The `-D <db>` gap noted in older session memory is **closed** (#501):
  `db-migrate-all-v2-apply.yml:24–31` passes `-D {{ connect_db }}`, resolved
  by the parent to a database that actually exists.
- **A fresh dev DB is built from `SQL/init/*.sql` exactly once.**
  `docs/APP-ONBOARDING.md:141–143`: init runs "only on first start with an
  empty data volume", and named volumes persist across deploys and
  rollbacks. So dev's schema comes from `001_TALLY_Init.sql`, then needs
  `migrate-all` — which is precisely the "chain applied on top of the
  current base schema" path that Stage 0 gates.

One trap to check before the first dev deploy: the catalog default image for
`nodejs` is `node:22-alpine` (`prevailing-winds/CLAUDE.md:248`), while
tally's prod block overrides it to `node:22-bookworm-slim` (`pw.json:63`). A
`dev` block that omits the override would run a *different libc* than prod —
different `sharp` behaviour for thumbnails, among other things. **Dev must
inherit prod's image override**, or it stops being a rehearsal. The same
applies to `healthCheck`: omit it and the deploy gate defaults to `/health`
and auto-rolls-back every deploy on the 404
(`docs/APP-ONBOARDING.md:41`).

---

## 6. Repo-side vs PW-side, itemised

**In this repo (no operator gate):**
- `SQL/seed/` fixture + a `task db:seed` target.
- The CI migration gate (Stage 0).
- `pw.json`: write the currently-undeclared prod values explicitly
  (`NODE_ENV`, `S3_PUBLIC_ENDPOINT`, whatever else the prod `.env` carries).
  Worth doing on its own merits.
- `pw.json`: a `dev` block mirroring prod's structure — same `image`
  override, same `healthCheck`, `CLIENT_URL: http://10.0.141.10`,
  `BYPASS_AUTH: "true"`, no `NODE_ENV=production`. No `pipeline` key; it is
  inert.
- `.github/workflows/`: a dispatch input or `deploy-dev.yml`.
- A `docs/` runbook for the migration rehearsal loop.
- CLAUDE.md: correct rule 1's "don't resurrect it" wording (§0.2), and while
  in `docs/`, drop the stale `10.0.130.x` IPs from `entra-id-setup.md`.

**PW-side (operator, plus one code change):**
- **New:** an add-environment endpoint (§3.3). Blocker.
- `terraform/unifi-networks.tf` — the VLAN 141 network (the dangerous one).
- UDM UI — join it to the `TALLY-PROD` zone; confirm an intra-zone block.
- `terraform/security.tf:16–23` — `env_cidrs` entry.
- `terraform/main.tf:136` + `variables.tf:258–261` + Ansible
  `orchestrator_env_nics` — the sixth NIC leg, both layers.
- `pvesh create /pools --poolid tally-dev`.
- SQLite: `proxmox_node='prx002'`, plus VM sizing overrides.
- Vault — `vault kv patch secret/apps/tally/dev …`.
- `provision`, then `deploy`, then restart the orchestrator for monitoring.
- **Not needed:** runner registration, public DNS, LE cert, proxy NIC leg,
  `additional_web_apps`.

---

## 7. The staged path

Each stage stands alone and delivers before the next one starts.

### Stage 0 — a migration gate in CI (tally repo only, no operator)

The cheapest thing that attacks the actual failure mode. A `ci.yml` job on
every PR touching `SQL/`:

1. Start MySQL 8.4 (prod's catalog version — note compose still pins 8.0).
2. Apply `SQL/init/001_TALLY_Init.sql`, then every `SQL/migrations/` file in
   numeric order. Non-zero exit fails the PR — the 002-blocks-003 class.
3. Apply the whole chain **a second time**. Still green = idempotent, which
   is CI/CD rule 9 enforced instead of remembered.
4. Dump the resulting schema and diff it against a committed
   `SQL/expected-schema.sql`, regenerated in any PR that lands a migration.
   This is what catches the base schema drifting ahead of the chain — the
   underlying cause of the 002 incident, and the exact shape a fresh dev VM
   would hit on its first `migrate-all` (§5).

**Immediate value; cost is one CI job; three of the five rows in §1.1's
table go green.**

### Stage 1 — a real database to migrate (tally repo + one mgmt-VLAN fetch)

1. Write `SQL/seed/` (§4.2) and `task db:seed`. `task db:reset && task
   db:seed` now produces something worth migrating.
2. Write the rehearsal runbook: `POST …/db/backup` on prod →
   `GET …/db/backups/:filename` → **`--no-data`** → restore into local
   compose → apply the pending migration → confirm the app boots and the
   touched endpoints answer. Ten minutes from a management-VLAN host, zero
   new infrastructure.
3. Audit the prod VM's generated `.env` against `pw.json` and write the
   missing keys in. Settle the `NODE_ENV` question (§1.2) while there.

**After Stage 1 the case for a hosted dev environment is genuinely weaker.
That is a good outcome, not a failure of the plan** — re-read §1.1's table
and decide whether the remaining two rows justify §3.6.

### Stage 2 — `tally-dev` as a real PW environment (operator-gated)

Only if Stage 1 leaves a gap that matters. Ordered so each gate aborts
cleanly:

1. File and land the PW add-environment endpoint (§3.3). Nothing else can
   start.
2. Write the `dev` block in `pw.json`; confirm `validatePwJson` accepts it
   (PW unit-tests that in its own CI).
3. **UDM network + zone**, in a maintenance window with console access:
   `unifi-networks.tf` for VLAN 141, then join it to `TALLY-PROD` in the UI,
   then re-run `scripts/unifi-governance-check.js` and the
   `udm-firewall-zones` / `udm-zone-isolation` monitor checks. Confirm the
   intra-zone block (§3.2). Then wait for the gateway: `ping 10.0.141.1`
   from the orchestrator before going further.
4. `env_cidrs`, then the orchestrator NIC leg in **both** layers, then
   verify `ip route get 10.0.141.10` from VM112 is on-link (not `via`).
   Create the Proxmox pool.
5. Add the environment → flip `proxmox_node` to prx002 → set sizing
   overrides → fill Vault → `provision` → `deploy` with `ref: master`.
6. Confirm `/health/ready` answers on `http://10.0.141.10`, then run
   `migrate-all` (with `ref: master`, and `mysql_admin_db=TALLY` if run by
   hand) and **diff dev's resulting schema against Stage 0's expected
   schema. That diff is the acceptance test for the whole stage** — if it
   doesn't match, the environment is decoration.
7. Restart the orchestrator so monitoring picks dev up. Add the deploy
   workflow. Then adopt the rule that makes it worth anything: **every
   migration is applied to dev and verified before the PR carrying its code
   merges.**

### Stage 3 — dev with a name and real login (optional, now affordable)

One `proxy_sites` entry (`web.tally-dev.razorwire-productions.com`,
`tls: internal`), one internal `unifi_dns_record`, `CLIENT_URL` switched to
that name, `BYPASS_AUTH` off, `NODE_ENV=production`, and one redirect URI —
ideally on a **separate** Entra app registration, not prod's (§3.5). Watch
for the #488 certbot placeholder trap. Do this only if the OIDC path itself
needs testing against a real tenant; `imp-dev` has gone without for its
whole life.

---

## 8. Verify before building

None of these are answerable from the repos alone, and several could change
the plan.

1. **Is `NODE_ENV` set on the prod app container?** Read
   `/opt/tally/current/.env` on 10.0.135.10. If unset, that is a prod
   security issue with its own ticket, and it changes §3.5's reasoning.
2. **What else is in that `.env` that isn't in `pw.json`?** Full diff — this
   is Stage 1's real deliverable.
3. **Is tally's migration ledger current through 011?**
   `GET …/apps/tally/envs/prod/db/migrations` answers that and confirms
   which database the ledger is actually in.
4. **Is app-level Terraform genuinely v2?** `v2/appTerraform.js:2–9` warns
   that `main.tf`'s `app_vms` module "still sources the LEGACY v1 4-VM
   module", that live app VMs were created out of band and are absent from
   state, and that `tally-prod`'s state holds **phantom VMs 127–130** — yet
   `APP_TF_V2_READY = true` and the comment was not updated alongside it.
   **Read the live `tally-prod` state before planning `tally-dev`.**
   Runbook: `docs/TF-V2-APP-CUTOVER-RUNBOOK.md`.
5. **Which VLAN would actually be allocated?** `GET /api/_x_/vlans`. 141 is
   an inference.
6. **Does adding a NIC to VM112 need a stop/start** with the running
   `bpg/proxmox` version? Determines whether step 4 needs a window.
7. **Free CPU and disk on prx002** — only the memory figure (44–47 of
   60.5 GiB, 2026-08-02) is recorded anywhere.

---

## 9. What this plan deliberately does not recommend

- **A qa tier.** Three environments for a single-household app with one
  developer is ceremony. Revisit if dev earns its keep for a year.
- **A separate `TALLY-DEV` UniFi zone.** Eight new pair policies in the
  estate's most fragile surface (#469, #198, and the `ignore_changes = all`
  incident) when IMP's own three environments share one zone.
- **A prod data copy in dev.** §4 — hard to justify the same week #298
  shipped.
- **Public DNS or a Let's Encrypt cert for dev.** §3.4.
- **Branch-triggered dev deploys** on day one, or any use of `pw.json`'s
  `pipeline` block, which is inert (§5).
- **Deleting `orchestrator/apps/tally/app.yml`.** §0.2. It is the sole
  source of `adminDb = TALLY`.

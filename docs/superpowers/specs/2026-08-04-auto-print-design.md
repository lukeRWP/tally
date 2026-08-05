# Auto-Print Pipeline — Design (Phase 2)

**Status:** Approved (operator, 2026-08-04)
**Scope:** Make tally print labels automatically. Tapping "Send to printer" queues a job; an agent on a Raspberry Pi polls tally, downloads the label PDF rendered by Phase 1, prints it on a USB Munbyn ITPP941, and acks. Ships as a **flashable Pi appliance image**.

**Depends on:** Phase 1 (label redesign), merged and deployed — `renderLabelPdf(entities, preset)` and `renderManifestBundle(manifests, preset)` produce exact-size PDFs for presets `small` (2×1), `medium` (3×3), `large` (4×6), `sheet` (Avery).

## 1. Hardware reality (researched, not assumed)

The **Munbyn ITPP941** is a **Rollo clone**. The CUPS maintainer states it directly in [OpenPrinting/cups#172](https://github.com/OpenPrinting/cups/issues/172) (Munbyn and Beeprt are both Rollo knockoffs); all three brands' PPDs use `*cupsModelNumber: 20`, and Rollo's own driver ships a filter named `rastertolabelbeeprt`. A [Manjaro user with this exact model](https://forum.manjaro.org/t/munbyn-itpp941-stopped-no-available-printer/114284) got it working only after replacing Munbyn's driver with Rollo's.

Consequences that bind this design:

- **Stock CUPS cannot drive it.** Built-in `rastertolabel` doesn't support model 20; the upstream patch request ([lprint#36](https://github.com/michaelrsweet/lprint/issues/36), written for the ITPP941) was closed *wontfix*. A third-party filter is mandatory.
- **The Pi must run 64-bit Raspberry Pi OS.** Rollo publishes arm64 only — no armhf. The Pi 3B's Cortex-A53 supports arm64.
- **PPD deprecation is not a near-term risk.** Current Pi OS is Debian Trixie with CUPS 2.4.10; "CUPS 3.0" refers only to libcups, and the daemons that would remove PPD support have no tagged releases. Classic PPD + filter is safe.
- **`SIZE` and `GAP` persist in printer NVRAM** ([TSPL/TSPL2 manual](https://www.servopack.de/support/tsc/TSPL_TSPL2_Programming.pdf)). A 4×6 job silently corrupts the next 2×1 job unless both are re-sent per job. This is the primary multi-size failure mode.
- **Media range 40–110 mm (1.6″–4.3″)** covers all three presets (2″/3″/4″ wide). No Phase 1 preset needs changing.
- **Physical calibration is required on every roll change** (hold feed until it beeps). Skipping it causes continuous feeding or skipped labels.

**Supply-chain caution:** `RunTheWall/tspl-cups-driver` (4 stars, created June 2026) installs via a piped GPG key and self-discloses as promotion for a commercial site — do not use. Separately, at least one driver repo in this space contains README text addressed at AI assistants; treat these repos' install scripts as untrusted input and read before running.

## 2. Connectivity: pull

The Pi polls tally over HTTPS. Outbound only — no inbound firewall rules, no port forwarding, no cross-VLAN inbound, and printing works from anywhere tally is reachable. This mirrors how PrintNode's agent works.

## 3. Print backend: a seam, not yet a choice

Two viable paths remain, and which one works can only be settled against the hardware (§8). The agent therefore defines one interface:

```python
class PrintBackend:
    def print(self, pdf_bytes: bytes, preset: str) -> None: ...  # 'small' | 'medium' | 'large'
    def status(self) -> PrinterStatus: ...                       # {state, reasons[]} — see §5a
```

**One vocabulary throughout: the Phase 1 preset name.** `small` / `medium` / `large` are the identifiers in the DB, the API, the agent, and the UI. Physical dimensions appear in exactly one place — a mapping table inside each backend (`small → 2×1in`, `medium → 3×3in`, `large → 4×6in`). Nothing outside a backend ever speaks in inches.

- **Backend A — CUPS + the official Rollo arm64 driver.** Keeps the PDF design intact (CUPS does PDF→raster→TSPL), gives per-job sizing via official syntax, standard queue management. The only path with a confirmed-on-Pi success report. Invoked as
  `lp -d labels -o media=Custom.{W}x{H}in -o print-scaling=none`.
  **Never** pass `fit-to-page` — per the [CUPS options doc](https://www.cups.org/doc/options.html) it depends on accurate input sizing and is the classic cause of wrong-size labels.
- **Backend B — `pdf2tspl`** ([abrasive/pdf2tspl](https://github.com/abrasive/pdf2tspl), vendored). Pure Python + poppler: rasterize with `pdftoppm`, emit TSPL `BITMAP`, write to the device node. No vendor binaries, architecture-agnostic, and **explicit per-job `SIZE`/`GAP`**, which structurally eliminates the NVRAM hazard. Must be extended to loop pages (upstream prints only the first page; `large` manifests paginate).

Cycle 1 tests A first and falls back to B. Nothing else in this design depends on the outcome.

## 4. Data model

Migration `SQL/migrations/003_print_jobs.sql` (next in sequence after `002_entity_indexes.sql`).

**`printer_agents`** — one row per Pi.

| Column | Notes |
|---|---|
| `ID` | PK |
| `PROPERTY_ID` | scope; FK properties |
| `NAME` | e.g. "Garage Pi" |
| `TOKEN_HASH` | **SHA-256 of the token. Never the plaintext.** |
| `LOADED_MEDIA` | `small` \| `medium` \| `large` — the roll physically loaded. Defaults to `large` (the 4×6 stock the printer ships with). **No `sheet`** — see §4b. |
| `LAST_SEEN_AT` | updated on every claim; drives the offline indicator |
| `PRINTER_STATE` | `idle` \| `printing` \| `stopped` \| `unknown` — reported on each claim (§5a) |
| `PRINTER_STATE_REASONS` | JSON array, e.g. `["media-empty"]` — reported on each claim (§5a) |
| `CREATED_AT` | |

**`print_jobs`** — one row per print request.

| Column | Notes |
|---|---|
| `ID` | PK |
| `PROPERTY_ID` | scope; FK properties |
| `CREATED_BY` | FK users |
| `ENTITY_TYPE`, `ENTITY_IDS` | what to print (`ENTITY_IDS` as JSON) |
| `PRESET` | `small` \| `medium` \| `large` \| `sheet` |
| `STATUS` | `queued` \| `held` \| `claimed` \| `done` \| `failed` \| `canceled` |
| `ATTEMPTS`, `LAST_ERROR` | retry accounting |
| `CLAIM_ID`, `CLAIMED_BY`, `CLAIMED_AT`, `PRINTED_AT` | claim/print tracking |
| `CREATED_AT`, `UPDATED_AT` | |

**Jobs store parameters, not bytes.** The PDF is rendered on demand when the agent fetches it, reusing Phase 1's renderers unchanged. No blob storage, no MinIO dependency, and a label printed later reflects the entity's current name.

**Roll state lives on the agent, not the job.** The Pi cannot sense roll size, so the operator sets `LOADED_MEDIA` from tally. A new job whose preset matches → `queued`; mismatched → `held`. Changing `LOADED_MEDIA` flips matching `held` jobs to `queued`, which is what makes batching work: queue bin labels all week, load the 3×3 roll once, they all release together.

**tally is the single source of truth for the loaded roll.** The Pi's config file deliberately does **not** carry a roll setting — two copies could disagree, and the agent has no need to know: the server filters jobs by `LOADED_MEDIA` before ever handing one out.

## 4b. `sheet` is download-only

The `sheet` preset is an Avery 5160 30-up **Letter page for a laser printer** — feeding it to a 4-inch thermal roll printer is meaningless. So:

- `LOADED_MEDIA` has no `sheet` value.
- `POST /api/print/_y_/jobs` **rejects `preset: 'sheet'`** with a clear message ("Avery sheets are for a laser printer — use Download PDF").
- The client hides "Send to printer" when `sheet` is selected, leaving Download.

Phase 1's four presets therefore split cleanly: three are printable, one is downloadable.

## 4a. Status transitions

```
             preset == LOADED_MEDIA          claim              ack ok
  (new) ──────────────────────────────► queued ──────► claimed ─────────► done
    │                                     ▲               │
    │ preset != LOADED_MEDIA              │               │ ack fail / stale sweep
    └──────────────────────────► held ────┘               │  ATTEMPTS+1
                          (roll changed)                  ├─ < 3 → queued
                                                          └─ = 3 → failed
  any non-terminal ──(user)──► canceled          failed ──(user retry)──► queued
```

## 5. API

Route prefixes follow tally convention (`_x_` GET, `_y_` POST, `_u_` PUT, `_p_` PATCH, `_d_` DELETE). All responses use the standard `{success, data, message}` envelope except the PDF endpoint.

### User endpoints (session auth, membership-scoped)

| Route | Purpose |
|---|---|
| `POST /api/print/_y_/jobs` | Queue `{entityType, entityIds, preset}`. Returns the job with its resolved status (`queued` or `held`). |
| `GET /api/print/_x_/jobs` | Queue for a property (paginated, newest first). |
| `PATCH /api/print/_p_/jobs/:id/cancel` | Cancel a non-terminal job. |
| `POST /api/print/_y_/jobs/:id/retry` | Requeue a `failed` job (resets `ATTEMPTS`). |
| `POST /api/print/_y_/agents` | Register a printer. **Returns the plaintext token exactly once.** |
| `GET /api/print/_x_/agents` | List agents — never returns tokens or hashes. |
| `DELETE /api/print/_d_/agents/:id` | Revoke. |
| `PUT /api/print/_u_/agents/:id/loaded-media` | Set the loaded roll; releases matching held jobs. |

### Agent endpoints (Bearer token; no session, no CSRF)

| Route | Purpose |
|---|---|
| `POST /api/print/_y_/agent/claim` | Atomically claim the next printable job. Body carries printer telemetry (§5a). Also sweeps stale claims and updates `LAST_SEEN_AT`, `PRINTER_STATE`, `PRINTER_STATE_REASONS`. Returns `204` when idle. |
| `GET /api/print/_x_/agent/jobs/:id/pdf` | The rendered PDF. Only for a job this agent currently holds. |
| `POST /api/print/_y_/agent/jobs/:id/ack` | `{ok: true}` or `{ok: false, error}`. |

**Atomic claim** (no job can be handed out twice). Every bound parameter is **derived server-side from the authenticated agent row** — the agent never chooses its property or which preset to pull:
```sql
-- PROPERTY_ID and PRESET both come from the agent record resolved by the token,
-- never from the request body.
UPDATE TALLY.print_jobs
   SET STATUS='claimed', CLAIM_ID=?, CLAIMED_BY=?, CLAIMED_AT=NOW()
 WHERE PROPERTY_ID=? AND STATUS='queued' AND PRESET=?   -- = agent.PROPERTY_ID, agent.LOADED_MEDIA
 ORDER BY CREATED_AT LIMIT 1;
-- then SELECT the row back by CLAIM_ID
```

**Stale claims self-heal.** If the Pi dies mid-job the row would sit in `claimed` forever, so each claim request first returns claims older than 5 minutes to `queued`, incrementing `ATTEMPTS`. A lazy sweep — no cron, no scheduler.

**Delivery is at-least-once.** Ack is the commit point, so an agent that prints and then dies before acking will reprint. A duplicate sticker is strictly better than a silently missing label. Documented, not accidental.

## 5a. Telemetry

Printer status rides the **existing claim request** — no new endpoint, no heartbeat, no extra traffic:

```
POST /api/print/_y_/agent/claim
{ "printerState": "idle" | "printing" | "stopped" | "unknown",
  "printerStateReasons": ["media-empty"] }
→ 200 <job>  |  204 (idle)
```

tally stores both on `printer_agents` and surfaces them in the UI. The value is that the most common real failure is not a crashed agent but **out of labels** (or cover open, or printer unplugged) — without this, those appear only as mysteriously failing jobs. With it, the print dialog can say *"Printer: out of labels"* and disable Send with a reason rather than queueing into a void.

Each backend supplies `status()` in its own way: **A** reads CUPS `printer-state` / `printer-state-reasons` (standard IPP); **B** issues the TSPL status query, whose response byte carries paper-out and cover-open bits. Reasons are normalised to IPP keyword strings (`media-empty`, `cover-open`, `media-jam`, `offline`) so the UI has one vocabulary regardless of backend. If a backend cannot determine state, it reports `unknown` — never a guess.

Deliberately excluded: CPU/temperature/disk/uptime metrics, print counters, agent-version reporting, and any metrics endpoint. If the agent stops polling, `LAST_SEEN_AT` already says so; the rest is monitoring nobody would read for a device whose only job is printing stickers.

## 6. Security

- Token is `crypto.randomBytes(32).toString('hex')` with a `tp_` prefix, displayed **once** at creation and stored only as a **SHA-256 hash**. This deliberately differs from `share_links`, which stores plaintext — acceptable for a 7-day link, not for a long-lived credential that prints on the user's behalf.
- Agent auth is a distinct middleware from session auth: constant-time hash comparison, no cookie, no CSRF (there is no browser and no ambient authority).
- **The agent's entire authority is:** claim a job in its own property, fetch that job's PDF, ack it. It cannot enumerate or read entities, list other properties, or touch any other route. The **privacy invariant holds by construction** — the agent has no entity-reading surface at all.
- The PDF endpoint verifies the job belongs to the agent's property *and* is currently claimed by that agent.
- Revoking an agent deletes the row; its token stops working on the next request.
- The token appears only in `/boot/firmware/tally-printer.conf` on the SD card and in the agent's env file — never in the published image, never in git.

## 7. The agent & the appliance image

**New repo: `tally-printer`.** Its CI produces `.img.xz` releases via a heavy ARM/QEMU job — a completely different artifact lifecycle from tally's deploy, and keeping it out of tally avoids the `build.yml` / `app.yml` tarball-include rules that CLAUDE.md flags as breakage-prone.

```
tally-printer/
  agent/
    main.py            poll loop: claim → fetch → print → ack
    config.py          reads /etc/tally-printer/agent.env
    backends/
      cups.py          Backend A
      tspl.py          Backend B (vendored pdf2tspl, extended for multi-page)
  image/               pi-gen custom stage
  systemd/             tally-print-agent.service (Restart=always)
```

**Language: Python 3** — ships with Pi OS, no build step on-device, and Backend B's toolchain is already Python. Dependencies: `requests` + stdlib.

**Polling:** every **2 seconds** with jitter; **re-poll immediately after a successful job** so a batch drains at print speed rather than one label per interval; exponential backoff to 60s **on errors only** (never on idle — predictable latency beats adaptive cleverness). Tap-to-label is ~3–4s worst case. Long-polling is a drop-in upgrade to the same endpoint if sub-second is ever wanted; explicitly not built now.

**Hard requirements carried from §1:** re-send `SIZE`+`GAP` every job; write the payload as a **single burst, not streamed** (these firmwares drop data arriving mid-print); always `print-scaling=none`, never `fit-to-page`.

**Image:** `pi-gen` custom stage, built in GitHub Actions under binfmt, publishing `.img.xz` releases. Base **Raspberry Pi OS Lite 64-bit** (arm64 is mandatory — see §1). Baked in: `cups`, `libcupsimage2` (its absence is a known "filter failed" cause), `poppler-utils`, the chosen backend, the agent, and its systemd unit.

**First boot** reads `/boot/firmware/tally-printer.conf` — the file edited before flashing:
```ini
wifi_ssid     = ...
wifi_password = ...
tally_url     = https://tally.example
agent_token   = tp_a1b2c3...
ssh_pubkey    = ssh-ed25519 AAAA...   # optional, for debugging
```
There is deliberately **no roll setting here** — tally owns that (§4), so it can never drift out of sync with the server that filters the jobs.
It configures WiFi, writes the agent env, creates the CUPS queue, enables the service, and marks itself provisioned so it never re-runs. Secrets exist only in that file.

## 8. Cycle 1 — bring-up (do this first)

The image can only bake a print path that is known to work, and iterating by re-flashing an SD card is far slower than iterating over SSH. So the first cycle proves the path by hand on a throwaway card; **the exact commands that work become the image's build recipe.** It also closes Phase 1's deferred print-and-measure check.

De-risking order — at each failure, jump to Backend B rather than fighting the driver:

1. `uname -m` → must be `aarch64`. Reimage to 64-bit Pi OS Lite if not.
2. `lsusb` → confirm the VID:PID (expect `09c6:0426`; **verify, don't assume** — `0416:5011` circulates in tutorials but belongs to an unrelated 58 mm receipt printer).
3. `sudo apt install -y cups libcupsimage2` and add the user to `lpadmin`.
4. Install the [Rollo arm64 driver](https://www.rollo.com/driver-linux/). If the `.deb` refuses to install (Trixie renamed `libcups2` → `libcups2t64` for the 64-bit `time_t` transition), build [nelullc/rollo-cups-driver](https://github.com/nelullc/rollo-cups-driver) from source instead — which also removes the arch constraint.
5. `lpinfo -v` / `lpinfo -m`, then `lpadmin -p labels -E -v usb://... -m <ppd>`.
6. Print a real Phase 1 4×6 manifest PDF.
7. `lpoptions -p labels -l` → does `PageSize` list `Custom`? If not, add the custom-page-size stanza to `/etc/cups/ppd/labels.ppd` (including `*HWMargins: 0 0 0 0`, the standard fix for unwanted white borders — these print edge-to-edge).
8. Print 2×1 and 3×3, recalibrating on each roll change.
9. **Measure the output** against the mockups; record any offset correction (the Manjaro user needed +6 mm horizontal, −1 mm vertical — cross-brand PPDs are compatible, not identical).

**Recorded output of Cycle 1:** which backend won, the exact install/config commands, the calibration procedure, the per-size `lp` invocation, and any offset corrections. That document *is* the input to the image build.

## 9. Client

- **Print dialog** (Phase 1's, already has the preset selector) gains **"Send to printer"** beside "Download PDF", shown only when the property has a registered printer, and carrying state inline:
  - online + roll matches → `Send to printer` → toast "Printing 1 label"
  - online + roll differs → `Queue for 3×3 roll`, note "4×6 is loaded" → toast "Queued — will print when you load the 3×3 roll"
  - **printer reports a problem** (§5a) → disabled, stating the reason in plain words: "Printer: out of labels" / "cover open" / "jammed". This is the difference between a fixable message and a job that vanishes.
  - offline → disabled, "Printer last seen 2 hours ago"
  - Download always remains available — the escape hatch when the Pi is down.
- **Settings → Printing:** the printer (name, online state, **current printer status** from §5a, **loaded roll** dropdown that releases held jobs), **Add printer** (shows the token once with a copy button and the exact `tally-printer.conf` snippet), and the **queue** (held jobs grouped by the roll they await; failed jobs showing `LAST_ERROR` with Retry).
- No `/labels` page is introduced — CLAUDE.md is explicit that none exists.

## 10. Testing

- **Server (fakeDb + node:test):** claim is atomic and never double-hands a job; the stale sweep requeues claims older than 5 min and increments `ATTEMPTS`; 3 failures → `failed`; preset≠`LOADED_MEDIA` → `held`; changing `LOADED_MEDIA` releases exactly the matching held jobs; token auth accepts a valid hash and rejects a bad/revoked one; **the agent cannot fetch a PDF for a job it does not hold, or one in another property** (the IDOR guard); every query is property-scoped; telemetry from the claim body is persisted and a malformed/absent payload degrades to `unknown` rather than erroring the claim; **`preset: 'sheet'` is rejected at queue time** (§4b); **a claim ignores any property/preset supplied in the request body and uses only the agent record** (an agent must not be able to pull another property's jobs or a preset that isn't loaded).
- **Agent (pytest):** poll loop claims→fetches→prints→acks; ack-failure path increments attempts; backoff on errors; immediate re-poll after success; the backend seam is exercised with a fake backend; `SIZE`/`GAP` emitted per job in Backend B; `status()` maps backend-native state to the normalised IPP vocabulary and returns `unknown` rather than guessing when state is unavailable.
- **Image:** CI builds the `.img.xz`; a boot smoke test is out of scope for CI (needs hardware) and is a manual check.
- **End-to-end:** queue a job from tally → label emerges from the ITPP941. Verified by hand once the Pi exists.

## 11. Non-goals

- Multiple printers per property (schema permits it; UI assumes one).
- Automatic roll detection (the hardware cannot report it).
- Long-polling / websockets (2s polling is sufficient; noted as a future upgrade).
- Printing from outside tally (no generic print API).
- OTA agent updates — re-flash or `git pull` + restart. Revisit if it becomes annoying.
- **Remote printer commands** (calibrate / test-print from the UI). Considered and declined for now: roll calibration stays a physical button-hold documented in the runbook. Revisit if roll-swapping proves annoying in practice.
- **Agent-version reporting and any metrics/monitoring surface** beyond §5a.
- Any Phase 1 label geometry change.
